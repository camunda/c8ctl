/**
 * User task commands
 */

import { fetchAllPages } from "../client.ts";
import { defineCommand, dryRun } from "../command-framework.ts";
import { buildDateFilter, parseBetween } from "../date-filter.ts";

/**
 * List user tasks
 */
export const listUserTasksCommand = defineCommand(
	"list",
	"user-task",
	async (ctx, flags) => {
		const {
			client,
			logger,
			tenantId,
			profile,
			limit,
			all,
			between,
			dateField,
		} = ctx;

		const filter: { filter: Record<string, unknown> } = {
			filter: {
				tenantId,
			},
		};

		if (flags.state) {
			filter.filter.state = flags.state;
		} else if (!all) {
			// By default, exclude COMPLETED tasks unless --all is specified
			filter.filter.state = "CREATED";
		}

		if (flags.assignee) {
			filter.filter.assignee = flags.assignee;
		}

		if (between) {
			const parsed = parseBetween(between);
			if (parsed) {
				const field = dateField ?? "creationDate";
				filter.filter[field] = buildDateFilter(parsed.from, parsed.to);
			} else {
				logger.error(
					"Invalid --between value. Expected format: <from>..<to> (e.g. 2024-01-01..2024-12-31, ISO 8601 datetimes, or open-ended: ..2024-12-31 or 2024-01-01..)",
				);
				process.exit(1);
			}
		}

		const dr = dryRun({
			command: "list user-tasks",
			method: "POST",
			endpoint: "/user-tasks/search",
			profile,
			body: filter,
		});
		if (dr) return dr;

		const allItems = await fetchAllPages(
			(f, opts) => client.searchUserTasks(f, opts),
			filter,
			undefined,
			limit,
		);

		return {
			kind: "list",
			items: allItems.map((task) => ({
				Key: task.userTaskKey,
				Name: task.name || task.elementId,
				State: task.state,
				Assignee: task.assignee || "(unassigned)",
				Created: task.creationDate || "-",
				"Process Instance": task.processInstanceKey,
				"Tenant ID": task.tenantId,
			})),
			emptyMessage: "No user tasks found",
		};
	},
);

/**
 * Complete user task
 */
export const completeUserTaskCommand = defineCommand(
	"complete",
	"user-task",
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
			command: "complete user-task",
			method: "POST",
			endpoint: `/user-tasks/${key}/completion`,
			profile,
			body,
		});
		if (dr) return dr;

		await client.completeUserTask({
			userTaskKey: key,
			...(variables !== undefined && { variables }),
		});
		return { kind: "success", message: `User task ${key} completed` };
	},
);
