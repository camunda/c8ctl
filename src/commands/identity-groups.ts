/**
 * Identity group commands
 */

import { getLogger } from '../logger.ts';
import { sortTableData, type SortOrder } from '../logger.ts';
import { createClient, fetchAllPages } from '../client.ts';
import { resolveClusterConfig } from '../config.ts';
import { c8ctl } from '../runtime.ts';
import { toStringFilter } from './search.ts';

/**
 * List all groups
 */
export async function listGroups(options: {
  profile?: string;
  sortBy?: string;
  sortOrder?: SortOrder;
  limit?: number;
}): Promise<void> {
  const logger = getLogger();
  const client = createClient(options.profile);

  try {
    const items = await fetchAllPages(
      (filter: any, opts: any) => client.searchGroups(filter, opts),
      {},
      undefined,
      options.limit,
    );

    if (items.length === 0) {
      logger.info('No groups found');
      return;
    }

    let tableData = items.map((g: any) => ({
      'Group ID': g.groupId ?? '',
      Name: g.name ?? '',
      Description: g.description ?? '',
    }));
    tableData = sortTableData(tableData, options.sortBy, logger, options.sortOrder);
    logger.table(tableData);
  } catch (error) {
    logger.error('Failed to list groups', error as Error);
    process.exit(1);
  }
}

/**
 * Search groups with filters
 */
export async function searchIdentityGroups(options: {
  profile?: string;
  groupId?: string;
  name?: string;
  sortBy?: string;
  sortOrder?: SortOrder;
  limit?: number;
}): Promise<void> {
  const logger = getLogger();
  const client = createClient(options.profile);

  try {
    const filter: any = {};
    if (options.groupId) filter.groupId = toStringFilter(options.groupId);
    if (options.name) filter.name = toStringFilter(options.name);

    const searchFilter = Object.keys(filter).length > 0 ? { filter } : {};

    const items = await fetchAllPages(
      (f: any, opts: any) => client.searchGroups(f, opts),
      searchFilter,
      undefined,
      options.limit,
    );

    if (items.length === 0) {
      logger.info('No groups found');
      return;
    }

    let tableData = items.map((g: any) => ({
      'Group ID': g.groupId ?? '',
      Name: g.name ?? '',
      Description: g.description ?? '',
    }));
    tableData = sortTableData(tableData, options.sortBy, logger, options.sortOrder);
    logger.table(tableData);
  } catch (error) {
    logger.error('Failed to search groups', error as Error);
    process.exit(1);
  }
}

/**
 * Get a single group by groupId
 */
export async function getIdentityGroup(groupId: string, options: {
  profile?: string;
}): Promise<void> {
  const logger = getLogger();
  const client = createClient(options.profile);

  try {
    const result = await client.getGroup({ groupId: groupId as any }, { consistency: { waitUpToMs: 0 } });
    logger.json(result);
  } catch (error) {
    logger.error(`Failed to get group '${groupId}'`, error as Error);
    process.exit(1);
  }
}

/**
 * Create a new group
 */
export async function createIdentityGroup(options: {
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
      command: 'create group',
      method: 'POST',
      url: `${config.baseUrl}/groups`,
      body,
    });
    return;
  }

  const client = createClient(options.profile);

  try {
    await client.createGroup(body as any);
    logger.success(`Group '${options.name}' created`);
  } catch (error) {
    logger.error('Failed to create group', error as Error);
    process.exit(1);
  }
}

/**
 * Delete a group by groupId
 */
export async function deleteIdentityGroup(groupId: string, options: {
  profile?: string;
}): Promise<void> {
  const logger = getLogger();

  if (c8ctl.dryRun) {
    const config = resolveClusterConfig(options.profile);
    logger.json({
      dryRun: true,
      command: 'delete group',
      method: 'DELETE',
      url: `${config.baseUrl}/groups/${groupId}`,
    });
    return;
  }

  const client = createClient(options.profile);

  try {
    await client.deleteGroup({ groupId: groupId as any });
    logger.success(`Group '${groupId}' deleted`);
  } catch (error) {
    logger.error(`Failed to delete group '${groupId}'`, error as Error);
    process.exit(1);
  }
}
