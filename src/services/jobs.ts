/**
 * Job services: list, activate, complete, fail, update.
 */

import {
	type CamundaClient,
	TenantId,
} from "@camunda8/orchestration-cluster-api";
import type { C8ctlContext, ClusterInput } from "../core/index.ts";
import {
	brandInput,
	C8ctlError,
	callCluster,
	connect,
	fetchAllPages,
} from "../core/index.ts";
import { buildDateFilter, parseBetween } from "../utils/index.ts";

type Job = Awaited<ReturnType<CamundaClient["searchJobs"]>>["items"][number];

function invalid(field: string, message: string): C8ctlError {
	return new C8ctlError("invalid-input", message, { field });
}

// ─── list ────────────────────────────────────────────────────────────────────

export interface ListJobsInput {
	/** Job state, e.g. `CREATED`. */
	state?: string;
	/** Job type. */
	type?: string;
	/** Date range `<from>..<to>`, e.g. `7d` or `2024-01-01..`. */
	between?: string;
	/** Date field `between` filters on. Default: `creationTime`. */
	dateField?: string;
	/** Maximum number of jobs. Default: all. */
	limit?: number;
}

/** The search request `listJobs` sends. */
export function listJobsRequest(
	input: ListJobsInput,
	tenantId: string | undefined,
) {
	const filter: Record<string, unknown> = { tenantId };
	if (input.state) filter.state = input.state;
	if (input.type) filter.type = input.type;
	if (input.between) {
		const parsed = parseBetween(input.between);
		if (!parsed) {
			throw invalid(
				"between",
				"Invalid --between value. Expected format: <from>..<to> (e.g. 2024-01-01..2024-12-31, ISO 8601 datetimes, or open-ended: ..2024-12-31 or 2024-01-01..)",
			);
		}
		filter[input.dateField ?? "creationTime"] = buildDateFilter(
			parsed.from,
			parsed.to,
		);
	}
	return { method: "POST", endpoint: "/jobs/search", body: { filter } };
}

export async function listJobs(
	input: ListJobsInput & ClusterInput,
	ctx: C8ctlContext = {},
): Promise<{ items: Job[] }> {
	const { client, defaultTenantId } = connect(input.target, ctx);
	const { body } = listJobsRequest(input, input.tenantId ?? defaultTenantId);
	const items = await callCluster(
		(signal) =>
			fetchAllPages(
				(filter, options) => client.searchJobs(filter, options),
				body,
				undefined,
				input.limit,
				signal,
			),
		ctx,
	);
	return { items };
}

// ─── activate ────────────────────────────────────────────────────────────────

export interface ActivateJobsInput {
	/** Job type. */
	type: string;
	/** Default: 10. */
	maxJobsToActivate?: number;
	/** Lock timeout in milliseconds. Default: 60000. */
	timeout?: number;
	/** Worker name. Default: `c8ctl`. */
	worker?: string;
	/** Variables to fetch. Must not be empty: an empty list fetches all. */
	fetchVariable?: string[];
}

/** The request `activateJobs` sends. */
export function activateJobsRequest(
	input: ActivateJobsInput,
	tenantId: string | undefined,
) {
	// Per the REST spec an *empty* list means "return all visible
	// variables", which defeats the point, so reject it rather than
	// silently fetching all.
	if (input.fetchVariable !== undefined && input.fetchVariable.length === 0) {
		throw invalid(
			"fetchVariable",
			"--fetchVariable was given no valid variable names",
		);
	}
	const maxJobsToActivate = input.maxJobsToActivate ?? 10;
	const timeout = input.timeout ?? 60000;
	if (Number.isNaN(maxJobsToActivate) || maxJobsToActivate < 1) {
		throw invalid(
			"maxJobsToActivate",
			"--maxJobsToActivate must be a positive integer",
		);
	}
	if (Number.isNaN(timeout) || timeout < 1) {
		throw invalid(
			"timeout",
			"--timeout must be a positive integer (milliseconds)",
		);
	}
	const fetchVariable = input.fetchVariable;
	return {
		method: "POST",
		endpoint: "/jobs/activation",
		body: {
			type: input.type,
			...(tenantId !== undefined && { tenantIds: [tenantId] }),
			maxJobsToActivate,
			timeout,
			worker: input.worker || "c8ctl",
			...(fetchVariable && { fetchVariable }),
		},
	};
}

