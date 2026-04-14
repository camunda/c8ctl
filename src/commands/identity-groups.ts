/**
 * Identity group commands
 */

import { fetchAllPages } from "../client.ts";
import { defineCommand, dryRun } from "../command-framework.ts";
import { getLogger, sortTableData } from "../logger.ts";
import { toStringFilter } from "./search.ts";

/**
 * List all groups
 */
export const listGroupsCommand = defineCommand("list", "group", async (ctx) => {
	const { client, profile, limit } = ctx;

	const dr = dryRun({
		command: "list groups",
		method: "POST",
		endpoint: "/groups/search",
		profile,
		body: {},
	});
	if (dr) return dr;

	const items = await fetchAllPages(
		(filter, opts) => client.searchGroups(filter, opts),
		{},
		undefined,
		limit,
	);

	return {
		kind: "list",
		items: items.map((g) => ({
			"Group ID": g.groupId ?? "",
			Name: g.name ?? "",
			Description: g.description ?? "",
		})),
		emptyMessage: "No groups found",
	};
});
/**
 * Search groups with filters
 */
export const searchIdentityGroupsCommand = defineCommand(
	"search",
	"group",
	async (ctx, flags, _args) => {
		const { client, logger, profile, limit, sortBy, sortOrder } = ctx;

		const filter: Record<string, unknown> = {};
		if (flags.groupId) filter.groupId = toStringFilter(String(flags.groupId));
		if (flags.name) filter.name = flags.name;

		const searchFilter = Object.keys(filter).length > 0 ? { filter } : {};

		const dr = dryRun({
			command: "search groups",
			method: "POST",
			endpoint: "/groups/search",
			profile,
			body: searchFilter,
		});
		if (dr) return dr;

		const items = await fetchAllPages(
			(f, opts) => client.searchGroups(f, opts),
			searchFilter,
			undefined,
			limit,
		);

		if (items.length === 0) {
			logger.info("No groups found");
			return;
		}

		let tableData = items.map((g) => ({
			"Group ID": g.groupId ?? "",
			Name: g.name ?? "",
			Description: g.description ?? "",
		}));
		tableData = sortTableData(tableData, sortBy, logger, sortOrder);
		logger.table(tableData);
	},
);

/**
 * Get a single group by groupId
 */
export const getIdentityGroupCommand = defineCommand(
	"get",
	"group",
	async (ctx, _flags, args) => {
		const { client, profile } = ctx;
		const groupId = args.groupId;

		const dr = dryRun({
			command: "get group",
			method: "GET",
			endpoint: `/groups/${groupId}`,
			profile,
		});
		if (dr) return dr;

		const result = await client.getGroup(
			{ groupId },
			{ consistency: { waitUpToMs: 0 } },
		);
		return { kind: "get", data: result };
	},
);

/**
 * Create a new group
 */
export const createIdentityGroupCommand = defineCommand(
	"create",
	"group",
	async (ctx, flags, _args) => {
		const { client, profile } = ctx;

		if (!flags.groupId) {
			getLogger().error("--groupId is required");
			process.exit(1);
		}
		if (!flags.name) {
			getLogger().error("--name is required");
			process.exit(1);
		}

		const body = { groupId: flags.groupId, name: flags.name };

		const dr = dryRun({
			command: "create group",
			method: "POST",
			endpoint: "/groups",
			profile,
			body,
		});
		if (dr) return dr;

		await client.createGroup(body);
		return { kind: "success", message: `Group '${flags.name}' created` };
	},
);

/**
 * Delete a group by groupId
 */
export const deleteIdentityGroupCommand = defineCommand(
	"delete",
	"group",
	async (ctx, _flags, args) => {
		const { client, profile } = ctx;
		const groupId = args.groupId;

		const dr = dryRun({
			command: "delete group",
			method: "DELETE",
			endpoint: `/groups/${encodeURIComponent(groupId)}`,
			profile,
			body: null,
		});
		if (dr) return dr;

		await client.deleteGroup({ groupId });
		return { kind: "success", message: `Group '${groupId}' deleted` };
	},
);
