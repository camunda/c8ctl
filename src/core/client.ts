/**
 * SDK client factory using resolved configuration
 */

import {
	type CamundaClient,
	type CamundaOptions,
	createCamundaClient,
} from "@camunda8/orchestration-cluster-api";
import { resolveClusterConfig, setHeaderCaseInsensitive } from "./config.ts";
import { getLogger, isRecord } from "./logger.ts";
import { c8ctl } from "./runtime.ts";

/** The fetch-compatible function type the SDK accepts via `CamundaOptions.fetch`. */
type FetchFn = NonNullable<CamundaOptions["fetch"]>;

/**
 * Normalize a base URL the same way constructing a `Request` from it would:
 * the WHATWG URL parser lowercases the host and applies its own formatting
 * (default ports, etc). `Request.url` in the fetch wrapper below always
 * reflects that normalized form — even when the SDK's own internal
 * `CAMUNDA_REST_ADDRESS` string keeps the caller's original casing — so
 * comparing against a base derived from the raw, un-parsed `baseUrl` string
 * can silently fail to match a profile whose `--baseUrl` has an
 * uppercase/mixed-case host. Falls back to a plain trim when `baseUrl`
 * isn't a parseable absolute URL; requests built from it would already be
 * failing elsewhere in that case.
 */
function normalizeBaseUrl(baseUrl: string): string {
	const trimmed = baseUrl.trim();
	try {
		return new URL(trimmed).toString().replace(/\/+$/, "");
	} catch {
		return trimmed.replace(/\/+$/, "");
	}
}

/**
 * Wrap a fetch implementation so every request made under a gateway-fronted
 * profile carries its custom headers and, when `exactBaseUrl` is set,
 * targets the profile's base URL exactly instead of the SDK's auto-suffixed
 * one.
 *
 * The SDK (`@camunda8/orchestration-cluster-api`) appends `/v2` to
 * `CAMUNDA_REST_ADDRESS` whenever it does not already end with `/v2` or
 * `/v2/`, with no config flag to disable it. The `fetch` hook receives the
 * already-built `Request` (after auth headers have been applied), so
 * rewriting its URL there — replacing the SDK-computed base with the raw
 * `baseUrl` — is the only interception point available without forking the
 * SDK. `sdkComputedBase` mirrors the SDK's own suffixing rule exactly, so
 * it always matches the prefix the SDK actually built.
 *
 * `sdkComputedBase` is derived from `strippedBase` (never a trailing
 * slash), not the raw trimmed `baseUrl`: the SDK's own internal config
 * merge strips exactly one trailing slash before building request URLs, so
 * a `baseUrl` ending in `/v2/` would otherwise leave `sdkComputedBase` one
 * character longer than the real prefix, eating the endpoint path's
 * leading `/` on rewrite (`.../v2process-instances/search`).
 */
export function buildGatewayFetch(opts: {
	baseUrl: string;
	headers?: Record<string, string>;
	exactBaseUrl?: boolean;
	delegate?: FetchFn;
}): FetchFn {
	const delegate: FetchFn =
		opts.delegate ?? ((input, init) => fetch(input, init));
	const headerEntries = Object.entries(opts.headers ?? {});

	const strippedBase = normalizeBaseUrl(opts.baseUrl);
	const sdkComputedBase = /\/v2$/i.test(strippedBase)
		? strippedBase
		: `${strippedBase}/v2`;

	return async (input, init) => {
		let request =
			input instanceof Request && init === undefined
				? input
				: new Request(input, init);

		// Require a path boundary (not just a string prefix) so a base that
		// happens to be a textual prefix of an unrelated longer path can
		// never match.
		const boundary = request.url.charAt(sdkComputedBase.length);
		const matchesComputedBase =
			request.url.startsWith(sdkComputedBase) &&
			(boundary === "" ||
				boundary === "/" ||
				boundary === "?" ||
				boundary === "#");

		if (opts.exactBaseUrl && matchesComputedBase) {
			const exactUrl = strippedBase + request.url.slice(sdkComputedBase.length);
			// GET/HEAD requests cannot carry a body — the fetch spec throws if
			// one is passed, even a nullish stream reference.
			const hasBody = request.method !== "GET" && request.method !== "HEAD";
			// Buffer the body (rather than passing the live stream through)
			// so the new Request doesn't need Node's `duplex: "half"` option.
			const body = hasBody ? await request.arrayBuffer() : undefined;
			request = new Request(exactUrl, {
				method: request.method,
				headers: request.headers,
				body,
				redirect: request.redirect,
				signal: request.signal,
			});
		}

		for (const [name, value] of headerEntries) {
			request.headers.set(name, value);
		}

		return delegate(request);
	};
}

