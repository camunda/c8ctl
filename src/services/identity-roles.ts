/**
 * Identity role services: list, search, get, create, delete.
 */

import {
	type CamundaClient,
	RoleId,
} from "@camunda8/orchestration-cluster-api";
import type { C8ctlContext, ClusterInput } from "../core/index.ts";
import {
	brandInput,
	callCluster,
	connect,
	fetchAllPages,
} from "../core/index.ts";
import { requireInput, searchBodyOf } from "./identity-common.ts";

type Role = Awaited<ReturnType<CamundaClient["searchRoles"]>>["items"][number];

export interface ListRolesInput {
	/** Maximum number of roles. Default: all. */
	limit?: number;
}

export function listRolesRequest() {
	return { method: "POST", endpoint: "/roles/search", body: {} };
}

export async function listRoles(
	input: ListRolesInput & ClusterInput,
	ctx: C8ctlContext = {},
): Promise<{ items: Role[] }> {
	const { client } = connect(input.target, ctx);
	const items = await callCluster(
		(signal) =>
			fetchAllPages(
				(filter, options) => client.searchRoles(filter, options),
				{},
				undefined,
				input.limit,
				signal,
			),
		ctx,
	);
	return { items };
}

export interface SearchRolesInput {
	roleId?: string;
	name?: string;
	/** Maximum number of roles. Default: all. */
	limit?: number;
}

export function searchRolesRequest(input: SearchRolesInput) {
	const filter: Record<string, unknown> = {};
	if (input.roleId) filter.roleId = input.roleId;
	if (input.name) filter.name = input.name;
	return {
		method: "POST",
		endpoint: "/roles/search",
		body: searchBodyOf(filter),
	};
}

export async function searchRoles(
	input: SearchRolesInput & ClusterInput,
	ctx: C8ctlContext = {},
): Promise<{ items: Role[] }> {
	const { client } = connect(input.target, ctx);
	const { body } = searchRolesRequest(input);
	const items = await callCluster(
		(signal) =>
			fetchAllPages(
				(filter, options) => client.searchRoles(filter, options),
				body,
				undefined,
				input.limit,
				signal,
			),
		ctx,
	);
	return { items };
}

export interface RoleIdInput {
	roleId: string;
}

export function getRoleRequest(input: RoleIdInput) {
	return { method: "GET", endpoint: `/roles/${input.roleId}` };
}

export async function getRole(
	input: RoleIdInput & ClusterInput,
	ctx: C8ctlContext = {},
) {
	const { client } = connect(input.target, ctx);
	const roleId = brandInput("roleId", input.roleId, RoleId.assumeExists);
	return callCluster(
		() => client.getRole({ roleId }, { consistency: { waitUpToMs: 0 } }),
		ctx,
	);
}

export interface CreateRoleInput {
	roleId: string;
	name: string;
}

export function createRoleRequest(input: CreateRoleInput) {
	requireInput(input.roleId, "roleId");
	requireInput(input.name, "name");
	return {
		method: "POST",
		endpoint: "/roles",
		body: { roleId: input.roleId, name: input.name },
	};
}

export async function createRole(
	input: CreateRoleInput & ClusterInput,
	ctx: C8ctlContext = {},
): Promise<{ roleId: string }> {
	const { client } = connect(input.target, ctx);
	const { body } = createRoleRequest(input);
	const roleId = brandInput("roleId", body.roleId, RoleId.assumeExists);
	await callCluster(() => client.createRole({ ...body, roleId }), ctx);
	return { roleId: input.roleId };
}

export function deleteRoleRequest(input: RoleIdInput) {
	return {
		method: "DELETE",
		endpoint: `/roles/${encodeURIComponent(String(input.roleId))}`,
		body: null,
	};
}

export async function deleteRole(
	input: RoleIdInput & ClusterInput,
	ctx: C8ctlContext = {},
): Promise<{ roleId: string }> {
	const { client } = connect(input.target, ctx);
	const roleId = brandInput("roleId", input.roleId, RoleId.assumeExists);
	await callCluster(() => client.deleteRole({ roleId }), ctx);
	return { roleId: input.roleId };
}
