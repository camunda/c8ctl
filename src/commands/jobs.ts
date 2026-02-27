/**
 * Job commands
 */

import { getLogger } from '../logger.ts';
import { sortTableData, type SortOrder } from '../logger.ts';
import { createClient, fetchAllPages } from '../client.ts';
import { resolveTenantId } from '../config.ts';
import { parseBetween, buildDateFilter } from '../date-filter.ts';

/**
 * List jobs
 */
export async function listJobs(options: {
  profile?: string;
  state?: string;
  type?: string;
  sortBy?: string;
  sortOrder?: SortOrder;
  limit?: number;
  between?: string;
  dateField?: string;
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
    }

    if (options.type) {
      filter.filter.type = options.type;
    }

    if (options.between) {
      const parsed = parseBetween(options.between);
      if (parsed) {
        const field = options.dateField ?? 'creationTime';
        filter.filter[field] = buildDateFilter(parsed.from, parsed.to);
      } else {
        logger.error('Invalid --between value. Expected format: <from>..<to> (e.g. 2024-01-01..2024-12-31 or ISO 8601 datetimes)');
        process.exit(1);
      }
    }

    const allItems = await fetchAllPages(
      (f, opts) => client.searchJobs(f, opts),
      filter,
      undefined,
      options.limit,
    );
    
    if (allItems.length > 0) {
      let tableData = allItems.map((job: any) => ({
        Key: job.jobKey || job.key,
        Type: job.type,
        State: job.state,
        Retries: job.retries,
        Created: job.creationTime || '-',
        'Process Instance': job.processInstanceKey,
        'Tenant ID': job.tenantId,
      }));
      tableData = sortTableData(tableData, options.sortBy, logger, options.sortOrder);
      logger.table(tableData);
    } else {
      logger.info('No jobs found');
    }
  } catch (error) {
    logger.error('Failed to list jobs', error as Error);
    process.exit(1);
  }
}

/**
 * Activate jobs
 */
export async function activateJobs(type: string, options: {
  profile?: string;
  maxJobsToActivate?: number;
  timeout?: number;
  worker?: string;
}): Promise<void> {
  const logger = getLogger();
  const client = createClient(options.profile);
  const tenantId = resolveTenantId(options.profile);

  try {
    const request: any = {
      type,
      tenantIds: [tenantId],
      maxJobsToActivate: options.maxJobsToActivate || 10,
      timeout: options.timeout || 60000,
      worker: options.worker || 'c8ctl',
    };

    const result = await client.activateJobs(request);
    
    if (result.jobs && result.jobs.length > 0) {
      logger.success(`Activated ${result.jobs.length} jobs of type '${type}'`);
      const tableData = result.jobs.map((job: any) => ({
        Key: job.jobKey || job.key,
        Type: job.type,
        Retries: job.retries,
        'Process Instance': job.processInstanceKey,
      }));
      logger.table(tableData);
    } else {
      logger.info(`No jobs of type '${type}' available to activate`);
    }
  } catch (error) {
    logger.error(`Failed to activate jobs of type '${type}'`, error as Error);
    process.exit(1);
  }
}

/**
 * Complete job
 */
export async function completeJob(key: string, options: {
  profile?: string;
  variables?: string;
}): Promise<void> {
  const logger = getLogger();
  const client = createClient(options.profile);

  try {
    const request: any = {
      jobKey: key,
    };

    if (options.variables) {
      try {
        request.variables = JSON.parse(options.variables);
      } catch (error) {
        logger.error('Invalid JSON for variables', error as Error);
        process.exit(1);
      }
    }

    await client.completeJob(request);
    logger.success(`Job ${key} completed`);
  } catch (error) {
    logger.error(`Failed to complete job ${key}`, error as Error);
    process.exit(1);
  }
}

/**
 * Fail job
 */
export async function failJob(key: string, options: {
  profile?: string;
  retries?: number;
  errorMessage?: string;
}): Promise<void> {
  const logger = getLogger();
  const client = createClient(options.profile);

  try {
    const request: any = {
      jobKey: key,
      retries: options.retries !== undefined ? options.retries : 0,
      errorMessage: options.errorMessage || 'Job failed via c8ctl',
    };

    await client.failJob(request);
    logger.success(`Job ${key} failed`);
  } catch (error) {
    logger.error(`Failed to fail job ${key}`, error as Error);
    process.exit(1);
  }
}
