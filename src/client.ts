/**
 * SDK client factory using resolved configuration
 */

import { createCamundaClient, type CamundaClient, type CamundaOptions } from '@camunda8/orchestration-cluster-api';
import { resolveClusterConfig } from './config.ts';

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
    sdkConfig.CAMUNDA_AUTH_STRATEGY = 'OAUTH';
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
    sdkConfig.CAMUNDA_AUTH_STRATEGY = 'BASIC';
    sdkConfig.CAMUNDA_BASIC_AUTH_USERNAME = config.username;
    sdkConfig.CAMUNDA_BASIC_AUTH_PASSWORD = config.password;
  }
  // No authentication
  else {
    sdkConfig.CAMUNDA_AUTH_STRATEGY = 'NONE';
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
 */
type PagedResponse<T> = {
  items?: T[];
  page?: {
    totalItems?: bigint | number;
    endCursor?: string;
    startCursor?: string;
    hasMoreTotalItems?: boolean;
  };
};

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
export async function fetchAllPages<T>(
  searchFn: (filter: any, opts?: any) => Promise<PagedResponse<T>>,
  filter: Record<string, unknown> = {},
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

    if (result.items?.length) {
      allItems.push(...result.items);
    }

    if (allItems.length >= maxItems) {
      allItems.length = maxItems;
      break;
    }

    const endCursor = result.page?.endCursor;
    // totalItems is BigInt from the SDK's Zod schema (z.coerce.bigint()); convert to number
    const totalItems = result.page?.totalItems !== undefined ? Number(result.page.totalItems) : undefined;

    if (!endCursor || seenCursors.has(endCursor)) break;
    if (totalItems !== undefined && allItems.length >= totalItems) break;
    if (!result.items?.length) break;

    seenCursors.add(endCursor);
    cursor = endCursor;
  } while (true);

  return allItems;
}
