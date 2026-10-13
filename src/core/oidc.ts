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

/**
 * Default scope requested at login. `offline_access` is deliberately not
 * included: IdPs like Keycloak reject it unless the user and client are
 * granted offline tokens, and most still issue a session-bound refresh
 * token without it. Profiles can opt in via `--scope`.
 */
export const DEFAULT_OIDC_SCOPE = "openid";

/** Refresh the access token when it has less than this long left. */
const EXPIRY_SKEW_MS = 60_000;

/**
 * Public client ID used when neither the profile nor the cluster's
 * `/.well-known/camunda-auth` discovery names one.
 */
export const DEFAULT_OIDC_CLIENT_ID = "c8ctl";

/** The subset of a cluster config that identifies an OIDC login. */
export interface OidcSettings {
	baseUrl: string;
	/** Explicit issuer override; discovered from the cluster when unset. */
	issuer?: string;
	/** Explicit client ID override; discovered from the cluster when unset. */
	clientId?: string;
	audience?: string;
	/** Explicit scope override; discovered from the cluster when unset. */
	scope?: string;
}

/** Login parameters after applying discovery and defaults. */
export interface ResolvedLogin {
	issuer: string;
	clientId: string;
	scope: string;
	audience?: string;
	/** Where the values came from, for user feedback. */
	source: "camunda-auth" | "rfc9728" | "profile";
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
	issuer?: string;
	/** The client the tokens were issued to; needed for refresh/revocation. */
	clientId?: string;
	tokenEndpoint: string;
	revocationEndpoint?: string;
}

/**
 * The OIDC settings `c8ctl login` would use for a cluster config, or
 * `undefined` when the config carries other credentials (client
 * credentials or Basic auth), which always win.
 */
