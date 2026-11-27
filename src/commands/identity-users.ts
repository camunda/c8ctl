/**
 * Identity user commands — CLI bindings of the user services.
 */

import { defineServiceCommand } from "../framework/index.ts";
import {
	createUser,
	createUserRequest,
	deleteUser,
	deleteUserRequest,
	getUser,
	getUserRequest,
	listUsers,
	listUsersRequest,
	searchUsers,
	searchUsersRequest,
} from "../services/index.ts";

/** Table row of a user. */
function row(u: {
	username?: string | null;
	name?: string | null;
	email?: string | null;
}) {
	return {
		Username: u.username ?? "",
		Name: u.name ?? "",
		Email: u.email ?? "",
	};
}

/**
 * List all users
 */
export const listUsersCommand = defineServiceCommand("list", "user", {
	toInput: (_flags, _args, scope) => ({ limit: scope.limit }),
	dryRun: { command: "list users", request: listUsersRequest },
	service: listUsers,
	render: ({ items }) => ({
		kind: "list",
		items: items.map(row),
		emptyMessage: "No users found",
	}),
});

/**
 * Search users with filters
 */
export const searchIdentityUsersCommand = defineServiceCommand(
	"search",
	"user",
	{
		toInput: (flags, _args, scope) => ({
			username: flags.username,
			name: flags.name,
			email: flags.email,
			limit: scope.limit,
		}),
		dryRun: { command: "search users", request: searchUsersRequest },
		service: searchUsers,
		render: ({ items }) => ({
			kind: "list",
			items: items.map(row),
			emptyMessage: "No users found",
		}),
	},
);

/**
 * Get a single user by username
 */
export const getIdentityUserCommand = defineServiceCommand("get", "user", {
	toInput: (_flags, args) => ({ username: args.username }),
	dryRun: { command: "get user", request: getUserRequest },
	service: getUser,
	render: (user) => ({ kind: "get", data: user }),
});

/**
 * Create a new user
 */
export const createIdentityUserCommand = defineServiceCommand(
	"create",
	"user",
	{
		toInput: (flags) => ({
			username: flags.username ?? "",
			password: flags.password ?? "",
			name: flags.name,
			email: flags.email,
		}),
		dryRun: { command: "create user", request: createUserRequest },
		service: createUser,
		render: ({ username }) => ({
			kind: "success",
			message: `User '${username}' created`,
		}),
	},
);

/**
 * Delete a user by username
 */
export const deleteIdentityUserCommand = defineServiceCommand(
	"delete",
	"user",
	{
		toInput: (_flags, args) => ({ username: args.username }),
		dryRun: { command: "delete user", request: deleteUserRequest },
		service: deleteUser,
		render: ({ username }) => ({
			kind: "success",
			message: `User '${username}' deleted`,
		}),
	},
);
