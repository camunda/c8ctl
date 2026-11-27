/**
 * User task services: list, complete.
 */

import type { CamundaClient } from "@camunda8/orchestration-cluster-api";
import type { C8ctlContext, ClusterInput } from "../core/index.ts";
import {
	C8ctlError,
	callCluster,
	connect,
	fetchAllPages,
} from "../core/index.ts";
import { buildDateFilter, parseBetween } from "../utils/index.ts";

type UserTask = Awaited<ReturnType<CamundaClient["getUserTask"]>>;

export interface ListUserTasksInput {
	/** Task state. Default: `CREATED`, unless `all` is set. */
	state?: string;
	assignee?: string;
	/** Include tasks in every state (no default state filter). */
	all?: boolean;
	/** Date range `<from>..<to>`, e.g. `7d` or `2024-01-01..`. */
	between?: string;
	/** Date field `between` filters on. Default: `creationDate`. */
	dateField?: string;
	/** Maximum number of user tasks. Default: all. */
	limit?: number;
}

/** The search request `listUserTasks` sends. */
export function listUserTasksRequest(
	input: ListUserTasksInput,
	tenantId: string | undefined,
) {
	const filter: Record<string, unknown> = { tenantId };
	if (input.state) {
		filter.state = input.state;
	} else if (!input.all) {
		// By default, exclude COMPLETED tasks unless `all` is set
		filter.state = "CREATED";
	}
	if (input.assignee) filter.assignee = input.assignee;
	if (input.between) {
		const parsed = parseBetween(input.between);
		if (!parsed) {
			throw new C8ctlError(
				"invalid-input",
				"Invalid --between value. Expected format: <from>..<to> (e.g. 2024-01-01..2024-12-31, ISO 8601 datetimes, or open-ended: ..2024-12-31 or 2024-01-01..)",
				{ field: "between" },
			);
		}
		filter[input.dateField ?? "creationDate"] = buildDateFilter(
			parsed.from,
			parsed.to,
		);
	}
	return { method: "POST", endpoint: "/user-tasks/search", body: { filter } };
}

export async function listUserTasks(
	input: ListUserTasksInput & ClusterInput,
	ctx: C8ctlContext = {},
): Promise<{ items: UserTask[] }> {
	const { client, defaultTenantId } = connect(input.target, ctx);
	const { body } = listUserTasksRequest(
		input,
		input.tenantId ?? defaultTenantId,
	);
	const items = await callCluster(
		(signal) =>
			fetchAllPages(
				(filter, options) => client.searchUserTasks(filter, options),
				body,
				undefined,
				input.limit,
				signal,
			),
		ctx,
	);
	return { items };
}

export interface CompleteUserTaskInput {
	userTaskKey: string;
	variables?: Record<string, unknown>;
}

/** The request `completeUserTask` sends. */
export function completeUserTaskRequest(input: CompleteUserTaskInput) {
	return {
		method: "POST",
		endpoint: `/user-tasks/${input.userTaskKey}/completion`,
		body: {
			...(input.variables !== undefined && { variables: input.variables }),
		},
	};
}

export async function completeUserTask(
	input: CompleteUserTaskInput & ClusterInput,
	ctx: C8ctlContext = {},
): Promise<{ userTaskKey: string }> {
	const { client } = connect(input.target, ctx);
	const { body } = completeUserTaskRequest(input);
	await callCluster(
		() => client.completeUserTask({ userTaskKey: input.userTaskKey, ...body }),
		ctx,
	);
	return { userTaskKey: input.userTaskKey };
}
