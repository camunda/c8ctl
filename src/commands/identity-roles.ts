/**
 * Identity role commands — CLI bindings of the role services.
 */

import { defineServiceCommand } from "../framework/index.ts";
import {
	createRole,
	createRoleRequest,
	deleteRole,
	deleteRoleRequest,
	getRole,
	getRoleRequest,
	listRoles,
	listRolesRequest,
	searchRoles,
	searchRolesRequest,
} from "../services/index.ts";

/** Table row of a role. */
function row(r: {
	roleId?: string | null;
	name?: string | null;
	description?: string | null;
}) {
	return {
		"Role ID": r.roleId ?? "",
		Name: r.name ?? "",
		Description: r.description ?? "",
	};
}

/**
 * List all roles
 */
export const listRolesCommand = defineServiceCommand("list", "role", {
	toInput: (_flags, _args, scope) => ({ limit: scope.limit }),
	dryRun: { command: "list roles", request: listRolesRequest },
	service: listRoles,
	render: ({ items }) => ({
		kind: "list",
		items: items.map(row),
		emptyMessage: "No roles found",
	}),
});

/**
 * Search roles with filters
 */
export const searchIdentityRolesCommand = defineServiceCommand(
	"search",
	"role",
	{
		toInput: (flags, _args, scope) => ({
			roleId: flags.roleId,
			name: flags.name,
			limit: scope.limit,
		}),
		dryRun: { command: "search roles", request: searchRolesRequest },
		service: searchRoles,
		render: ({ items }) => ({
			kind: "list",
			items: items.map(row),
			emptyMessage: "No roles found",
		}),
	},
);

/**
 * Get a single role by roleId
 */
export const getIdentityRoleCommand = defineServiceCommand("get", "role", {
	toInput: (_flags, args) => ({ roleId: args.roleId }),
	dryRun: { command: "get role", request: getRoleRequest },
	service: getRole,
	render: (role) => ({ kind: "get", data: role }),
});

/**
 * Create a new role
 */
export const createIdentityRoleCommand = defineServiceCommand(
	"create",
	"role",
	{
		toInput: (flags) => ({
			roleId: flags.roleId ?? "",
			name: flags.name ?? "",
		}),
		dryRun: { command: "create role", request: createRoleRequest },
		service: createRole,
		render: (_result, input) => ({
			kind: "success",
			message: `Role '${input.name}' created`,
		}),
	},
);

/**
 * Delete a role by roleId
 */
export const deleteIdentityRoleCommand = defineServiceCommand(
	"delete",
	"role",
	{
		toInput: (_flags, args) => ({ roleId: args.roleId }),
		dryRun: { command: "delete role", request: deleteRoleRequest },
		service: deleteRole,
		render: (_result, input) => ({
			kind: "success",
			message: `Role '${input.roleId}' deleted`,
		}),
	},
);
