/**
 * Identity role commands
 */

import { getLogger } from '../logger.ts';
import { sortTableData, type SortOrder } from '../logger.ts';
import { createClient, fetchAllPages } from '../client.ts';
import { resolveClusterConfig } from '../config.ts';
import { c8ctl } from '../runtime.ts';
import { toStringFilter } from './search.ts';

/**
 * List all roles
 */
export async function listRoles(options: {
  profile?: string;
  sortBy?: string;
  sortOrder?: SortOrder;
  limit?: number;
}): Promise<void> {
  const logger = getLogger();
  const client = createClient(options.profile);

  try {
    const items = await fetchAllPages(
      (filter: any, opts: any) => client.searchRoles(filter, opts),
      {},
      undefined,
      options.limit,
    );

    if (items.length === 0) {
      logger.info('No roles found');
      return;
    }

    let tableData = items.map((r: any) => ({
      'Role ID': r.roleId ?? '',
      Name: r.name ?? '',
      Description: r.description ?? '',
    }));
    tableData = sortTableData(tableData, options.sortBy, logger, options.sortOrder);
    logger.table(tableData);
  } catch (error) {
    logger.error('Failed to list roles', error as Error);
    process.exit(1);
  }
}

/**
 * Search roles with filters
 */
export async function searchIdentityRoles(options: {
  profile?: string;
  roleId?: string;
  name?: string;
  sortBy?: string;
  sortOrder?: SortOrder;
  limit?: number;
}): Promise<void> {
  const logger = getLogger();
  const client = createClient(options.profile);

  try {
    const filter: any = {};
    if (options.roleId) filter.roleId = toStringFilter(options.roleId);
    if (options.name) filter.name = toStringFilter(options.name);

    const searchFilter = Object.keys(filter).length > 0 ? { filter } : {};

    const items = await fetchAllPages(
      (f: any, opts: any) => client.searchRoles(f, opts),
      searchFilter,
      undefined,
      options.limit,
    );

    if (items.length === 0) {
      logger.info('No roles found');
      return;
    }

    let tableData = items.map((r: any) => ({
      'Role ID': r.roleId ?? '',
      Name: r.name ?? '',
      Description: r.description ?? '',
    }));
    tableData = sortTableData(tableData, options.sortBy, logger, options.sortOrder);
    logger.table(tableData);
  } catch (error) {
    logger.error('Failed to search roles', error as Error);
    process.exit(1);
  }
}

/**
 * Get a single role by roleId
 */
export async function getIdentityRole(roleId: string, options: {
  profile?: string;
}): Promise<void> {
  const logger = getLogger();
  const client = createClient(options.profile);

  try {
    const result = await client.getRole({ roleId: roleId as any }, { consistency: { waitUpToMs: 0 } });
    logger.json(result);
  } catch (error) {
    logger.error(`Failed to get role '${roleId}'`, error as Error);
    process.exit(1);
  }
}

/**
 * Create a new role
 */
export async function createIdentityRole(options: {
  profile?: string;
  name?: string;
}): Promise<void> {
  const logger = getLogger();

  if (!options.name) {
    logger.error('--name is required');
    process.exit(1);
  }

  const body: Record<string, unknown> = { name: options.name };

  if (c8ctl.dryRun) {
    const config = resolveClusterConfig(options.profile);
    logger.json({
      dryRun: true,
      command: 'create role',
      method: 'POST',
      url: `${config.baseUrl}/roles`,
      body,
    });
    return;
  }

  const client = createClient(options.profile);

  try {
    await client.createRole(body as any);
    logger.success(`Role '${options.name}' created`);
  } catch (error) {
    logger.error('Failed to create role', error as Error);
    process.exit(1);
  }
}

/**
 * Delete a role by roleId
 */
export async function deleteIdentityRole(roleId: string, options: {
  profile?: string;
}): Promise<void> {
  const logger = getLogger();

  if (c8ctl.dryRun) {
    const config = resolveClusterConfig(options.profile);
    logger.json({
      dryRun: true,
      command: 'delete role',
      method: 'DELETE',
      url: `${config.baseUrl}/roles/${roleId}`,
    });
    return;
  }

  const client = createClient(options.profile);

  try {
    await client.deleteRole({ roleId: roleId as any });
    logger.success(`Role '${roleId}' deleted`);
  } catch (error) {
    logger.error(`Failed to delete role '${roleId}'`, error as Error);
    process.exit(1);
  }
}
