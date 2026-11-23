/**
 * User task commands — CLI bindings of the user task services.
 */

import { defineServiceCommand } from "../framework/index.ts";
import {
	completeUserTask,
	completeUserTaskRequest,
	listUserTasks,
	listUserTasksRequest,
} from "../services/index.ts";
import { parseVariablesFlag } from "../utils/index.ts";

/**
 * List user tasks
 */
export const listUserTasksCommand = defineServiceCommand("list", "user-task", {
	toInput: (flags, _args, scope) => ({
		state: flags.state,
		assignee: flags.assignee,
		all: scope.all,
		between: scope.between,
		dateField: scope.dateField,
		limit: scope.limit,
	}),
	dryRun: { command: "list user-tasks", request: listUserTasksRequest },
	service: listUserTasks,
	render: ({ items }) => ({
		kind: "list",
		items: items.map((task) => ({
			Key: task.userTaskKey,
			Name: task.name || task.elementId,
			State: task.state,
			Assignee: task.assignee || "(unassigned)",
			Created: task.creationDate || "-",
			"Process Instance": task.processInstanceKey,
			"Tenant ID": task.tenantId,
		})),
		emptyMessage: "No user tasks found",
	}),
});

/**
 * Complete user task
 */
export const completeUserTaskCommand = defineServiceCommand(
	"complete",
	"user-task",
	{
		toInput: (flags, args) => ({
			userTaskKey: args.key,
			variables: flags.variables
				? parseVariablesFlag({ raw: flags.variables })
				: undefined,
		}),
		dryRun: { command: "complete user-task", request: completeUserTaskRequest },
		service: completeUserTask,
		render: ({ userTaskKey }) => ({
			kind: "success",
			message: `User task ${userTaskKey} completed`,
		}),
	},
);
