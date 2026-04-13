/**
 * Job commands
 */

import { JobKey, TenantId } from "@camunda8/orchestration-cluster-api";
import { createClient, fetchAllPages } from "../client.ts";
import { resolveClusterConfig, resolveTenantId } from "../config.ts";
import { buildDateFilter, parseBetween } from "../date-filter.ts";
import { handleCommandError } from "../errors.ts";
import { getLogger, type SortOrder, sortTableData } from "../logger.ts";
import { c8ctl } from "../runtime.ts";

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
		const filter: { filter: Record<string, unknown> } = {
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
				const field = options.dateField ?? "creationTime";
				filter.filter[field] = buildDateFilter(parsed.from, parsed.to);
			} else {
				logger.error(
					"Invalid --between value. Expected format: <from>..<to> (e.g. 2024-01-01..2024-12-31, ISO 8601 datetimes, or open-ended: ..2024-12-31 or 2024-01-01..)",
				);
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
			let tableData = allItems.map((job) => ({
				Key: job.jobKey,
				Type: job.type,
				State: job.state,
				Retries: job.retries,
				Created: job.creationTime || "-",
				"Process Instance": job.processInstanceKey,
				"Tenant ID": job.tenantId,
			}));
			tableData = sortTableData(
				tableData,
				options.sortBy,
				logger,
				options.sortOrder,
			);
			logger.table(tableData);
		} else {
			logger.info("No jobs found");
		}
	} catch (error) {
		handleCommandError(logger, "Failed to list jobs", error);
	}
}

/**
 * Activate jobs
 */
export async function activateJobs(
	type: string,
	options: {
		profile?: string;
		maxJobsToActivate?: number;
		timeout?: number;
		worker?: string;
	},
): Promise<void> {
	const logger = getLogger();

	// Dry-run: emit the would-be API request without executing
	if (c8ctl.dryRun) {
		const config = resolveClusterConfig(options.profile);
		const tenantId = resolveTenantId(options.profile);
		logger.json({
			dryRun: true,
			command: "activate jobs",
			method: "POST",
			url: `${config.baseUrl}/jobs/activation`,
			body: {
				type,
				tenantIds: [tenantId],
				maxJobsToActivate: options.maxJobsToActivate || 10,
				timeout: options.timeout || 60000,
				worker: options.worker || "c8ctl",
			},
		});
		return;
	}

	const client = createClient(options.profile);
	const tenantId = resolveTenantId(options.profile);

	try {
		const result = await client.activateJobs({
			type,
			tenantIds: [TenantId.assumeExists(tenantId)],
			maxJobsToActivate: options.maxJobsToActivate || 10,
			timeout: options.timeout || 60000,
			worker: options.worker || "c8ctl",
		});

		if (result.jobs && result.jobs.length > 0) {
			logger.success(`Activated ${result.jobs.length} jobs of type '${type}'`);
			const tableData = result.jobs.map((job) => ({
				Key: job.jobKey,
				Type: job.type,
				Retries: job.retries,
				"Process Instance": job.processInstanceKey,
			}));
			logger.table(tableData);
		} else {
			logger.info(`No jobs of type '${type}' available to activate`);
		}
	} catch (error) {
		handleCommandError(
			logger,
			`Failed to activate jobs of type '${type}'`,
			error,
		);
	}
}

/**
 * Complete job
 */
export async function completeJob(
	key: string,
	options: {
		profile?: string;
		variables?: string;
	},
): Promise<void> {
	const logger = getLogger();

	// Dry-run: emit the would-be API request without executing
	if (c8ctl.dryRun) {
		const config = resolveClusterConfig(options.profile);
		const body: Record<string, unknown> = {};
		if (options.variables) body.variables = JSON.parse(options.variables);
		logger.json({
			dryRun: true,
			command: "complete job",
			method: "POST",
			url: `${config.baseUrl}/jobs/${key}/completion`,
			body,
		});
		return;
	}

	const client = createClient(options.profile);

	try {
		let variables: Record<string, unknown> | undefined;
		if (options.variables) {
			try {
				variables = JSON.parse(options.variables);
			} catch (error) {
				handleCommandError(logger, "Invalid JSON for variables", error);
				return;
			}
		}
		await client.completeJob({
			jobKey: JobKey.assumeExists(key),
			...(variables !== undefined && { variables }),
		});
		logger.success(`Job ${key} completed`);
	} catch (error) {
		handleCommandError(logger, `Failed to complete job ${key}`, error);
	}
}

/**
 * Fail job
 */
export async function failJob(
	key: string,
	options: {
		profile?: string;
		retries?: number;
		errorMessage?: string;
	},
): Promise<void> {
	const logger = getLogger();

	// Dry-run: emit the would-be API request without executing
	if (c8ctl.dryRun) {
		const config = resolveClusterConfig(options.profile);
		logger.json({
			dryRun: true,
			command: "fail job",
			method: "POST",
			url: `${config.baseUrl}/jobs/${key}/failure`,
			body: {
				retries: options.retries !== undefined ? options.retries : 0,
				errorMessage: options.errorMessage || "Job failed via c8ctl",
			},
		});
		return;
	}

	const client = createClient(options.profile);

	try {
		await client.failJob({
			jobKey: JobKey.assumeExists(key),
			retries: options.retries !== undefined ? options.retries : 0,
			errorMessage: options.errorMessage || "Job failed via c8ctl",
		});
		logger.success(`Job ${key} failed`);
	} catch (error) {
		handleCommandError(logger, `Failed to fail job ${key}`, error);
	}
}
