/**
 * SDK client factory using resolved configuration
 */

import {
	type CamundaClient,
	type CamundaOptions,
	createCamundaClient,
} from "@camunda8/orchestration-cluster-api";
import { resolveClusterConfig } from "./config.ts";
import { getLogger } from "./logger.ts";
import { c8ctl } from "./runtime.ts";

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

	return createCamundaClient({ config: sdkConfig, ...additionalSdkConfig });
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
