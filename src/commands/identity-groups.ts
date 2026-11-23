/**
 * Identity group commands — CLI bindings of the group services.
 */

import { defineServiceCommand } from "../framework/index.ts";
import {
	createGroup,
	createGroupRequest,
	deleteGroup,
	deleteGroupRequest,
	getGroup,
	getGroupRequest,
	listGroups,
	listGroupsRequest,
	searchGroups,
	searchGroupsRequest,
} from "../services/index.ts";

/** Table row of a group. */
function row(g: {
	groupId?: string | null;
	name?: string | null;
	description?: string | null;
}) {
	return {
		"Group ID": g.groupId ?? "",
		Name: g.name ?? "",
		Description: g.description ?? "",
	};
}

/**
 * List all groups
 */
export const listGroupsCommand = defineServiceCommand("list", "group", {
	toInput: (_flags, _args, scope) => ({ limit: scope.limit }),
	dryRun: { command: "list groups", request: listGroupsRequest },
	service: listGroups,
	render: ({ items }) => ({
		kind: "list",
		items: items.map(row),
		emptyMessage: "No groups found",
	}),
});

/**
 * Search groups with filters
 */
export const searchIdentityGroupsCommand = defineServiceCommand(
	"search",
	"group",
	{
		toInput: (flags, _args, scope) => ({
			groupId: flags.groupId,
			name: flags.name,
			limit: scope.limit,
		}),
		dryRun: { command: "search groups", request: searchGroupsRequest },
		service: searchGroups,
		render: ({ items }) => ({
			kind: "list",
			items: items.map(row),
			emptyMessage: "No groups found",
		}),
	},
);

/**
 * Get a single group by groupId
 */
export const getIdentityGroupCommand = defineServiceCommand("get", "group", {
	toInput: (_flags, args) => ({ groupId: args.groupId }),
	dryRun: { command: "get group", request: getGroupRequest },
	service: getGroup,
	render: (group) => ({ kind: "get", data: group }),
});

/**
 * Create a new group
 */
export const createIdentityGroupCommand = defineServiceCommand(
	"create",
	"group",
	{
		toInput: (flags) => ({
			groupId: flags.groupId ?? "",
			name: flags.name ?? "",
		}),
		dryRun: { command: "create group", request: createGroupRequest },
		service: createGroup,
		render: (_result, input) => ({
			kind: "success",
			message: `Group '${input.name}' created`,
		}),
	},
);

/**
 * Delete a group by groupId
 */
export const deleteIdentityGroupCommand = defineServiceCommand(
	"delete",
	"group",
	{
		toInput: (_flags, args) => ({ groupId: args.groupId }),
		dryRun: { command: "delete group", request: deleteGroupRequest },
		service: deleteGroup,
		render: (_result, input) => ({
			kind: "success",
			message: `Group '${input.groupId}' deleted`,
		}),
	},
);
