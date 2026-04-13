/**
 * User task commands
 */

import { UserTaskKey } from "@camunda8/orchestration-cluster-api";
import { createClient, fetchAllPages } from "../client.ts";
import { resolveClusterConfig, resolveTenantId } from "../config.ts";
import { buildDateFilter, parseBetween } from "../date-filter.ts";
import { handleCommandError } from "../errors.ts";
import { getLogger, type SortOrder, sortTableData } from "../logger.ts";
import { c8ctl } from "../runtime.ts";

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
		} else if (!options.all) {
			// By default, exclude COMPLETED tasks unless --all is specified
			filter.filter.state = "CREATED";
		}

		if (options.assignee) {
			filter.filter.assignee = options.assignee;
		}

		if (options.between) {
			const parsed = parseBetween(options.between);
			if (parsed) {
				const field = options.dateField ?? "creationDate";
				filter.filter[field] = buildDateFilter(parsed.from, parsed.to);
			} else {
				logger.error(
					"Invalid --between value. Expected format: <from>..<to> (e.g. 2024-01-01..2024-12-31, ISO 8601 datetimes, or open-ended: ..2024-12-31 or 2024-01-01..)",
				);
				process.exit(1);
			}
		}

		const allItems = await fetchAllPages(
			(f, opts) => client.searchUserTasks(f, opts),
			filter,
			undefined,
			options.limit,
		);

		if (allItems.length > 0) {
			let tableData = allItems.map((task) => ({
				Key: task.userTaskKey,
				Name: task.name || task.elementId,
				State: task.state,
				Assignee: task.assignee || "(unassigned)",
				Created: task.creationDate || "-",
				"Process Instance": task.processInstanceKey,
				"Tenant ID": task.tenantId,
			}));
			tableData = sortTableData(
				tableData,
				options.sortBy,
				logger,
				options.sortOrder,
			);
			logger.table(tableData);
		} else {
			logger.info("No user tasks found");
		}
	} catch (error) {
		handleCommandError(logger, "Failed to list user tasks", error);
	}
}

/**
 * Complete user task
 */
export async function completeUserTask(
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
			command: "complete user-task",
			method: "POST",
			url: `${config.baseUrl}/user-tasks/${key}/completion`,
			body,
		});
		return;
	}

	const client = createClient(options.profile);

	try {
		const variables = options.variables
			? JSON.parse(options.variables)
			: undefined;
		await client.completeUserTask({
			userTaskKey: UserTaskKey.assumeExists(key),
			...(variables !== undefined && { variables }),
		});
		logger.success(`User task ${key} completed`);
	} catch (error) {
		handleCommandError(logger, `Failed to complete user task ${key}`, error);
	}
}
