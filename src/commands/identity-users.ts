/**
 * Identity user commands
 */

import { Username } from "@camunda8/orchestration-cluster-api";
import { createClient, emitDryRun, fetchAllPages } from "../client.ts";
import { resolveClusterConfig } from "../config.ts";
import { handleCommandError } from "../errors.ts";
import { getLogger, type SortOrder, sortTableData } from "../logger.ts";
import { c8ctl } from "../runtime.ts";
import { toStringFilter } from "./search.ts";

/**
 * List all users
 */
export async function listUsers(options: {
	profile?: string;
	sortBy?: string;
	sortOrder?: SortOrder;
	limit?: number;
}): Promise<void> {
	const logger = getLogger();
	const client = createClient(options.profile);

	if (
		emitDryRun({
			command: "list users",
			method: "POST",
			endpoint: "/users/search",
			profile: options.profile,
			body: {},
		})
	)
		return;

	try {
		const items = await fetchAllPages(
			(filter, opts) => client.searchUsers(filter, opts),
			{},
			undefined,
			options.limit,
		);

		if (items.length === 0) {
			logger.info("No users found");
			return;
		}

		let tableData = items.map((u) => ({
			Username: u.username ?? "",
			Name: u.name ?? "",
			Email: u.email ?? "",
		}));
		tableData = sortTableData(
			tableData,
			options.sortBy,
			logger,
			options.sortOrder,
		);
		logger.table(tableData);
	} catch (error) {
		handleCommandError(logger, "Failed to list users", error);
	}
}

/**
 * Search users with filters
 */
export async function searchIdentityUsers(options: {
	profile?: string;
	username?: string;
	name?: string;
	email?: string;
	sortBy?: string;
	sortOrder?: SortOrder;
	limit?: number;
}): Promise<void> {
	const logger = getLogger();
	const client = createClient(options.profile);

	try {
		const filter: Record<string, unknown> = {};
		if (options.username) filter.username = toStringFilter(options.username);
		if (options.name) filter.name = toStringFilter(options.name);
		if (options.email) filter.email = toStringFilter(options.email);

		const searchFilter = Object.keys(filter).length > 0 ? { filter } : {};

		if (
			emitDryRun({
				command: "search users",
				method: "POST",
				endpoint: "/users/search",
				profile: options.profile,
				body: searchFilter,
			})
		)
			return;

		const items = await fetchAllPages(
			(f, opts) => client.searchUsers(f, opts),
			searchFilter,
			undefined,
			options.limit,
		);

		if (items.length === 0) {
			logger.info("No users found");
			return;
		}

		let tableData = items.map((u) => ({
			Username: u.username ?? "",
			Name: u.name ?? "",
			Email: u.email ?? "",
		}));
		tableData = sortTableData(
			tableData,
			options.sortBy,
			logger,
			options.sortOrder,
		);
		logger.table(tableData);
	} catch (error) {
		handleCommandError(logger, "Failed to search users", error);
	}
}

/**
 * Get a single user by username
 */
export async function getIdentityUser(
	username: string,
	options: {
		profile?: string;
	},
): Promise<void> {
	const logger = getLogger();
	const client = createClient(options.profile);

	if (
		emitDryRun({
			command: "get user",
			method: "GET",
			endpoint: `/users/${username}`,
			profile: options.profile,
		})
	)
		return;

	try {
		const result = await client.getUser(
			{ username: Username.assumeExists(username) },
			{ consistency: { waitUpToMs: 0 } },
		);
		logger.json(result);
	} catch (error) {
		handleCommandError(logger, `Failed to get user '${username}'`, error);
	}
}

/**
 * Create a new user
 */
export async function createIdentityUser(options: {
	profile?: string;
	username?: string;
	name?: string;
	email?: string;
	password?: string;
}): Promise<void> {
	const logger = getLogger();

	if (!options.username) {
		logger.error("--username is required");
		process.exit(1);
	}
	if (!options.password) {
		logger.error("--password is required");
		process.exit(1);
	}

	const body = {
		username: options.username,
		password: options.password,
		...(options.name ? { name: options.name } : {}),
		...(options.email ? { email: options.email } : {}),
	};

	if (c8ctl.dryRun) {
		const config = resolveClusterConfig(options.profile);
		logger.json({
			dryRun: true,
			command: "create user",
			method: "POST",
			url: `${config.baseUrl}/users`,
			body,
		});
		return;
	}

	const client = createClient(options.profile);

	try {
		await client.createUser(body);
		logger.success(`User '${options.username}' created`);
	} catch (error) {
		handleCommandError(logger, "Failed to create user", error);
	}
}

/**
 * Delete a user by username
 */
export async function deleteIdentityUser(
	username: string,
	options: {
		profile?: string;
	},
): Promise<void> {
	const logger = getLogger();

	if (c8ctl.dryRun) {
		const config = resolveClusterConfig(options.profile);
		logger.json({
			dryRun: true,
			command: "delete user",
			method: "DELETE",
			url: `${config.baseUrl}/users/${encodeURIComponent(username)}`,
			body: null,
		});
		return;
	}

	const client = createClient(options.profile);

	try {
		await client.deleteUser({ username: Username.assumeExists(username) });
		logger.success(`User '${username}' deleted`);
	} catch (error) {
		handleCommandError(logger, `Failed to delete user '${username}'`, error);
	}
}
