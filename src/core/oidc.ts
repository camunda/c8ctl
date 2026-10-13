/**
 * OIDC support for interactive `c8ctl login` (RFC 8252: authorization code
 * + PKCE over a loopback redirect).
 *
 * Holds the protocol pieces (discovery, PKCE, code exchange, refresh) and
 * the token store (`DATA_DIR/c8ctl/tokens.json`, mode 0600). Lives in core
 * because `createClient` needs to resolve — and refresh — the bearer token
 * for every request made under a login-based profile.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	existsSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type ClusterConfig, ensureUserDataDir } from "./config.ts";
import { isRecord } from "./logger.ts";

/** Default scopes requested at login: OIDC identity plus a refresh token. */
export const DEFAULT_OIDC_SCOPE = "openid offline_access";

/** Refresh the access token when it has less than this long left. */
const EXPIRY_SKEW_MS = 60_000;

/** The subset of a cluster config that identifies an OIDC login. */
export interface OidcSettings {
	baseUrl: string;
	issuer: string;
	clientId: string;
	audience?: string;
	scope?: string;
}

export interface OidcEndpoints {
	authorizationEndpoint: string;
	tokenEndpoint: string;
	revocationEndpoint?: string;
}

/** A persisted token set. `expiresAt` is epoch milliseconds. */
export interface OidcTokenSet {
	accessToken: string;
	refreshToken?: string;
	idToken?: string;
	expiresAt?: number;
	tokenEndpoint: string;
	revocationEndpoint?: string;
}

/**
 * The OIDC settings for a cluster config, or `undefined` when the config is
 * not login-based. A `clientSecret` means client credentials, which wins.
 */
export function getOidcSettings(
	config: ClusterConfig,
): OidcSettings | undefined {
	if (!config.oidcIssuer || !config.clientId || config.clientSecret) {
		return undefined;
	}
	return {
		baseUrl: config.baseUrl,
		issuer: config.oidcIssuer,
		clientId: config.clientId,
		audience: config.audience,
		scope: config.scope,
	};
}

/**
 * Token store key. Keyed by what the token is valid for rather than by
 * profile name, so env-var configs work and renaming a profile is harmless.
 */
function tokenKey(s: OidcSettings): string {
	return [s.issuer, s.clientId, s.audience ?? "", s.baseUrl].join("|");
}

// ─── Protocol ────────────────────────────────────────────────────────────────

