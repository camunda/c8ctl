/**
 * SDK client factory using resolved configuration
 */

import { createCamundaClient, type CamundaClient, type CamundaOptions } from '@camunda8/orchestration-cluster-api';
import { resolveClusterConfig, DEFAULT_PROFILE, getProfileOrModeler } from './config.ts';
import { getLogger } from './logger.ts';
import { c8ctl } from './runtime.ts';

/**
 * Inform the user once per process about which connection source is being used,
 * when no explicit profile or environment variable has been configured.
 */
let _connectionSourceInfoShown = false;

/** Reset the connection source info flag (for testing). */
export function resetConnectionSourceInfo(): void {
  _connectionSourceInfoShown = false;
}

function notifyConnectionSource(profileFlag?: string): void {
  if (_connectionSourceInfoShown) return;

  // Only show the note when no explicit profile was provided via flag
  // and the session is still on the default profile
  const usingDefault = !profileFlag &&
    (!c8ctl.activeProfile || c8ctl.activeProfile === DEFAULT_PROFILE);
  if (!usingDefault) return;

  // Only show the note when no explicitly-configured 'local' profile exists
  const hasLocalProfile = !!getProfileOrModeler(DEFAULT_PROFILE);
  if (hasLocalProfile) return;

  _connectionSourceInfoShown = true;
  const logger = getLogger();
  if (process.env.CAMUNDA_BASE_URL) {
    logger.info(`CAMUNDA_BASE_URL is set. Using environment variable configuration (${process.env.CAMUNDA_BASE_URL}).`);
  } else {
    logger.info('CAMUNDA_BASE_URL is not set. Falling back to local cluster defaults (http://localhost:8080).');
    logger.info('Configure a profile: c8ctl add profile local --baseUrl http://localhost:8080');
  }
}

/**
 * Create a Camunda 8 cluster client with resolved configuration
 */
export function createClient(
  profileFlag?: string,
  additionalSdkConfig: Partial<CamundaOptions> = {},
): CamundaClient {
  notifyConnectionSource(profileFlag);
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

  // Add verbose/trace logging when --verbose flag is set
  if (c8ctl.verbose) {
    sdkConfig.CAMUNDA_SDK_LOG_LEVEL = 'trace';
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
  } while (true);

  return allItems;
}
