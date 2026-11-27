/**
 * Identity group services: list, search, get, create, delete.
 */

import {
	type CamundaClient,
	GroupId,
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

type Group = Awaited<
	ReturnType<CamundaClient["searchGroups"]>
>["items"][number];

export interface ListGroupsInput {
	/** Maximum number of groups. Default: all. */
	limit?: number;
}

export function listGroupsRequest() {
	return { method: "POST", endpoint: "/groups/search", body: {} };
}

export async function listGroups(
	input: ListGroupsInput & ClusterInput,
	ctx: C8ctlContext = {},
): Promise<{ items: Group[] }> {
	const { client } = connect(input.target, ctx);
	const items = await callCluster(
		(signal) =>
			fetchAllPages(
				(filter, options) => client.searchGroups(filter, options),
				{},
				undefined,
				input.limit,
				signal,
			),
		ctx,
	);
	return { items };
}

export interface SearchGroupsInput {
	/** Group ID; `*` and `?` are wildcards. */
	groupId?: string;
	name?: string;
	/** Maximum number of groups. Default: all. */
	limit?: number;
}

export function searchGroupsRequest(input: SearchGroupsInput) {
	const filter: Record<string, unknown> = {};
	if (input.groupId) filter.groupId = toStringFilter(String(input.groupId));
	if (input.name) filter.name = input.name;
	return {
		method: "POST",
		endpoint: "/groups/search",
		body: searchBodyOf(filter),
	};
}

export async function searchGroups(
	input: SearchGroupsInput & ClusterInput,
	ctx: C8ctlContext = {},
): Promise<{ items: Group[] }> {
	const { client } = connect(input.target, ctx);
	const { body } = searchGroupsRequest(input);
	const items = await callCluster(
		(signal) =>
			fetchAllPages(
				(filter, options) => client.searchGroups(filter, options),
				body,
				undefined,
				input.limit,
				signal,
			),
		ctx,
	);
	return { items };
}

export interface GroupIdInput {
	groupId: string;
}

export function getGroupRequest(input: GroupIdInput) {
	return { method: "GET", endpoint: `/groups/${input.groupId}` };
}

export async function getGroup(
	input: GroupIdInput & ClusterInput,
	ctx: C8ctlContext = {},
) {
	const { client } = connect(input.target, ctx);
	const groupId = brandInput("groupId", input.groupId, GroupId.assumeExists);
	return callCluster(
		() => client.getGroup({ groupId }, { consistency: { waitUpToMs: 0 } }),
		ctx,
	);
}

export interface CreateGroupInput {
	groupId: string;
	name: string;
}

export function createGroupRequest(input: CreateGroupInput) {
	requireInput(input.groupId, "groupId");
	requireInput(input.name, "name");
	return {
		method: "POST",
		endpoint: "/groups",
		body: { groupId: input.groupId, name: input.name },
	};
}

export async function createGroup(
	input: CreateGroupInput & ClusterInput,
	ctx: C8ctlContext = {},
): Promise<{ groupId: string }> {
	const { client } = connect(input.target, ctx);
	const { body } = createGroupRequest(input);
	const groupId = brandInput("groupId", body.groupId, GroupId.assumeExists);
	await callCluster(() => client.createGroup({ ...body, groupId }), ctx);
	return { groupId: input.groupId };
}

export function deleteGroupRequest(input: GroupIdInput) {
	return {
		method: "DELETE",
		endpoint: `/groups/${encodeURIComponent(String(input.groupId))}`,
		body: null,
	};
}

export async function deleteGroup(
	input: GroupIdInput & ClusterInput,
	ctx: C8ctlContext = {},
): Promise<{ groupId: string }> {
	const { client } = connect(input.target, ctx);
	const groupId = brandInput("groupId", input.groupId, GroupId.assumeExists);
	await callCluster(() => client.deleteGroup({ groupId }), ctx);
	return { groupId: input.groupId };
}
