/**
 * Identity user commands
 */

import { fetchAllPages } from "../client.ts";
import { defineCommand, dryRun } from "../command-framework.ts";
import { sortTableData } from "../logger.ts";
import { toStringFilter } from "./search.ts";

/**
 * List all users
 */
export const listUsersCommand = defineCommand("list", "user", async (ctx) => {
	const { client, profile, limit } = ctx;

	const dr = dryRun({
		command: "list users",
		method: "POST",
		endpoint: "/users/search",
		profile,
		body: {},
	});
	if (dr) return dr;

	const items = await fetchAllPages(
		(filter, opts) => client.searchUsers(filter, opts),
		{},
		undefined,
		limit,
	);

	return {
		kind: "list",
		items: items.map((u) => ({
			Username: u.username ?? "",
			Name: u.name ?? "",
			Email: u.email ?? "",
		})),
		emptyMessage: "No users found",
	};
});
/**
 * Search users with filters
 */
export const searchIdentityUsersCommand = defineCommand(
	"search",
	"user",
	async (ctx, flags, _args) => {
		const { client, logger, profile, limit, sortBy, sortOrder } = ctx;

		const filter: Record<string, unknown> = {};
		if (flags.username)
			filter.username = toStringFilter(String(flags.username));
		if (flags.name) filter.name = toStringFilter(String(flags.name));
		if (flags.email) filter.email = toStringFilter(String(flags.email));

		const searchFilter = Object.keys(filter).length > 0 ? { filter } : {};

		const dr = dryRun({
			command: "search users",
			method: "POST",
			endpoint: "/users/search",
			profile,
			body: searchFilter,
		});
		if (dr) return dr;

		const items = await fetchAllPages(
			(f, opts) => client.searchUsers(f, opts),
			searchFilter,
			undefined,
			limit,
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
		tableData = sortTableData(tableData, sortBy, logger, sortOrder);
		logger.table(tableData);
	},
);

/**
 * Get a single user by username
 */
export const getIdentityUserCommand = defineCommand(
	"get",
	"user",
	async (ctx, _flags, args) => {
		const { client, profile } = ctx;
		const username = args.username;

		const dr = dryRun({
			command: "get user",
			method: "GET",
			endpoint: `/users/${username}`,
			profile,
		});
		if (dr) return dr;

		const result = await client.getUser(
			{ username },
			{ consistency: { waitUpToMs: 0 } },
		);
		return { kind: "get", data: result };
	},
);

/**
 * Create a new user
 */
export const createIdentityUserCommand = defineCommand(
	"create",
	"user",
	async (ctx, flags, _args) => {
		const { client, logger, profile } = ctx;

		if (!flags.username) {
			logger.error("--username is required");
			process.exit(1);
		}
		if (!flags.password) {
			logger.error("--password is required");
			process.exit(1);
		}

		const body = {
			username: flags.username,
			password: flags.password,
			...(flags.name ? { name: flags.name } : {}),
			...(flags.email ? { email: flags.email } : {}),
		};

		const dr = dryRun({
			command: "create user",
			method: "POST",
			endpoint: "/users",
			profile,
			body,
		});
		if (dr) return dr;

		await client.createUser(body);
		return { kind: "success", message: `User '${flags.username}' created` };
	},
);

/**
 * Delete a user by username
 */
export const deleteIdentityUserCommand = defineCommand(
	"delete",
	"user",
	async (ctx, _flags, args) => {
		const { client, profile } = ctx;
		const username = args.username;

		const dr = dryRun({
			command: "delete user",
			method: "DELETE",
			endpoint: `/users/${encodeURIComponent(String(username))}`,
			profile,
			body: null,
		});
		if (dr) return dr;

		await client.deleteUser({ username });
		return { kind: "success", message: `User '${username}' deleted` };
	},
);
