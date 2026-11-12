/**
 * Auth0 device-code login and refresh for the saas plugin
 * (mirrors ccmacli `src/auth.rs`).
 */

import { decodeJwtPayload, isRecord } from "./jwt.ts";
import type { Stage } from "./stages.ts";
import {
	deleteToken,
	needsRefresh,
	readToken,
	type StoredToken,
	withLock,
	writeToken,
} from "./tokens.ts";

export type FetchFn = typeof fetch;

/** Kept well below LOCK_DEFAULTS.staleMs, see tokens.ts. */
export const AUTH0_TIMEOUT_MS = 10_000;

export interface AuthCfg {
	auth0Domain: string;
	audience: string;
	clientId: string;
}

export interface DeviceCode {
	device_code: string;
	user_code: string;
	verification_uri_complete: string;
	expires_in: number;
	interval: number;
}

export interface TokenResponse {
	access_token: string;
	refresh_token?: string;
	id_token?: string;
	expires_in: number;
}

export class NotLoggedInError extends Error {
	constructor(stage: Stage) {
		super(
			`Not logged in to SaaS (${stage}). Run: c8ctl saas login --stage ${stage}`,
		);
		this.name = "NotLoggedInError";
	}
}

export class InvalidGrantError extends Error {
	constructor() {
		super("Refresh token is no longer valid");
		this.name = "InvalidGrantError";
	}
}

type Auth0Result =
	| { ok: true; body: Record<string, unknown> }
	| { ok: false; error: string; description: string };

async function postForm(
	cfg: AuthCfg,
	path: string,
	form: Record<string, string>,
	fetchFn: FetchFn,
): Promise<Auth0Result> {
	const res = await fetchFn(`https://${cfg.auth0Domain}${path}`, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(form).toString(),
		redirect: "manual",
		signal: AbortSignal.timeout(AUTH0_TIMEOUT_MS),
	});
	let body: unknown;
	try {
		body = await res.json();
	} catch {
		body = undefined;
	}
	if (res.ok && isRecord(body)) return { ok: true, body };
	const error =
		isRecord(body) && typeof body.error === "string"
			? body.error
			: `http_${res.status}`;
	const description =
		isRecord(body) && typeof body.error_description === "string"
			? body.error_description
			: error;
	return { ok: false, error, description };
}

function asTokenResponse(body: Record<string, unknown>): TokenResponse {
	if (
		typeof body.access_token !== "string" ||
		typeof body.expires_in !== "number"
	)
		throw new Error("Auth0 sent an incomplete token response");
	return {
		access_token: body.access_token,
		expires_in: body.expires_in,
		...(typeof body.refresh_token === "string" && {
			refresh_token: body.refresh_token,
		}),
		...(typeof body.id_token === "string" && { id_token: body.id_token }),
	};
}

export async function requestDeviceCode(
	cfg: AuthCfg,
	fetchFn: FetchFn = fetch,
): Promise<DeviceCode> {
	const result = await postForm(
		cfg,
		"/oauth/device/code",
		{
			client_id: cfg.clientId,
			audience: cfg.audience,
			scope: "openid email offline_access",
		},
		fetchFn,
	);
	if (!result.ok)
		throw new Error(`Auth0 device code request failed: ${result.description}`);
	const b = result.body;
	if (
		typeof b.device_code !== "string" ||
		typeof b.user_code !== "string" ||
		typeof b.verification_uri_complete !== "string"
	)
		throw new Error("Auth0 sent an incomplete device code response");
	return {
		device_code: b.device_code,
		user_code: b.user_code,
		verification_uri_complete: b.verification_uri_complete,
		expires_in: typeof b.expires_in === "number" ? b.expires_in : 900,
		interval: typeof b.interval === "number" ? b.interval : 5,
	};
}

export async function pollForToken(
	cfg: AuthCfg,
	dc: DeviceCode,
	deps: { fetchFn?: FetchFn; sleep?: (ms: number) => Promise<void> } = {},
): Promise<TokenResponse> {
	const fetchFn = deps.fetchFn ?? fetch;
	const sleep =
		deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
	let interval = dc.interval;
	for (;;) {
		const result = await postForm(
			cfg,
			"/oauth/token",
			{
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				device_code: dc.device_code,
				client_id: cfg.clientId,
			},
			fetchFn,
		);
		if (result.ok) return asTokenResponse(result.body);
		if (result.error === "slow_down") interval += 5;
		else if (result.error === "expired_token")
			throw new Error("Login code expired. Run c8ctl saas login again.");
		else if (result.error === "access_denied")
			throw new Error("Login was denied in the browser.");
		else if (result.error !== "authorization_pending")
			throw new Error(`Auth0 login failed: ${result.description}`);
		await sleep(interval * 1000);
	}
}

export async function refreshTokens(
	cfg: AuthCfg,
	refreshToken: string,
	fetchFn: FetchFn = fetch,
): Promise<TokenResponse> {
	const result = await postForm(
		cfg,
		"/oauth/token",
		{
			grant_type: "refresh_token",
			refresh_token: refreshToken,
			client_id: cfg.clientId,
		},
		fetchFn,
	);
	if (result.ok) return asTokenResponse(result.body);
	if (result.error === "invalid_grant") throw new InvalidGrantError();
	throw new Error(`Auth0 token refresh failed: ${result.description}`);
}

function identity(token: string | undefined): { sub?: string; email?: string } {
	if (!token) return {};
	try {
		const p = decodeJwtPayload(token);
		return {
			...(typeof p.sub === "string" && { sub: p.sub }),
			...(typeof p.email === "string" && { email: p.email }),
		};
	} catch {
		return {};
	}
}

export function toStored(
	resp: TokenResponse,
	nowSec: number,
	prev?: StoredToken,
): StoredToken {
	const refresh_token = resp.refresh_token ?? prev?.refresh_token;
	if (!refresh_token)
		throw new Error("Auth0 sent no refresh token (is offline_access allowed?)");
	const fromId = identity(resp.id_token);
	const fromAccess = identity(resp.access_token);
	const email = fromId.email ?? fromAccess.email ?? prev?.email;
	return {
		access_token: resp.access_token,
		refresh_token,
		expires_at: nowSec + resp.expires_in,
		sub: fromId.sub ?? fromAccess.sub ?? prev?.sub ?? "",
		...(email && { email }),
	};
}

export async function getAccessToken(
	dir: string,
	stage: Stage,
	cfg: AuthCfg,
	deps: { fetchFn?: FetchFn; now?: () => number } = {},
): Promise<string> {
	const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
	const token = readToken(dir, stage);
	if (!token) throw new NotLoggedInError(stage);
	if (!needsRefresh(token, now())) return token.access_token;
	return withLock(dir, stage, async () => {
		// Re-read under the lock: another process may have refreshed already.
		const current = readToken(dir, stage);
		if (!current) throw new NotLoggedInError(stage);
		if (!needsRefresh(current, now())) return current.access_token;
		let resp: TokenResponse;
		try {
			resp = await refreshTokens(cfg, current.refresh_token, deps.fetchFn);
		} catch (error) {
			if (error instanceof InvalidGrantError) {
				deleteToken(dir, stage);
				throw new NotLoggedInError(stage);
			}
			throw error;
		}
		const next = toStored(resp, now(), current);
		writeToken(dir, stage, next);
		return next.access_token;
	});
}