export async function activateJobs(
	input: ActivateJobsInput & ClusterInput,
	ctx: C8ctlContext = {},
) {
	const { client, defaultTenantId } = connect(input.target, ctx);
	const tenantId = input.tenantId ?? defaultTenantId;
	const { body } = activateJobsRequest(input, tenantId);
	return callCluster(
		() =>
			client.activateJobs({
				type: body.type,
				...(tenantId !== undefined && {
					tenantIds: [brandInput("tenantId", tenantId, TenantId.assumeExists)],
				}),
				maxJobsToActivate: body.maxJobsToActivate,
				timeout: body.timeout,
				worker: body.worker,
				...(body.fetchVariable && { fetchVariable: body.fetchVariable }),
			}),
		ctx,
	);
}

// ─── complete ────────────────────────────────────────────────────────────────

export interface CompleteJobInput {
	jobKey: string;
	variables?: Record<string, unknown>;
}

/** The request `completeJob` sends. */
export function completeJobRequest(input: CompleteJobInput) {
	return {
		method: "POST",
		endpoint: `/jobs/${input.jobKey}/completion`,
		body: {
			...(input.variables !== undefined && { variables: input.variables }),
		},
	};
}

export async function completeJob(
	input: CompleteJobInput & ClusterInput,
	ctx: C8ctlContext = {},
): Promise<{ jobKey: string }> {
	const { client } = connect(input.target, ctx);
	const { body } = completeJobRequest(input);
	await callCluster(
		() => client.completeJob({ jobKey: input.jobKey, ...body }),
		ctx,
	);
	return { jobKey: input.jobKey };
}

// ─── fail ────────────────────────────────────────────────────────────────────

export interface FailJobInput {
	jobKey: string;
	/** Retries left. Default: 0. */
	retries?: number;
	/** Default: `Job failed via c8ctl`. */
	errorMessage?: string;
}

/** The request `failJob` sends. */
export function failJobRequest(input: FailJobInput) {
	const retries = input.retries ?? 0;
	if (Number.isNaN(retries) || retries < 0) {
		throw invalid("retries", "--retries must be a non-negative integer");
	}
	return {
		method: "POST",
		endpoint: `/jobs/${input.jobKey}/failure`,
		body: {
			retries,
			errorMessage: input.errorMessage || "Job failed via c8ctl",
		},
	};
}

export async function failJob(
	input: FailJobInput & ClusterInput,
	ctx: C8ctlContext = {},
): Promise<{ jobKey: string }> {
	const { client } = connect(input.target, ctx);
	const { body } = failJobRequest(input);
	await callCluster(
		() => client.failJob({ jobKey: input.jobKey, ...body }),
		ctx,
	);
	return { jobKey: input.jobKey };
}

// ─── update ──────────────────────────────────────────────────────────────────

export interface UpdateJobInput {
	jobKey: string;
	retries?: number;
	/** Lock timeout in milliseconds. */
	timeout?: number;
	operationReference?: number;
}

/** The request `updateJob` sends. */
export function updateJobRequest(input: UpdateJobInput) {
	const { retries, timeout, operationReference } = input;
	if (retries !== undefined && (Number.isNaN(retries) || retries < 0)) {
		throw invalid("retries", "--retries must be a non-negative integer");
	}
	if (timeout !== undefined && (Number.isNaN(timeout) || timeout < 1)) {
		throw invalid(
			"timeout",
			"--timeout must be a positive integer (milliseconds)",
		);
	}
	if (retries === undefined && timeout === undefined) {
		throw invalid(
			"retries",
			"At least one of --retries or --timeout must be provided",
		);
	}
	if (
		operationReference !== undefined &&
		(Number.isNaN(operationReference) || operationReference < 0)
	) {
		throw invalid(
			"operationReference",
			"--operationReference must be a non-negative integer",
		);
	}

	const changeset: { retries?: number; timeout?: number } = {};
	if (retries !== undefined) changeset.retries = retries;
	if (timeout !== undefined) changeset.timeout = timeout;
	return {
		method: "PATCH",
		endpoint: `/jobs/${input.jobKey}`,
		body: {
			changeset,
			...(operationReference !== undefined && { operationReference }),
		},
	};
}

export async function updateJob(
	input: UpdateJobInput & ClusterInput,
	ctx: C8ctlContext = {},
): Promise<{ jobKey: string }> {
	const { client } = connect(input.target, ctx);
	const { body } = updateJobRequest(input);
	await callCluster(
		() => client.updateJob({ jobKey: input.jobKey, ...body }),
		ctx,
	);
	return { jobKey: input.jobKey };
}
