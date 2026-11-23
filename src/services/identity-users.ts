/**
 * Identity user services: list, search, get, create, delete.
 */

import {
	type CamundaClient,
	Username,
} from "@camunda8/orchestration-cluster-api";
import type { C8ctlContext, ClusterInput } from "../core/index.ts";
import {
	brandInput,
	callCluster,
	connect,
	fetchAllPages,
} from "../core/index.ts";
import { toStringFilter } from "../utils/index.ts";
import { requireInput, searchBodyOf } from "./identity-common.ts";

type User = Awaited<ReturnType<CamundaClient["searchUsers"]>>["items"][number];

export interface ListUsersInput {
	/** Maximum number of users. Default: all. */
	limit?: number;
}

export function listUsersRequest() {
	return { method: "POST", endpoint: "/users/search", body: {} };
}

export async function listUsers(
	input: ListUsersInput & ClusterInput,
	ctx: C8ctlContext = {},
): Promise<{ items: User[] }> {
	const { client } = connect(input.target, ctx);
	const items = await callCluster(
		(signal) =>
			fetchAllPages(
				(filter, options) => client.searchUsers(filter, options),
				{},
				undefined,
				input.limit,
				signal,
			),
		ctx,
	);
	return { items };
}

export interface SearchUsersInput {
	/** Username; `*` and `?` are wildcards. */
	username?: string;
	/** Name; `*` and `?` are wildcards. */
	name?: string;
	/** Email; `*` and `?` are wildcards. */
	email?: string;
	/** Maximum number of users. Default: all. */
	limit?: number;
}

export function searchUsersRequest(input: SearchUsersInput) {
	const filter: Record<string, unknown> = {};
	if (input.username) filter.username = toStringFilter(String(input.username));
	if (input.name) filter.name = toStringFilter(String(input.name));
	if (input.email) filter.email = toStringFilter(String(input.email));
	return {
		method: "POST",
		endpoint: "/users/search",
		body: searchBodyOf(filter),
	};
}

export async function searchUsers(
	input: SearchUsersInput & ClusterInput,
	ctx: C8ctlContext = {},
): Promise<{ items: User[] }> {
	const { client } = connect(input.target, ctx);
	const { body } = searchUsersRequest(input);
	const items = await callCluster(
		(signal) =>
			fetchAllPages(
				(filter, options) => client.searchUsers(filter, options),
				body,
				undefined,
				input.limit,
				signal,
			),
		ctx,
	);
	return { items };
}

export interface UsernameInput {
	username: string;
}

export function getUserRequest(input: UsernameInput) {
	return { method: "GET", endpoint: `/users/${input.username}` };
}

export async function getUser(
	input: UsernameInput & ClusterInput,
	ctx: C8ctlContext = {},
) {
	const { client } = connect(input.target, ctx);
	const username = brandInput(
		"username",
		input.username,
		Username.assumeExists,
	);
	return callCluster(
		() => client.getUser({ username }, { consistency: { waitUpToMs: 0 } }),
		ctx,
	);
}

export interface CreateUserInput {
	username: string;
	password: string;
	name?: string;
	email?: string;
}

export function createUserRequest(input: CreateUserInput) {
	requireInput(input.username, "username");
	requireInput(input.password, "password");
	return {
		method: "POST",
		endpoint: "/users",
		body: {
			username: input.username,
			password: input.password,
			...(input.name ? { name: input.name } : {}),
			...(input.email ? { email: input.email } : {}),
		},
	};
}

export async function createUser(
	input: CreateUserInput & ClusterInput,
	ctx: C8ctlContext = {},
): Promise<{ username: string }> {
	const { client } = connect(input.target, ctx);
	const { body } = createUserRequest(input);
	const username = brandInput("username", body.username, Username.assumeExists);
	await callCluster(() => client.createUser({ ...body, username }), ctx);
	return { username: input.username };
}

export function deleteUserRequest(input: UsernameInput) {
	return {
		method: "DELETE",
		endpoint: `/users/${encodeURIComponent(String(input.username))}`,
		body: null,
	};
}

export async function deleteUser(
	input: UsernameInput & ClusterInput,
	ctx: C8ctlContext = {},
): Promise<{ username: string }> {
	const { client } = connect(input.target, ctx);
	const username = brandInput(
		"username",
		input.username,
		Username.assumeExists,
	);
	await callCluster(() => client.deleteUser({ username }), ctx);
	return { username: input.username };
}
