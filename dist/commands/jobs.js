/**
 * Job commands
 */
import { getLogger } from "../logger.js";
import { createClient } from "../client.js";
import { resolveTenantId } from "../config.js";
/**
 * List jobs
 */
export async function listJobs(options) {
    const logger = getLogger();
    const client = createClient(options.profile);
    const tenantId = resolveTenantId(options.profile);
    try {
        const filter = {
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
        const result = await client.searchJobs(filter, { consistency: { waitUpToMs: 0 } });
        if (result.items && result.items.length > 0) {
            const tableData = result.items.map((job) => ({
                Key: job.jobKey || job.key,
                Type: job.type,
                State: job.state,
                Retries: job.retries,
                'Process Instance': job.processInstanceKey,
                'Tenant ID': job.tenantId,
            }));
            logger.table(tableData);
        }
        else {
            logger.info('No jobs found');
        }
    }
    catch (error) {
        logger.error('Failed to list jobs', error);
        process.exit(1);
    }
}
/**
 * Activate jobs
 */
export async function activateJobs(type, options) {
    const logger = getLogger();
    const client = createClient(options.profile);
    const tenantId = resolveTenantId(options.profile);
    try {
        const request = {
            type,
            tenantIds: [tenantId],
            maxJobsToActivate: options.maxJobsToActivate || 10,
            timeout: options.timeout || 60000,
            worker: options.worker || 'c8ctl',
        };
        const result = await client.activateJobs(request);
        if (result.jobs && result.jobs.length > 0) {
            logger.success(`Activated ${result.jobs.length} jobs of type '${type}'`);
            const tableData = result.jobs.map((job) => ({
                Key: job.jobKey || job.key,
                Type: job.type,
                Retries: job.retries,
                'Process Instance': job.processInstanceKey,
            }));
            logger.table(tableData);
        }
        else {
            logger.info(`No jobs of type '${type}' available to activate`);
        }
    }
    catch (error) {
        logger.error(`Failed to activate jobs of type '${type}'`, error);
        process.exit(1);
    }
}
/**
 * Complete job
 */
export async function completeJob(key, options) {
    const logger = getLogger();
    const client = createClient(options.profile);
    try {
        const request = {
            jobKey: key,
        };
        if (options.variables) {
            try {
                request.variables = JSON.parse(options.variables);
            }
            catch (error) {
                logger.error('Invalid JSON for variables', error);
                process.exit(1);
            }
        }
        await client.completeJob(request);
        logger.success(`Job ${key} completed`);
    }
    catch (error) {
        logger.error(`Failed to complete job ${key}`, error);
        process.exit(1);
    }
}
/**
 * Fail job
 */
export async function failJob(key, options) {
    const logger = getLogger();
    const client = createClient(options.profile);
    try {
        const request = {
            jobKey: key,
            retries: options.retries !== undefined ? options.retries : 0,
            errorMessage: options.errorMessage || 'Job failed via c8ctl',
        };
        await client.failJob(request);
        logger.success(`Job ${key} failed`);
    }
    catch (error) {
        logger.error(`Failed to fail job ${key}`, error);
        process.exit(1);
    }
}
//# sourceMappingURL=jobs.js.map