/**
 * Identity tenant commands
 */

import { getLogger } from '../logger.ts';
import { sortTableData, type SortOrder } from '../logger.ts';
import { createClient, fetchAllPages } from '../client.ts';
import { resolveClusterConfig } from '../config.ts';
import { c8ctl } from '../runtime.ts';
import { handleCommandError } from '../errors.ts';
import { TenantId } from '@camunda8/orchestration-cluster-api';

/**
 * List all tenants
 */
export async function listTenants(options: {
  profile?: string;
  sortBy?: string;
  sortOrder?: SortOrder;
  limit?: number;
}): Promise<void> {
  const logger = getLogger();
  const client = createClient(options.profile);

  try {
    const items = await fetchAllPages(
      (filter: any, opts: any) => client.searchTenants(filter, opts),
      {},
      undefined,
      options.limit,
    );

    if (items.length === 0) {
      logger.info('No tenants found');
      return;
    }

    let tableData = items.map((t: any) => ({
      'Tenant ID': t.tenantId ?? '',
      Name: t.name ?? '',
      Description: t.description ?? '',
    }));
    tableData = sortTableData(tableData, options.sortBy, logger, options.sortOrder);
    logger.table(tableData);
  } catch (error) {
    handleCommandError(logger, 'Failed to list tenants', error);
  }
}

/**
 * Search tenants with filters
 */
export async function searchIdentityTenants(options: {
  profile?: string;
  tenantId?: string;
  name?: string;
  sortBy?: string;
  sortOrder?: SortOrder;
  limit?: number;
}): Promise<void> {
  const logger = getLogger();
  const client = createClient(options.profile);

  try {
    const filter: any = {};
    if (options.tenantId) filter.tenantId = options.tenantId;
    if (options.name) filter.name = options.name;

    const searchFilter = Object.keys(filter).length > 0 ? { filter } : {};

    const items = await fetchAllPages(
      (f: any, opts: any) => client.searchTenants(f, opts),
      searchFilter,
      undefined,
      options.limit,
    );

    if (items.length === 0) {
      logger.info('No tenants found');
      return;
    }

    let tableData = items.map((t: any) => ({
      'Tenant ID': t.tenantId ?? '',
      Name: t.name ?? '',
      Description: t.description ?? '',
    }));
    tableData = sortTableData(tableData, options.sortBy, logger, options.sortOrder);
    logger.table(tableData);
  } catch (error) {
    handleCommandError(logger, 'Failed to search tenants', error);
  }
}

/**
 * Get a single tenant by tenantId
 */
export async function getIdentityTenant(tenantId: string, options: {
  profile?: string;
}): Promise<void> {
  const logger = getLogger();
  const client = createClient(options.profile);

  try {
    const result = await client.getTenant({ tenantId: TenantId.assumeExists(tenantId) }, { consistency: { waitUpToMs: 0 } });
    logger.json(result);
  } catch (error) {
    handleCommandError(logger, `Failed to get tenant '${tenantId}'`, error);
  }
}

/**
 * Create a new tenant
 */
export async function createIdentityTenant(options: {
  profile?: string;
  tenantId?: string;
  name?: string;
}): Promise<void> {
  const logger = getLogger();

  if (!options.tenantId) {
    logger.error('--tenantId is required');
    process.exit(1);
  }
  if (!options.name) {
    logger.error('--name is required');
    process.exit(1);
  }

  const body = {
    tenantId: options.tenantId,
    name: options.name,
  };

  if (c8ctl.dryRun) {
    const config = resolveClusterConfig(options.profile);
    logger.json({
      dryRun: true,
      command: 'create tenant',
      method: 'POST',
      url: `${config.baseUrl}/tenants`,
      body,
    });
    return;
  }

  const client = createClient(options.profile);

  try {
    await client.createTenant(body);
    logger.success(`Tenant '${options.tenantId}' created`);
  } catch (error) {
    handleCommandError(logger, 'Failed to create tenant', error);
  }
}

/**
 * Delete a tenant by tenantId
 */
export async function deleteIdentityTenant(tenantId: string, options: {
  profile?: string;
}): Promise<void> {
  const logger = getLogger();

  if (c8ctl.dryRun) {
    const config = resolveClusterConfig(options.profile);
    logger.json({
      dryRun: true,
      command: 'delete tenant',
      method: 'DELETE',
      url: `${config.baseUrl}/tenants/${encodeURIComponent(tenantId)}`,
      body: null,
    });
    return;
  }

  const client = createClient(options.profile);

  try {
    await client.deleteTenant({ tenantId: TenantId.assumeExists(tenantId) });
    logger.success(`Tenant '${tenantId}' deleted`);
  } catch (error) {
    handleCommandError(logger, `Failed to delete tenant '${tenantId}'`, error);
  }
}