/**
 * Create a Camunda 8 cluster client with resolved configuration
 */
export function createClient(
	profileFlag?: string,
	additionalSdkConfig: Partial<CamundaOptions> = {},
): CamundaClient {
	const config = resolveClusterConfig(profileFlag);

	// Build config object for the SDK
	const sdkConfig: Partial<CamundaOptions["config"]> = {
		CAMUNDA_REST_ADDRESS: config.baseUrl,
	};

	// Add OAuth configuration if present
	if (config.clientId && config.clientSecret) {
		sdkConfig.CAMUNDA_AUTH_STRATEGY = "OAUTH";
		sdkConfig.CAMUNDA_CLIENT_ID = config.clientId;
		sdkConfig.CAMUNDA_CLIENT_SECRET = config.clientSecret;
		if (config.audience) {
			sdkConfig.CAMUNDA_TOKEN_AUDIENCE = config.audience;
		}
		if (config.oAuthUrl) {
			sdkConfig.CAMUNDA_OAUTH_URL = config.oAuthUrl;
		}
		if (config.scope) {
			sdkConfig.CAMUNDA_OAUTH_SCOPE = config.scope;
		}
	}
	// Add Basic auth configuration if present
	else if (config.username && config.password) {
		sdkConfig.CAMUNDA_AUTH_STRATEGY = "BASIC";
		sdkConfig.CAMUNDA_BASIC_AUTH_USERNAME = config.username;
		sdkConfig.CAMUNDA_BASIC_AUTH_PASSWORD = config.password;
	}
	// No authentication
	else {
		sdkConfig.CAMUNDA_AUTH_STRATEGY = "NONE";
	}

	// Add verbose/trace logging when --verbose flag is set
	if (c8ctl.verbose) {
		sdkConfig.CAMUNDA_SDK_LOG_LEVEL = "trace";
	}

	const options: Partial<CamundaOptions> = {
		config: sdkConfig,
		...additionalSdkConfig,
	};

	// Only wrap fetch when the profile actually needs it — profiles that
	// don't set headers or exactBaseUrl must behave exactly as before.
	const hasHeaders = !!(
		config.headers && Object.keys(config.headers).length > 0
	);
	if (hasHeaders || config.exactBaseUrl) {
		options.fetch = buildGatewayFetch({
			baseUrl: config.baseUrl,
			headers: config.headers,
			exactBaseUrl: config.exactBaseUrl,
			delegate: additionalSdkConfig.fetch,
		});
	}

	return createCamundaClient(options);
}

/**
 * Default page size for cursor-based pagination when fetching all results.
 */
export const DEFAULT_PAGE_SIZE = 100;

/**
 * Default upper bound on the total number of items fetched.
 * Prevents runaway memory usage on very large result sets.
 */
export const DEFAULT_MAX_ITEMS = 1_000_000;

/**
 * Paginated API response shape (the page metadata lives alongside items).
 * Matches the SDK 8.9+ SearchQueryResponse structure where page fields are
 * required but cursors are nullable.
 */
type PagedResponse<T> = {
	items: T[];
	page: {
		totalItems: number | bigint;
		endCursor: string | null;
		startCursor: string | null;
		hasMoreTotalItems: boolean;
	};
};

export type { PagedResponse };

