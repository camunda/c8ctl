/**
 * Identity authorization commands
 */

import { getLogger } from '../logger.ts';
import { sortTableData, type SortOrder } from '../logger.ts';
import { createClient, fetchAllPages } from '../client.ts';
import { resolveClusterConfig } from '../config.ts';
import { c8ctl } from '../runtime.ts';
import { handleCommandError } from '../errors.ts';
import { AuthorizationKey } from '@camunda8/orchestration-cluster-api';
import type { createAuthorizationInput } from '@camunda8/orchestration-cluster-api';

/**
 * List all authorizations
 */
export async function listAuthorizations(options: {
  profile?: string;
  sortBy?: string;
  sortOrder?: SortOrder;
  limit?: number;
}): Promise<void> {
  const logger = getLogger();
  const client = createClient(options.profile);

  try {
    const items = await fetchAllPages(
      (filter: any, opts: any) => client.searchAuthorizations(filter, opts),
      {},
      undefined,
      options.limit,
    );

    if (items.length === 0) {
      logger.info('No authorizations found');
      return;
    }

    let tableData = items.map((a: any) => ({
      Key: a.authorizationKey ?? '',
      'Owner ID': a.ownerId ?? '',
      'Owner Type': a.ownerType ?? '',
      'Resource Type': a.resourceType ?? '',
      'Resource ID': a.resourceId ?? '',
      Permissions: Array.isArray(a.permissionTypes) ? a.permissionTypes.join(', ') : '',
    }));
    tableData = sortTableData(tableData, options.sortBy, logger, options.sortOrder);
    logger.table(tableData);
  } catch (error) {
    handleCommandError(logger, 'Failed to list authorizations', error);
  }
}

/**
 * Search authorizations with filters
 */
export async function searchIdentityAuthorizations(options: {
  profile?: string;
  ownerId?: string;
  ownerType?: string;
  resourceType?: string;
  resourceId?: string;
  sortBy?: string;
  sortOrder?: SortOrder;
  limit?: number;
}): Promise<void> {
  const logger = getLogger();
  const client = createClient(options.profile);

  try {
    const filter: any = {};
    if (options.ownerId) filter.ownerId = options.ownerId;
    if (options.ownerType) filter.ownerType = options.ownerType;
    if (options.resourceType) filter.resourceType = options.resourceType;
    if (options.resourceId) filter.resourceIds = [options.resourceId];

    const searchFilter = Object.keys(filter).length > 0 ? { filter } : {};

    const items = await fetchAllPages(
      (f: any, opts: any) => client.searchAuthorizations(f, opts),
      searchFilter,
      undefined,
      options.limit,
    );

    if (items.length === 0) {
      logger.info('No authorizations found');
      return;
    }

    let tableData = items.map((a: any) => ({
      Key: a.authorizationKey ?? '',
      'Owner ID': a.ownerId ?? '',
      'Owner Type': a.ownerType ?? '',
      'Resource Type': a.resourceType ?? '',
      'Resource ID': a.resourceId ?? '',
      Permissions: Array.isArray(a.permissionTypes) ? a.permissionTypes.join(', ') : '',
    }));
    tableData = sortTableData(tableData, options.sortBy, logger, options.sortOrder);
    logger.table(tableData);
  } catch (error) {
    handleCommandError(logger, 'Failed to search authorizations', error);
  }
}

/**
 * Get a single authorization by key
 */
export async function getIdentityAuthorization(authorizationKey: string, options: {
  profile?: string;
}): Promise<void> {
  const logger = getLogger();
  const client = createClient(options.profile);

  try {
    const result = await client.getAuthorization({ authorizationKey: AuthorizationKey.assumeExists(authorizationKey) }, { consistency: { waitUpToMs: 0 } });
    logger.json(result);
  } catch (error) {
    handleCommandError(logger, `Failed to get authorization '${authorizationKey}'`, error);
  }
}

/**
 * Create a new authorization
 */
export async function createIdentityAuthorization(options: {
  profile?: string;
  ownerId?: string;
  ownerType?: string;
  resourceType?: string;
  resourceId?: string;
  permissions?: string;
}): Promise<void> {
  const logger = getLogger();

  if (!options.ownerId) {
    logger.error('--ownerId is required');
    process.exit(1);
  }
  if (!options.ownerType) {
    logger.error('--ownerType is required');
    process.exit(1);
  }
  if (!options.resourceType) {
    logger.error('--resourceType is required');
    process.exit(1);
  }
  if (!options.resourceId) {
    logger.error('--resourceId is required');
    process.exit(1);
  }
  if (!options.permissions) {
    logger.error('--permissions is required');
    process.exit(1);
  }

  const body: Record<string, unknown> = {
    ownerId: options.ownerId,
    ownerType: options.ownerType,
    resourceType: options.resourceType,
    resourceId: options.resourceId,
    permissionTypes: options.permissions.split(',').map(p => p.trim()).filter(p => p.length > 0),
  };

  if (c8ctl.dryRun) {
    const config = resolveClusterConfig(options.profile);
    logger.json({
      dryRun: true,
      command: 'create authorization',
      method: 'POST',
      url: `${config.baseUrl}/authorizations`,
      body,
    });
    return;
  }

  const client = createClient(options.profile);

  try {
    await client.createAuthorization(body as createAuthorizationInput);
    logger.success('Authorization created');
  } catch (error) {
    handleCommandError(logger, 'Failed to create authorization', error);
  }
}

/**
 * Delete an authorization by key
 */
export async function deleteIdentityAuthorization(authorizationKey: string, options: {
  profile?: string;
}): Promise<void> {
  const logger = getLogger();

  if (c8ctl.dryRun) {
    const config = resolveClusterConfig(options.profile);
    logger.json({
      dryRun: true,
      command: 'delete authorization',
      method: 'DELETE',
      url: `${config.baseUrl}/authorizations/${encodeURIComponent(String(authorizationKey))}`,
      body: null,
    });
    return;
  }

  const client = createClient(options.profile);

  try {
    await client.deleteAuthorization({ authorizationKey: AuthorizationKey.assumeExists(authorizationKey) });
    logger.success(`Authorization '${authorizationKey}' deleted`);
  } catch (error) {
    handleCommandError(logger, `Failed to delete authorization '${authorizationKey}'`, error);
  }
}