export async function discoverOidc(issuer: string): Promise<OidcEndpoints> {
	const url = `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
	const res = await fetch(url);
	if (!res.ok) {
		throw new Error(
			`OIDC discovery failed: ${res.status} ${res.statusText} (${url})`,
		);
	}
	const doc: unknown = await res.json();
	if (
		!isRecord(doc) ||
		typeof doc.authorization_endpoint !== "string" ||
		typeof doc.token_endpoint !== "string"
	) {
		throw new Error(`OIDC discovery document at ${url} is incomplete`);
	}
	return {
		authorizationEndpoint: doc.authorization_endpoint,
		tokenEndpoint: doc.token_endpoint,
		revocationEndpoint:
			typeof doc.revocation_endpoint === "string"
				? doc.revocation_endpoint
				: undefined,
	};
}

/** RFC 7636 code verifier and its S256 challenge. */
export function createPkcePair(): { verifier: string; challenge: string } {
	const verifier = randomBytes(32).toString("base64url");
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	return { verifier, challenge };
}

export function createState(): string {
	return randomBytes(16).toString("base64url");
}

export function buildAuthorizationUrl(opts: {
	endpoints: OidcEndpoints;
	settings: OidcSettings;
	redirectUri: string;
	challenge: string;
	state: string;
}): string {
	const url = new URL(opts.endpoints.authorizationEndpoint);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("client_id", opts.settings.clientId);
	url.searchParams.set("redirect_uri", opts.redirectUri);
	url.searchParams.set("scope", opts.settings.scope || DEFAULT_OIDC_SCOPE);
	url.searchParams.set("state", opts.state);
	url.searchParams.set("code_challenge", opts.challenge);
	url.searchParams.set("code_challenge_method", "S256");
	// Some IdPs (Auth0, Okta custom servers) select the API by an `audience`
	// parameter; others (Keycloak, Entra) ignore it.
	if (opts.settings.audience) {
		url.searchParams.set("audience", opts.settings.audience);
	}
	return url.toString();
}

async function requestTokens(
	endpoints: Pick<OidcEndpoints, "tokenEndpoint" | "revocationEndpoint">,
	params: Record<string, string>,
	previousRefreshToken?: string,
): Promise<OidcTokenSet> {
	const res = await fetch(endpoints.tokenEndpoint, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Accept: "application/json",
		},
		body: new URLSearchParams(params),
	});
	const body: unknown = await res.json().catch(() => undefined);
	if (!res.ok || !isRecord(body) || typeof body.access_token !== "string") {
		const detail =
			isRecord(body) && typeof body.error === "string"
				? `${body.error}${typeof body.error_description === "string" ? `: ${body.error_description}` : ""}`
				: `${res.status} ${res.statusText}`;
		throw new Error(`OIDC token request failed (${detail})`);
	}
	const expiresAt =
		typeof body.expires_in === "number"
			? Date.now() + body.expires_in * 1000
			: jwtExpiry(body.access_token);
	return {
		accessToken: body.access_token,
		// Refresh responses may omit the refresh token; keep the old one then.
		refreshToken:
			typeof body.refresh_token === "string"
				? body.refresh_token
				: previousRefreshToken,
		idToken: typeof body.id_token === "string" ? body.id_token : undefined,
		expiresAt,
		tokenEndpoint: endpoints.tokenEndpoint,
		revocationEndpoint: endpoints.revocationEndpoint,
	};
}

export function exchangeAuthorizationCode(opts: {
	endpoints: OidcEndpoints;
	settings: OidcSettings;
	code: string;
	verifier: string;
	redirectUri: string;
}): Promise<OidcTokenSet> {
	return requestTokens(opts.endpoints, {
		grant_type: "authorization_code",
		code: opts.code,
		code_verifier: opts.verifier,
		redirect_uri: opts.redirectUri,
		client_id: opts.settings.clientId,
	});
}

function refreshTokenSet(
	settings: OidcSettings,
	tokens: OidcTokenSet,
): Promise<OidcTokenSet> {
	if (!tokens.refreshToken) {
		throw new Error("no refresh token");
	}
	return requestTokens(
		tokens,
		{
			grant_type: "refresh_token",
			refresh_token: tokens.refreshToken,
			client_id: settings.clientId,
		},
		tokens.refreshToken,
	);
}

/** Best-effort RFC 7009 revocation of the refresh token (or access token). */
export async function revokeTokens(
	settings: OidcSettings,
	tokens: OidcTokenSet,
): Promise<boolean> {
	if (!tokens.revocationEndpoint) return false;
	const token = tokens.refreshToken ?? tokens.accessToken;
	try {
		const res = await fetch(tokens.revocationEndpoint, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				token,
				token_type_hint: tokens.refreshToken ? "refresh_token" : "access_token",
				client_id: settings.clientId,
			}),
		});
		return res.ok;
	} catch {
		return false;
	}
}

/** Decode a JWT payload without verifying it (display/expiry only). */
export function decodeJwtClaims(
	jwt: string | undefined,
): Record<string, unknown> | undefined {
	const payload = jwt?.split(".")[1];
	if (!payload) return undefined;
	try {
		const claims: unknown = JSON.parse(
			Buffer.from(payload, "base64url").toString("utf-8"),
		);
		return isRecord(claims) ? claims : undefined;
	} catch {
		return undefined;
	}
}

function jwtExpiry(jwt: string): number | undefined {
	const exp = decodeJwtClaims(jwt)?.exp;
	return typeof exp === "number" ? exp * 1000 : undefined;
}

// ─── Token store ─────────────────────────────────────────────────────────────

interface TokensFile {
	tokens: Record<string, OidcTokenSet>;
}

function getTokensPath(): string {
	return join(ensureUserDataDir(), "tokens.json");
}

function loadTokensFile(): TokensFile {
	const path = getTokensPath();
	if (!existsSync(path)) return { tokens: {} };
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
		if (isRecord(parsed) && isRecord(parsed.tokens)) {
			const tokens: Record<string, OidcTokenSet> = {};
			for (const [key, value] of Object.entries(parsed.tokens)) {
				if (
					isRecord(value) &&
					typeof value.accessToken === "string" &&
					typeof value.tokenEndpoint === "string"
				) {
					tokens[key] = {
						accessToken: value.accessToken,
						tokenEndpoint: value.tokenEndpoint,
						refreshToken:
							typeof value.refreshToken === "string"
								? value.refreshToken
								: undefined,
						idToken:
							typeof value.idToken === "string" ? value.idToken : undefined,
						expiresAt:
							typeof value.expiresAt === "number" ? value.expiresAt : undefined,
						revocationEndpoint:
							typeof value.revocationEndpoint === "string"
								? value.revocationEndpoint
								: undefined,
					};
				}
			}
			return { tokens };
		}
	} catch {
		// Corrupt store: treat as logged out rather than failing every command.
	}
	return { tokens: {} };
}

/**
 * Atomically replace tokens.json. The file is always created 0600 — it holds
 * refresh tokens — via an exclusive, no-follow temp file plus rename.
 */
function saveTokensFile(file: TokensFile): void {
	const path = getTokensPath();
	const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
	let fd: number | undefined;
	try {
		fd = openSync(
			tmp,
			constants.O_WRONLY |
				constants.O_CREAT |
				constants.O_EXCL |
				constants.O_NOFOLLOW,
			0o600,
		);
		writeFileSync(fd, JSON.stringify(file, null, 2));
		closeSync(fd);
		fd = undefined;
		renameSync(tmp, path);
	} catch (err) {
		if (fd !== undefined) closeSync(fd);
		rmSync(tmp, { force: true });
		throw err;
	}
}

export function loadOidcTokens(
	settings: OidcSettings,
): OidcTokenSet | undefined {
	return loadTokensFile().tokens[tokenKey(settings)];
}

export function saveOidcTokens(
	settings: OidcSettings,
	tokens: OidcTokenSet,
): void {
	const file = loadTokensFile();
	file.tokens[tokenKey(settings)] = tokens;
	saveTokensFile(file);
}

/** Remove stored tokens. Returns the removed set, if there was one. */
export function deleteOidcTokens(
	settings: OidcSettings,
): OidcTokenSet | undefined {
	const file = loadTokensFile();
	const key = tokenKey(settings);
	const existing = file.tokens[key];
	if (existing) {
		delete file.tokens[key];
		saveTokensFile(file);
	}
	return existing;
}

// ─── Access token resolution ─────────────────────────────────────────────────

/** In-flight refreshes, so concurrent requests share one refresh call. */
const refreshing = new Map<string, Promise<OidcTokenSet>>();

const LOGIN_HINT = "Run 'c8ctl login' to sign in.";

/**
 * A valid access token for a login-based config, refreshing (and persisting)
 * it when it is about to expire or when `forceRefresh` is set (e.g. after a
 * 401). Throws with a login hint when there is no usable session.
 */
export async function getOidcAccessToken(
	settings: OidcSettings,
	opts: { forceRefresh?: boolean } = {},
): Promise<string> {
	const tokens = loadOidcTokens(settings);
	if (!tokens) {
		throw new Error(`Not logged in to ${settings.baseUrl}. ${LOGIN_HINT}`);
	}
	const fresh =
		tokens.expiresAt === undefined ||
		tokens.expiresAt - EXPIRY_SKEW_MS > Date.now();
	if (fresh && !opts.forceRefresh) {
		return tokens.accessToken;
	}

	const key = tokenKey(settings);
	let pending = refreshing.get(key);
	if (!pending) {
		pending = refreshTokenSet(settings, tokens)
			.then((next) => {
				saveOidcTokens(settings, next);
				return next;
			})
			.finally(() => refreshing.delete(key));
		refreshing.set(key, pending);
	}
	try {
		return (await pending).accessToken;
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		throw new Error(
			`Session for ${settings.baseUrl} expired and could not be refreshed (${reason}). ${LOGIN_HINT}`,
		);
	}
}