export function getLoginSettings(
	config: ClusterConfig,
): OidcSettings | undefined {
	if (config.clientSecret || (config.username && config.password)) {
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
 * The OIDC settings to authenticate requests with, or `undefined` when the
 * config is not using a login session. A config is login-based when it
 * names an issuer explicitly or when `c8ctl login` stored tokens for it — so
 * a profile holding just a base URL keeps working unauthenticated until the
 * user logs in.
 */
export function getOidcSettings(
	config: ClusterConfig,
): OidcSettings | undefined {
	const settings = getLoginSettings(config);
	if (!settings) return undefined;
	if (settings.issuer || loadOidcTokens(settings)) return settings;
	return undefined;
}

/**
 * Token store key. Keyed by what the token is valid for rather than by
 * profile name, so env-var configs work and renaming a profile is harmless.
 * Built from the *configured* values only — discovered ones (issuer,
 * client ID) are stored inside the token set — so commands can find the
 * session without repeating discovery.
 */
function tokenKey(s: OidcSettings): string {
	return [s.clientId ?? "", s.audience ?? "", s.baseUrl].join("|");
}

/** The client ID to use for refresh/revocation of a stored token set. */
function tokenClientId(settings: OidcSettings, tokens: OidcTokenSet): string {
	return tokens.clientId ?? settings.clientId ?? DEFAULT_OIDC_CLIENT_ID;
}

// ─── Protocol ────────────────────────────────────────────────────────────────

/** A provider entry from the cluster's `/.well-known/camunda-auth`. */
interface CamundaAuthProvider {
	issuer: string;
	clientId?: string;
	scopes?: string[];
}

function stringArray(value: unknown): string[] | undefined {
	return Array.isArray(value) &&
		value.every((v): v is string => typeof v === "string")
		? value
		: undefined;
}

/**
 * Read the Orchestration Cluster's login discovery document
 * (`<origin>/.well-known/camunda-auth`). Returns `undefined` when the
 * cluster does not serve it (older versions), so callers can fall back to
 * RFC 9728. When several providers are listed, the one matching
 * `preferredIssuer` wins, else the first.
 *
 * Format (version 1):
 * `{"version":1,"method":"oidc","providers":[{"id","issuer","client_id",
 * "scopes":[…],"audience":[…]}]}`
 */
export async function discoverCamundaAuth(
	baseUrl: string,
	preferredIssuer?: string,
): Promise<CamundaAuthProvider | undefined> {
	const url = `${new URL(baseUrl).origin}/.well-known/camunda-auth`;
	const res = await fetch(url, { headers: { Accept: "application/json" } });
	if (!res.ok) return undefined;
	const doc: unknown = await res.json().catch(() => undefined);
	if (!isRecord(doc) || doc.version !== 1) return undefined;

	if (doc.method !== "oidc") {
		throw new Error(
			`The cluster at ${baseUrl} uses '${String(doc.method)}' authentication; ` +
				"'c8ctl login' only applies to OIDC. Configure credentials on the " +
				"profile instead (c8ctl add profile --help).",
		);
	}
	const providers = Array.isArray(doc.providers)
		? doc.providers.filter(
				(p): p is Record<string, unknown> =>
					isRecord(p) && typeof p.issuer === "string",
			)
		: [];
	const provider =
		providers.find((p) => p.issuer === preferredIssuer) ?? providers[0];
	if (!provider || typeof provider.issuer !== "string") {
		throw new Error(`${url} lists no OIDC provider`);
	}
	return {
		issuer: provider.issuer,
		clientId:
			typeof provider.client_id === "string" ? provider.client_id : undefined,
		scopes: stringArray(provider.scopes),
	};
}

/**
 * Work out the login parameters. Explicit values (flag, profile, env) win
 * over discovery; `/.well-known/camunda-auth` wins over RFC 9728 (which
 * only yields the issuer); built-in defaults fill the rest.
 */
export async function resolveLogin(
	settings: OidcSettings,
): Promise<ResolvedLogin> {
	const discovered = await discoverCamundaAuth(
		settings.baseUrl,
		settings.issuer,
	);
	if (discovered) {
		return {
			issuer: settings.issuer ?? discovered.issuer,
			clientId:
				settings.clientId ?? discovered.clientId ?? DEFAULT_OIDC_CLIENT_ID,
			scope:
				settings.scope ??
				(discovered.scopes?.length
					? discovered.scopes.join(" ")
					: DEFAULT_OIDC_SCOPE),
			audience: settings.audience,
			source: "camunda-auth",
		};
	}
	return {
		issuer: settings.issuer ?? (await discoverIssuer(settings.baseUrl)),
		clientId: settings.clientId ?? DEFAULT_OIDC_CLIENT_ID,
		scope: settings.scope ?? DEFAULT_OIDC_SCOPE,
		audience: settings.audience,
		source: settings.issuer ? "profile" : "rfc9728",
	};
}

/**
 * RFC 9728 §3.1: the metadata URL is formed by inserting the well-known
 * suffix between the host and the path of the resource identifier.
 */
function protectedResourceMetadataUrls(baseUrl: string): string[] {
	const url = new URL(baseUrl);
	const path = url.pathname.replace(/\/+$/, "");
	const urls = [`${url.origin}/.well-known/oauth-protected-resource${path}`];
	if (path) urls.push(`${url.origin}/.well-known/oauth-protected-resource`);
	return urls;
}

/** Parse `resource_metadata` from a `WWW-Authenticate: Bearer` challenge. */
function resourceMetadataFromChallenge(header: string | null): string | null {
	return header?.match(/resource_metadata="([^"]+)"/i)?.[1] ?? null;
}

async function fetchProtectedResourceMetadata(
	url: string,
): Promise<Record<string, unknown> | undefined> {
	const res = await fetch(url, { headers: { Accept: "application/json" } });
	if (!res.ok) return undefined;
	const body: unknown = await res.json().catch(() => undefined);
	return isRecord(body) ? body : undefined;
}

/**
 * Discover the cluster's authorization server (issuer) via RFC 9728
 * protected resource metadata. Tries the well-known URL derived from the
 * base URL, then the `resource_metadata` hint in the 401 challenge of an
 * unauthenticated API call.
 *
 * The metadata's `resource` must be on the same origin as the base URL
 * (RFC 9728 §3.3), so a misbehaving proxy cannot point c8ctl at an
 * unrelated authorization server.
 */
export async function discoverIssuer(baseUrl: string): Promise<string> {
	const origin = new URL(baseUrl).origin;
	const candidates = protectedResourceMetadataUrls(baseUrl);

	let metadata: Record<string, unknown> | undefined;
	for (const url of candidates) {
		metadata = await fetchProtectedResourceMetadata(url);
		if (metadata) break;
	}
	if (!metadata) {
		const probe = await fetch(`${baseUrl.replace(/\/+$/, "")}/topology`).catch(
			() => undefined,
		);
		const hinted = resourceMetadataFromChallenge(
			probe?.headers.get("www-authenticate") ?? null,
		);
		if (hinted && new URL(hinted).origin === origin) {
			metadata = await fetchProtectedResourceMetadata(hinted);
		}
	}
	if (!metadata) {
		throw new Error(
			`Could not discover the identity provider for ${baseUrl}: the cluster ` +
				"does not publish OAuth protected resource metadata (RFC 9728). " +
				"Set the issuer explicitly with --oidcIssuer on the profile.",
		);
	}

	if (
		typeof metadata.resource !== "string" ||
		!URL.canParse(metadata.resource) ||
		new URL(metadata.resource).origin !== origin
	) {
		throw new Error(
			`Protected resource metadata for ${baseUrl} names a different resource (${String(metadata.resource)})`,
		);
	}
	const servers = metadata.authorization_servers;
	const issuer = Array.isArray(servers)
		? servers.find((s): s is string => typeof s === "string")
		: undefined;
	if (!issuer) {
		throw new Error(
			`Protected resource metadata for ${baseUrl} lists no authorization server`,
		);
	}
	return issuer;
}

/**
 * Authorization server metadata: OIDC discovery first, then RFC 8414
 * (`oauth-authorization-server`, with the issuer path appended).
 */
export async function discoverOidc(issuer: string): Promise<OidcEndpoints> {
	const trimmed = issuer.replace(/\/+$/, "");
	const { origin, pathname } = new URL(trimmed);
	const urls = [
		`${trimmed}/.well-known/openid-configuration`,
		`${origin}/.well-known/oauth-authorization-server${pathname.replace(/\/+$/, "")}`,
	];
	for (const url of urls) {
		const res = await fetch(url, { headers: { Accept: "application/json" } });
		if (!res.ok) continue;
		const doc: unknown = await res.json().catch(() => undefined);
		if (
			isRecord(doc) &&
			typeof doc.authorization_endpoint === "string" &&
			typeof doc.token_endpoint === "string"
		) {
			return {
				authorizationEndpoint: doc.authorization_endpoint,
				tokenEndpoint: doc.token_endpoint,
				revocationEndpoint:
					typeof doc.revocation_endpoint === "string"
						? doc.revocation_endpoint
						: undefined,
			};
		}
	}
	throw new Error(
		`Could not load authorization server metadata for issuer ${issuer}`,
	);
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
	login: ResolvedLogin;
	redirectUri: string;
	challenge: string;
	state: string;
}): string {
	const url = new URL(opts.endpoints.authorizationEndpoint);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("client_id", opts.login.clientId);
	url.searchParams.set("redirect_uri", opts.redirectUri);
	url.searchParams.set("scope", opts.login.scope);
	url.searchParams.set("state", opts.state);
	url.searchParams.set("code_challenge", opts.challenge);
	url.searchParams.set("code_challenge_method", "S256");
	// Some IdPs (Auth0, Okta custom servers) select the API by an `audience`
	// parameter; others (Keycloak, Entra) ignore it.
	if (opts.login.audience) {
		url.searchParams.set("audience", opts.login.audience);
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

export async function exchangeAuthorizationCode(opts: {
	endpoints: OidcEndpoints;
	login: ResolvedLogin;
	code: string;
	verifier: string;
	redirectUri: string;
}): Promise<OidcTokenSet> {
	const tokens = await requestTokens(opts.endpoints, {
		grant_type: "authorization_code",
		code: opts.code,
		code_verifier: opts.verifier,
		redirect_uri: opts.redirectUri,
		client_id: opts.login.clientId,
	});
	return {
		...tokens,
		issuer: opts.login.issuer,
		clientId: opts.login.clientId,
	};
}

function refreshTokenSet(
	settings: OidcSettings,
	tokens: OidcTokenSet,
): Promise<OidcTokenSet> {
	if (!tokens.refreshToken) {
		throw new Error("no refresh token");
	}
	const clientId = tokenClientId(settings, tokens);
	return requestTokens(
		tokens,
		{
			grant_type: "refresh_token",
			refresh_token: tokens.refreshToken,
			client_id: clientId,
		},
		tokens.refreshToken,
	).then((next) => ({ ...next, issuer: tokens.issuer, clientId }));
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
				client_id: tokenClientId(settings, tokens),
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
						issuer: typeof value.issuer === "string" ? value.issuer : undefined,
						clientId:
							typeof value.clientId === "string" ? value.clientId : undefined,
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
