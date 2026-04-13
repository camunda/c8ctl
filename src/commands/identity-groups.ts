/**
 * Identity group commands
 */

import { createClient, emitDryRun, fetchAllPages } from "../client.ts";
import { resolveClusterConfig } from "../config.ts";
import { handleCommandError } from "../errors.ts";
import { getLogger, type SortOrder, sortTableData } from "../logger.ts";
import { c8ctl } from "../runtime.ts";
import { toStringFilter } from "./search.ts";

/**
 * List all groups
 */
export async function listGroups(options: {
	profile?: string;
	sortBy?: string;
	sortOrder?: SortOrder;
	limit?: number;
}): Promise<void> {
	const logger = getLogger();
	const client = createClient(options.profile);

	if (emitDryRun({ command: "list groups", method: "POST", endpoint: "/groups/search", profile: options.profile, body: {} })) return;

	try {
		const items = await fetchAllPages(
			(filter, opts) => client.searchGroups(filter, opts),
			{},
			undefined,
			options.limit,
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
		tableData = sortTableData(
			tableData,
			options.sortBy,
			logger,
			options.sortOrder,
		);
		logger.table(tableData);
	} catch (error) {
		handleCommandError(logger, "Failed to list groups", error);
	}
}

/**
 * Search groups with filters
 */
export async function searchIdentityGroups(options: {
	profile?: string;
	groupId?: string;
	name?: string;
	sortBy?: string;
	sortOrder?: SortOrder;
	limit?: number;
}): Promise<void> {
	const logger = getLogger();
	const client = createClient(options.profile);

	try {
		const filter: Record<string, unknown> = {};
		if (options.groupId) filter.groupId = toStringFilter(options.groupId);
		if (options.name) filter.name = options.name;

		const searchFilter = Object.keys(filter).length > 0 ? { filter } : {};

		if (emitDryRun({ command: "search groups", method: "POST", endpoint: "/groups/search", profile: options.profile, body: searchFilter })) return;

		const items = await fetchAllPages(
			(f, opts) => client.searchGroups(f, opts),
			searchFilter,
			undefined,
			options.limit,
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
		tableData = sortTableData(
			tableData,
			options.sortBy,
			logger,
			options.sortOrder,
		);
		logger.table(tableData);
	} catch (error) {
		handleCommandError(logger, "Failed to search groups", error);
	}
}

/**
 * Get a single group by groupId
 */
export async function getIdentityGroup(
	groupId: string,
	options: {
		profile?: string;
	},
): Promise<void> {
	const logger = getLogger();
	const client = createClient(options.profile);

	if (emitDryRun({ command: "get group", method: "GET", endpoint: `/groups/${groupId}`, profile: options.profile })) return;

	try {
		const result = await client.getGroup(
			{ groupId: groupId },
			{ consistency: { waitUpToMs: 0 } },
		);
		logger.json(result);
	} catch (error) {
		handleCommandError(logger, `Failed to get group '${groupId}'`, error);
	}
}

/**
 * Create a new group
 */
export async function createIdentityGroup(options: {
	profile?: string;
	groupId?: string;
	name?: string;
}): Promise<void> {
	const logger = getLogger();

	if (!options.groupId) {
		logger.error("--groupId is required");
		process.exit(1);
	}
	if (!options.name) {
		logger.error("--name is required");
		process.exit(1);
	}

	const body = { groupId: options.groupId, name: options.name };

	if (c8ctl.dryRun) {
		const config = resolveClusterConfig(options.profile);
		logger.json({
			dryRun: true,
			command: "create group",
			method: "POST",
			url: `${config.baseUrl}/groups`,
			body,
		});
		return;
	}

	const client = createClient(options.profile);

	try {
		await client.createGroup(body);
		logger.success(`Group '${options.name}' created`);
	} catch (error) {
		handleCommandError(logger, "Failed to create group", error);
	}
}

/**
 * Delete a group by groupId
 */
export async function deleteIdentityGroup(
	groupId: string,
	options: {
		profile?: string;
	},
): Promise<void> {
	const logger = getLogger();

	if (c8ctl.dryRun) {
		const config = resolveClusterConfig(options.profile);
		logger.json({
			dryRun: true,
			command: "delete group",
			method: "DELETE",
			url: `${config.baseUrl}/groups/${encodeURIComponent(groupId)}`,
			body: null,
		});
		return;
	}

	const client = createClient(options.profile);

	try {
		await client.deleteGroup({ groupId: groupId });
		logger.success(`Group '${groupId}' deleted`);
	} catch (error) {
		handleCommandError(logger, `Failed to delete group '${groupId}'`, error);
	}
}
