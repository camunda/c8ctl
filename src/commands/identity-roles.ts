/**
 * Identity role commands
 */

import { fetchAllPages } from "../client.ts";
import { defineCommand, dryRun } from "../command-framework.ts";
import { getLogger, sortTableData } from "../logger.ts";

/**
 * List all roles
 */
export const listRolesCommand = defineCommand("list", "role", async (ctx) => {
	const { client, profile, limit } = ctx;

	const dr = dryRun({
		command: "list roles",
		method: "POST",
		endpoint: "/roles/search",
		profile,
		body: {},
	});
	if (dr) return dr;

	const items = await fetchAllPages(
		(filter, opts) => client.searchRoles(filter, opts),
		{},
		undefined,
		limit,
	);

	return {
		kind: "list",
		items: items.map((r) => ({
			"Role ID": r.roleId ?? "",
			Name: r.name ?? "",
			Description: r.description ?? "",
		})),
		emptyMessage: "No roles found",
	};
});
/**
 * Search roles with filters
 */
export const searchIdentityRolesCommand = defineCommand(
	"search",
	"role",
	async (ctx, flags, _args) => {
		const { client, logger, profile, limit, sortBy, sortOrder } = ctx;

		const filter: Record<string, unknown> = {};
		if (flags.roleId) filter.roleId = flags.roleId;
		if (flags.name) filter.name = flags.name;

		const searchFilter = Object.keys(filter).length > 0 ? { filter } : {};

		const dr = dryRun({
			command: "search roles",
			method: "POST",
			endpoint: "/roles/search",
			profile,
			body: searchFilter,
		});
		if (dr) return dr;

		const items = await fetchAllPages(
			(f, opts) => client.searchRoles(f, opts),
			searchFilter,
			undefined,
			limit,
		);

		if (items.length === 0) {
			logger.info("No roles found");
			return;
		}

		let tableData = items.map((r) => ({
			"Role ID": r.roleId ?? "",
			Name: r.name ?? "",
			Description: r.description ?? "",
		}));
		tableData = sortTableData(tableData, sortBy, logger, sortOrder);
		logger.table(tableData);
	},
);

/**
 * Get a single role by roleId
 */
export const getIdentityRoleCommand = defineCommand(
	"get",
	"role",
	async (ctx, _flags, args) => {
		const { client, profile } = ctx;
		const roleId = args.roleId;

		const dr = dryRun({
			command: "get role",
			method: "GET",
			endpoint: `/roles/${roleId}`,
			profile,
		});
		if (dr) return dr;

		const result = await client.getRole(
			{ roleId },
			{ consistency: { waitUpToMs: 0 } },
		);
		return { kind: "get", data: result };
	},
);

/**
 * Create a new role
 */
export const createIdentityRoleCommand = defineCommand(
	"create",
	"role",
	async (ctx, flags, _args) => {
		const { client, profile } = ctx;

		if (!flags.roleId) {
			getLogger().error("--roleId is required");
			process.exit(1);
		}
		if (!flags.name) {
			getLogger().error("--name is required");
			process.exit(1);
		}

		const body = { roleId: flags.roleId, name: flags.name };

		const dr = dryRun({
			command: "create role",
			method: "POST",
			endpoint: "/roles",
			profile,
			body,
		});
		if (dr) return dr;

		await client.createRole(body);
		return { kind: "success", message: `Role '${flags.name}' created` };
	},
);

/**
 * Delete a role by roleId
 */
export const deleteIdentityRoleCommand = defineCommand(
	"delete",
	"role",
	async (ctx, _flags, args) => {
		const { client, profile } = ctx;
		const roleId = args.roleId;

		const dr = dryRun({
			command: "delete role",
			method: "DELETE",
			endpoint: `/roles/${encodeURIComponent(roleId)}`,
			profile,
			body: null,
		});
		if (dr) return dr;

		await client.deleteRole({ roleId });
		return { kind: "success", message: `Role '${roleId}' deleted` };
	},
);