/**
 * Fetch all pages from a Camunda 8 search endpoint using cursor-based
 * pagination. The caller supplies a search function that accepts a filter
 * object (with an optional `page` property) and returns a paged response.
 *
 * @param searchFn  – the SDK search method to call (e.g. `client.searchProcessInstances`)
 * @param filter    – base filter object; a `page` property will be merged in
 * @param pageSize  – items per page (default 100)
 * @param maxItems  – stop after collecting this many items (default 1 000 000)
 * @returns all collected items across every page (up to maxItems)
 */
/** Consistency options passed to every search call in fetchAllPages */
export type SearchConsistencyOpts = { consistency: { waitUpToMs: number } };

export async function fetchAllPages<
	T,
	F extends Record<string, unknown> = Record<string, unknown>,
>(
	searchFn: (
		filter: F & { page?: Record<string, unknown> },
		opts: SearchConsistencyOpts,
	) => Promise<PagedResponse<T>>,
	filter: F,
	pageSize = DEFAULT_PAGE_SIZE,
	maxItems = DEFAULT_MAX_ITEMS,
): Promise<T[]> {
	const allItems: T[] = [];
	let cursor: string | undefined;
	const seenCursors = new Set<string>();
	const consistencyOpts = { consistency: { waitUpToMs: 0 } };

	do {
		const pageFilter = {
			...filter,
			page: {
				limit: pageSize,
				...(cursor ? { after: cursor } : {}),
			},
		};

		const result = await searchFn(pageFilter, consistencyOpts);

		if (result.items.length) {
			allItems.push(...result.items);
		}

		if (allItems.length >= maxItems) {
			allItems.length = maxItems;
			break;
		}

		const endCursor = result.page.endCursor;
		const totalItems = Number(result.page.totalItems);

		if (!endCursor || seenCursors.has(endCursor)) break;
		if (allItems.length >= totalItems) break;
		if (!result.items.length) break;

		seenCursors.add(endCursor);
		cursor = endCursor;
		// biome-ignore lint/correctness/noConstantCondition: intentional infinite loop with multiple break conditions
	} while (true);

	return allItems;
}

/**
 * Emit a dry-run preview of an API request if dry-run mode is active.
 * Returns true when the preview was emitted (caller should return early),
 * false when normal execution should continue.
 */
export function emitDryRun(opts: {
	command: string;
	method: string;
	endpoint: string;
	profile?: string;
	body?: unknown;
}): boolean {
	if (!c8ctl.dryRun) return false;
	const config = resolveClusterConfig(opts.profile);
	const logger = getLogger();
	logger.json({
		dryRun: true,
		command: opts.command,
		method: opts.method,
		url: `${config.baseUrl}${opts.endpoint}`,
		...(opts.body !== undefined && { body: opts.body }),
	});
	return true;
}

/**
 * Resolve authentication headers for a given profile. Returns a
 * Record<string, string> containing the Authorization header (and
 * Content-Type). Acquires an OAuth token if OAuth credentials are configured.
 *
 * Call once per command invocation and reuse across paginated requests to avoid
 * redundant token fetches.
 */
export async function resolveAuthHeaders(
	profile?: string,
): Promise<Record<string, string>> {
	const config = resolveClusterConfig(profile);
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};

	if (config.clientId && config.clientSecret) {
		const tokenUrl = config.oAuthUrl;
		if (!tokenUrl) {
			throw new Error(
				"OAuth credentials are configured but oAuthUrl is missing — cannot acquire token",
			);
		}
		const params: Record<string, string> = {
			grant_type: "client_credentials",
			client_id: config.clientId,
			client_secret: config.clientSecret,
		};
		if (config.audience) {
			params.audience = config.audience;
		}
		if (config.scope) {
			params.scope = config.scope;
		}
		const tokenRes = await fetch(tokenUrl, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams(params),
		});
		if (!tokenRes.ok) {
			throw new Error(
				`OAuth token request failed: ${tokenRes.status} ${tokenRes.statusText} (token URL: ${tokenUrl})`,
			);
		}
		const tokenData: unknown = await tokenRes.json();
		if (isRecord(tokenData) && typeof tokenData.access_token === "string") {
			headers.Authorization = `Bearer ${tokenData.access_token}`;
		} else {
			throw new Error(
				"OAuth token response did not contain a valid access_token",
			);
		}
	} else if (config.username && config.password) {
		const encoded = Buffer.from(
			`${config.username}:${config.password}`,
		).toString("base64");
		headers.Authorization = `Basic ${encoded}`;
	}

	// Custom headers are applied last so a gateway-fronted profile can
	// override any header above (e.g. replacing Authorization with its own
	// gateway API key). Merged case-insensitively — HTTP header names are
	// case-insensitive, and `buildGatewayFetch`'s SDK-side equivalent uses
	// `Headers.set`, which already normalizes this way.
	if (config.headers) {
		mergeHeadersCaseInsensitive(headers, config.headers);
	}

	return headers;
}

