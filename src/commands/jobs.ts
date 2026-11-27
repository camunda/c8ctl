/**
 * Job commands — CLI bindings of the job services.
 */

import {
	clusterInputOf,
	defineCommand,
	defineServiceCommand,
} from "../framework/index.ts";
import {
	activateJobs,
	activateJobsRequest,
	completeJob,
	completeJobRequest,
	failJob,
	failJobRequest,
	listJobs,
	listJobsRequest,
	updateJob,
	updateJobRequest,
} from "../services/index.ts";
import { parseVariablesFlag } from "../utils/index.ts";

/** Parse an optional integer flag; an absent or empty flag is `undefined`. */
function intFlag(value: string | undefined): number | undefined {
	return value ? parseInt(value, 10) : undefined;
}

/**
 * List jobs
 */
export const listJobsCommand = defineServiceCommand("list", "jobs", {
	toInput: (flags, _args, scope) => ({
		state: flags.state,
		type: flags.type,
		between: scope.between,
		dateField: scope.dateField,
		limit: scope.limit,
	}),
	dryRun: { command: "list jobs", request: listJobsRequest },
	service: listJobs,
	render: ({ items }) => ({
		kind: "list",
		items: items.map((job) => ({
			Key: job.jobKey,
			Type: job.type,
			State: job.state,
			Retries: job.retries,
			Created: job.creationTime || "-",
			"Process Instance": job.processInstanceKey,
			"Tenant ID": job.tenantId,
		})),
		emptyMessage: "No jobs found",
	}),
});

/**
 * Activate jobs. A plain handler: `--customHeaders` only changes the
 * table, it is not part of the request.
 */
export const activateJobsCommand = defineCommand(
	"activate",
	"jobs",
	async (ctx, flags, args) => {
		const type = args.type;
		const input = {
			type,
			maxJobsToActivate: intFlag(flags.maxJobsToActivate),
			timeout: intFlag(flags.timeout),
			worker: flags.worker,
			fetchVariable: flags.fetchVariable
				?.split(",")
				.map((name) => name.trim())
				.filter(Boolean),
		};

		const dr = ctx.dryRun({
			command: "activate jobs",
			profile: ctx.profile,
			...activateJobsRequest(input, ctx.tenantId),
		});
		if (dr) return dr;

		const result = await activateJobs({ ...input, ...clusterInputOf(ctx) }, {});

		if (result.jobs && result.jobs.length > 0) {
			return {
				kind: "list",
				items: result.jobs.map((job) => ({
					Key: job.jobKey,
					Type: job.type,
					Retries: job.retries,
					"Process Instance": job.processInstanceKey,
					"Element Instance": job.elementInstanceKey,
					...(flags.customHeaders && {
						"Custom Headers": job.customHeaders,
					}),
					...(input.fetchVariable && {
						Variables: job.variables,
					}),
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
export const completeJobCommand = defineServiceCommand("complete", "job", {
	toInput: (flags, args) => ({
		jobKey: args.key,
		variables: flags.variables
			? parseVariablesFlag({ raw: flags.variables })
			: undefined,
	}),
	dryRun: { command: "complete job", request: completeJobRequest },
	service: completeJob,
	render: ({ jobKey }) => ({
		kind: "success",
		message: `Job ${jobKey} completed`,
	}),
});

/**
 * Fail job
 */
export const failJobCommand = defineServiceCommand("fail", "job", {
	toInput: (flags, args) => ({
		jobKey: args.key,
		retries: intFlag(flags.retries),
		errorMessage: flags.errorMessage,
	}),
	dryRun: { command: "fail job", request: failJobRequest },
	service: failJob,
	render: ({ jobKey }) => ({
		kind: "success",
		message: `Job ${jobKey} failed`,
	}),
});

/**
 * Update job
 */
export const updateJobCommand = defineServiceCommand("update", "job", {
	toInput: (flags, args) => ({
		jobKey: args.key,
		retries:
			flags.retries !== undefined ? parseInt(flags.retries, 10) : undefined,
		timeout:
			flags.timeout !== undefined ? parseInt(flags.timeout, 10) : undefined,
		operationReference:
			flags.operationReference !== undefined
				? parseInt(flags.operationReference, 10)
				: undefined,
	}),
	dryRun: { command: "update job", request: updateJobRequest },
	service: updateJob,
	render: ({ jobKey }) => ({
		kind: "success",
		message: `Job ${jobKey} updated`,
	}),
});
