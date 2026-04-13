/**
 * Identity role commands
 */

import { createClient, emitDryRun, fetchAllPages } from "../client.ts";
import { resolveClusterConfig } from "../config.ts";
import { handleCommandError } from "../errors.ts";
import { getLogger, type SortOrder, sortTableData } from "../logger.ts";
import { c8ctl } from "../runtime.ts";

/**
 * List all roles
 */
export async function listRoles(options: {
	profile?: string;
	sortBy?: string;
	sortOrder?: SortOrder;
	limit?: number;
}): Promise<void> {
	const logger = getLogger();
	const client = createClient(options.profile);

	if (emitDryRun({ command: "list roles", method: "POST", endpoint: "/roles/search", profile: options.profile, body: {} })) return;

	try {
		const items = await fetchAllPages(
			(filter, opts) => client.searchRoles(filter, opts),
			{},
			undefined,
			options.limit,
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
		tableData = sortTableData(
			tableData,
			options.sortBy,
			logger,
			options.sortOrder,
		);
		logger.table(tableData);
	} catch (error) {
		handleCommandError(logger, "Failed to list roles", error);
	}
}

/**
 * Search roles with filters
 */
export async function searchIdentityRoles(options: {
	profile?: string;
	roleId?: string;
	name?: string;
	sortBy?: string;
	sortOrder?: SortOrder;
	limit?: number;
}): Promise<void> {
	const logger = getLogger();
	const client = createClient(options.profile);

	try {
		const filter: Record<string, unknown> = {};
		if (options.roleId) filter.roleId = options.roleId;
		if (options.name) filter.name = options.name;

		const searchFilter = Object.keys(filter).length > 0 ? { filter } : {};

		if (emitDryRun({ command: "search roles", method: "POST", endpoint: "/roles/search", profile: options.profile, body: searchFilter })) return;

		const items = await fetchAllPages(
			(f, opts) => client.searchRoles(f, opts),
			searchFilter,
			undefined,
			options.limit,
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
		tableData = sortTableData(
			tableData,
			options.sortBy,
			logger,
			options.sortOrder,
		);
		logger.table(tableData);
	} catch (error) {
		handleCommandError(logger, "Failed to search roles", error);
	}
}

/**
 * Get a single role by roleId
 */
export async function getIdentityRole(
	roleId: string,
	options: {
		profile?: string;
	},
): Promise<void> {
	const logger = getLogger();
	const client = createClient(options.profile);

	if (emitDryRun({ command: "get role", method: "GET", endpoint: `/roles/${roleId}`, profile: options.profile })) return;

	try {
		const result = await client.getRole(
			{ roleId: roleId },
			{ consistency: { waitUpToMs: 0 } },
		);
		logger.json(result);
	} catch (error) {
		handleCommandError(logger, `Failed to get role '${roleId}'`, error);
	}
}

/**
 * Create a new role
 */
export async function createIdentityRole(options: {
	profile?: string;
	roleId?: string;
	name?: string;
}): Promise<void> {
	const logger = getLogger();

	if (!options.roleId) {
		logger.error("--roleId is required");
		process.exit(1);
	}
	if (!options.name) {
		logger.error("--name is required");
		process.exit(1);
	}

	const body = { roleId: options.roleId, name: options.name };

	if (c8ctl.dryRun) {
		const config = resolveClusterConfig(options.profile);
		logger.json({
			dryRun: true,
			command: "create role",
			method: "POST",
			url: `${config.baseUrl}/roles`,
			body,
		});
		return;
	}

	const client = createClient(options.profile);

	try {
		await client.createRole(body);
		logger.success(`Role '${options.name}' created`);
	} catch (error) {
		handleCommandError(logger, "Failed to create role", error);
	}
}

/**
 * Delete a role by roleId
 */
export async function deleteIdentityRole(
	roleId: string,
	options: {
		profile?: string;
	},
): Promise<void> {
	const logger = getLogger();

	if (c8ctl.dryRun) {
		const config = resolveClusterConfig(options.profile);
		logger.json({
			dryRun: true,
			command: "delete role",
			method: "DELETE",
			url: `${config.baseUrl}/roles/${encodeURIComponent(roleId)}`,
			body: null,
		});
		return;
	}

	const client = createClient(options.profile);

	try {
		await client.deleteRole({ roleId: roleId });
		logger.success(`Role '${roleId}' deleted`);
	} catch (error) {
		handleCommandError(logger, `Failed to delete role '${roleId}'`, error);
	}
}
