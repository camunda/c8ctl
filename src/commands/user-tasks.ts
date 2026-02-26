/**
 * User task commands
 */

import { getLogger } from '../logger.ts';
import { sortTableData, type SortOrder } from '../logger.ts';
import { createClient, fetchAllPages } from '../client.ts';
import { resolveTenantId } from '../config.ts';

/**
 * List user tasks
 */
export async function listUserTasks(options: {
  profile?: string;
  state?: string;
  assignee?: string;
  all?: boolean;
  sortBy?: string;
  sortOrder?: SortOrder;
  limit?: number;
}): Promise<void> {
  const logger = getLogger();
  const client = createClient(options.profile);
  const tenantId = resolveTenantId(options.profile);

  try {
    const filter: any = {
      filter: {
        tenantId,
      },
    };

    if (options.state) {
      filter.filter.state = options.state;
    } else if (!options.all) {
      // By default, exclude COMPLETED tasks unless --all is specified
      filter.filter.state = 'CREATED';
    }

    if (options.assignee) {
      filter.filter.assignee = options.assignee;
    }

    const allItems = await fetchAllPages(
      (f, opts) => client.searchUserTasks(f, opts),
      filter,
      undefined,
      options.limit,
    );
    
    if (allItems.length > 0) {
      let tableData = allItems.map((task: any) => ({
        Key: task.userTaskKey || task.key,
        Name: task.name || task.elementId,
        State: task.state,
        Assignee: task.assignee || '(unassigned)',
        Created: task.creationDate || '-',
        'Process Instance': task.processInstanceKey,
        'Tenant ID': task.tenantId,
      }));
      tableData = sortTableData(tableData, options.sortBy, logger, options.sortOrder);
      logger.table(tableData);
    } else {
      logger.info('No user tasks found');
    }
  } catch (error) {
    logger.error('Failed to list user tasks', error as Error);
    process.exit(1);
  }
}

/**
 * Complete user task
 */
export async function completeUserTask(key: string, options: {
  profile?: string;
  variables?: string;
}): Promise<void> {
  const logger = getLogger();
  const client = createClient(options.profile);

  try {
    const request: any = {
      userTaskKey: key,
    };

    if (options.variables) {
      try {
        request.variables = JSON.parse(options.variables);
      } catch (error) {
        logger.error('Invalid JSON for variables', error as Error);
        process.exit(1);
      }
    }

    await client.completeUserTask(request);
    logger.success(`User task ${key} completed`);
  } catch (error) {
    logger.error(`Failed to complete user task ${key}`, error as Error);
    process.exit(1);
  }
}