/**
 * Set every entry from `overrides` on `target`, replacing any existing key
 * that differs only in case rather than adding a second, differently-cased
 * entry. `target` is a plain `Record<string, string>` (not a `Headers`
 * instance), since that's the contract `resolveAuthHeaders`/`rawPost*` use
 * for the one manual REST call that bypasses the SDK client. Delegates to
 * `setHeaderCaseInsensitive` (shared with `parseHeaderFlags`) for the
 * per-entry logic.
 */
function mergeHeadersCaseInsensitive(
	target: Record<string, string>,
	overrides: Record<string, string>,
): void {
	for (const [name, value] of Object.entries(overrides)) {
		setHeaderCaseInsensitive(target, name, value);
	}
}

/**
 * Mirror the SDK's own `/v2` auto-append rule (see `buildGatewayFetch` for
 * why there is no config flag to control this) for a manually-built REST
 * request. Returns `config.baseUrl` (trailing slashes stripped) untouched
 * when `exactBaseUrl` is set.
 *
 * Always returns a value with no trailing slash — including when
 * `config.baseUrl` already ends in `/v2/` — so the caller's
 * `${baseUrl}${endpoint}` concatenation never produces a double slash
 * (`endpoint` always starts with `/`).
 */
function restBaseUrlForProfile(profile?: string): string {
	const config = resolveClusterConfig(profile);
	const stripped = config.baseUrl.trim().replace(/\/+$/, "");
	if (config.exactBaseUrl) return stripped;
	return /\/v2$/i.test(stripped) ? stripped : `${stripped}/v2`;
}

/**
 * Make an authenticated POST request to a Camunda REST endpoint that is not yet
 * covered by the SDK. Resolves auth from the cluster config on each call.
 *
 * For paginated calls, prefer resolving auth once with `resolveAuthHeaders()`
 * and calling `rawPostWithHeaders()` to avoid repeated token fetches.
 */
export async function rawPost(
	client: CamundaClient,
	endpoint: string,
	body: unknown,
	profile?: string,
): Promise<unknown> {
	const headers = await resolveAuthHeaders(profile);
	return rawPostWithHeaders(client, endpoint, body, headers, profile);
}

/**
 * Make a POST request using pre-resolved auth headers. Use this inside
 * pagination loops after calling `resolveAuthHeaders()` once.
 *
 * `profile` is optional for backward compatibility: when omitted, the base
 * URL falls back to `client.getConfig().restAddress` (the SDK's own
 * resolved address), which does not honor a profile's `exactBaseUrl`.
 */
export async function rawPostWithHeaders(
	client: CamundaClient,
	endpoint: string,
	body: unknown,
	headers: Record<string, string>,
	profile?: string,
): Promise<unknown> {
	const baseUrl =
		profile === undefined
			? client.getConfig().restAddress
			: restBaseUrlForProfile(profile);

	const res = await fetch(`${baseUrl}${endpoint}`, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	});

	if (!res.ok) {
		let detail = "";
		try {
			const text = await res.text();
			if (text) detail = ` — ${text.slice(0, 500)}`;
		} catch {
			// ignore body read failure
		}
		throw new Error(
			`API request failed: ${res.status} ${res.statusText}${detail}`,
		);
	}

	return res.json();
}
