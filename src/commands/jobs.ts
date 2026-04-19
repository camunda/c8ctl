/**
 * Job commands
 */

import { TenantId } from "@camunda8/orchestration-cluster-api";
import { fetchAllPages } from "../client.ts";
import { defineCommand, dryRun } from "../command-framework.ts";
import { buildDateFilter, parseBetween } from "../date-filter.ts";

/**
 * List jobs
 */
export const listJobsCommand = defineCommand(
	"list",
	"jobs",
	async (ctx, flags) => {
		const { client, tenantId, profile, limit, between, dateField } = ctx;

		const filter: { filter: Record<string, unknown> } = {
			filter: {
				tenantId,
			},
		};

		if (flags.state) {
			filter.filter.state = flags.state;
		}

		if (flags.type) {
			filter.filter.type = flags.type;
		}

		if (between) {
			const parsed = parseBetween(between);
			if (parsed) {
				const field = dateField ?? "creationTime";
				filter.filter[field] = buildDateFilter(parsed.from, parsed.to);
			} else {
				throw new Error(
					"Invalid --between value. Expected format: <from>..<to> (e.g. 2024-01-01..2024-12-31, ISO 8601 datetimes, or open-ended: ..2024-12-31 or 2024-01-01..)",
				);
			}
		}

		const dr = dryRun({
			command: "list jobs",
			method: "POST",
			endpoint: "/jobs/search",
			profile,
			body: filter,
		});
		if (dr) return dr;

		const allItems = await fetchAllPages(
			(f, opts) => client.searchJobs(f, opts),
			filter,
			undefined,
			limit,
		);

		return {
			kind: "list",
			items: allItems.map((job) => ({
				Key: job.jobKey,
				Type: job.type,
				State: job.state,
				Retries: job.retries,
				Created: job.creationTime || "-",
				"Process Instance": job.processInstanceKey,
				"Tenant ID": job.tenantId,
			})),
			emptyMessage: "No jobs found",
		};
	},
);

/**
 * Activate jobs
 */
export const activateJobsCommand = defineCommand(
	"activate",
	"jobs",
	async (ctx, flags, args) => {
		const { client, tenantId, profile } = ctx;
		const type = args.type;
		const maxJobsToActivate = flags.maxJobsToActivate
			? parseInt(flags.maxJobsToActivate, 10)
			: 10;
		const timeout = flags.timeout ? parseInt(flags.timeout, 10) : 60000;
		const worker = flags.worker || "c8ctl";

		if (Number.isNaN(maxJobsToActivate) || maxJobsToActivate < 1) {
			throw new Error("--maxJobsToActivate must be a positive integer");
		}
		if (Number.isNaN(timeout) || timeout < 1) {
			throw new Error("--timeout must be a positive integer (milliseconds)");
		}

		const dr = dryRun({
			command: "activate jobs",
			method: "POST",
			endpoint: "/jobs/activation",
			profile,
			body: {
				type,
				...(tenantId !== undefined && { tenantIds: [tenantId] }),
				maxJobsToActivate,
				timeout,
				worker,
			},
		});
		if (dr) return dr;

		const result = await client.activateJobs({
			type,
			...(tenantId !== undefined && {
				tenantIds: [TenantId.assumeExists(tenantId)],
			}),
			maxJobsToActivate,
			timeout,
			worker,
		});

		if (result.jobs && result.jobs.length > 0) {
			return {
				kind: "list",
				items: result.jobs.map((job) => ({
					Key: job.jobKey,
					Type: job.type,
					Retries: job.retries,
					"Process Instance": job.processInstanceKey,
				})),
				emptyMessage: "",
			};
		}
		return {
			kind: "info",
			message: `No jobs of type '${type}' available to activate`,
		};
	},
);

/**
 * Complete job
 */
export const completeJobCommand = defineCommand(
	"complete",
	"job",
	async (ctx, flags, args) => {
		const { client, profile } = ctx;
		const key = args.key;

		const body: Record<string, unknown> = {};
		let variables: Record<string, unknown> | undefined;
		if (flags.variables) {
			variables = JSON.parse(flags.variables);
			body.variables = variables;
		}

		const dr = dryRun({
			command: "complete job",
			method: "POST",
			endpoint: `/jobs/${key}/completion`,
			profile,
			body,
		});
		if (dr) return dr;

		await client.completeJob({
			jobKey: key,
			...(variables !== undefined && { variables }),
		});
		return { kind: "success", message: `Job ${key} completed` };
	},
);

/**
 * Fail job
 */
export const failJobCommand = defineCommand(
	"fail",
	"job",
	async (ctx, flags, args) => {
		const { client, profile } = ctx;
		const key = args.key;
		const retries = flags.retries ? parseInt(flags.retries, 10) : 0;
		const errorMessage = flags.errorMessage || "Job failed via c8ctl";

		if (Number.isNaN(retries) || retries < 0) {
			throw new Error("--retries must be a non-negative integer");
		}

		const dr = dryRun({
			command: "fail job",
			method: "POST",
			endpoint: `/jobs/${key}/failure`,
			profile,
			body: { retries, errorMessage },
		});
		if (dr) return dr;

		await client.failJob({
			jobKey: key,
			retries,
			errorMessage,
		});
		return { kind: "success", message: `Job ${key} failed` };
	},
);
