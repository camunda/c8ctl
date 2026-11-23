/**
 * Identity assignment services: assign a role, user, group or mapping
 * rule to a member (user, group, tenant, mapping rule), and unassign it.
 * Each input names exactly one member, e.g. `{ roleId, user }`.
 */

import {
	GroupId,
	MappingRuleId,
	RoleId,
	TenantId,
	Username,
} from "@camunda8/orchestration-cluster-api";
import type { C8ctlContext, ClusterInput } from "../core/index.ts";
import { brandInput, C8ctlError, callCluster, connect } from "../core/index.ts";

type Member = "user" | "group" | "tenant" | "mappingRule";

const MEMBER_PATHS: Record<Member, string> = {
	user: "users",
	group: "groups",
	tenant: "tenants",
	mappingRule: "mapping-rules",
};

/** The one member an assignment input names. */
function memberOf<M extends Member>(
	input: Partial<Record<M, string>>,
	members: readonly M[],
): { member: M; memberId: string } {
	const given = members.filter((member) => input[member]);
	const member = given[0];
	const memberId = member === undefined ? undefined : input[member];
	if (given.length !== 1 || memberId === undefined) {
		throw new C8ctlError(
			"invalid-input",
			`Exactly one of ${members.join(", ")} is required.`,
			{ field: members[0] },
		);
	}
	return { member, memberId };
}

function assignmentRequest(
	method: "POST" | "DELETE",
	resourcePath: string,
	id: string,
	member: Member,
	memberId: string,
) {
	return {
		method,
		endpoint: `/${resourcePath}/${encodeURIComponent(String(id))}/${MEMBER_PATHS[member]}/${encodeURIComponent(String(memberId))}`,
		body: null,
	};
}

const username = (value: string) =>
	brandInput("user", value, Username.assumeExists);
const groupId = (value: string) =>
	brandInput("group", value, GroupId.assumeExists);
const tenantId = (value: string) =>
	brandInput("tenant", value, TenantId.assumeExists);
const mappingRuleId = (value: string) =>
	brandInput("mappingRule", value, MappingRuleId.assumeExists);

// ─── role ────────────────────────────────────────────────────────────────────

const ROLE_MEMBERS = ["user", "group", "tenant", "mappingRule"] as const;

/** A role and the one member it is assigned to (or unassigned from). */
export interface RoleAssignmentInput {
	roleId: string;
	user?: string;
	group?: string;
	tenant?: string;
	mappingRule?: string;
}

export function assignRoleRequest(input: RoleAssignmentInput) {
	const { member, memberId } = memberOf(input, ROLE_MEMBERS);
	return assignmentRequest("POST", "roles", input.roleId, member, memberId);
}

export async function assignRole(
	input: RoleAssignmentInput & ClusterInput,
	ctx: C8ctlContext = {},
): Promise<{ roleId: string }> {
	const { client } = connect(input.target, ctx);
	const { member, memberId } = memberOf(input, ROLE_MEMBERS);
	const roleId = () => brandInput("roleId", input.roleId, RoleId.assumeExists);
	await callCluster(() => {
		switch (member) {
			case "user":
				return client.assignRoleToUser({
					roleId: roleId(),
					username: username(memberId),
				});
			case "group":
				return client.assignRoleToGroup({
					roleId: roleId(),
					groupId: groupId(memberId),
				});
			case "tenant":
				return client.assignRoleToTenant({
					tenantId: tenantId(memberId),
					roleId: roleId(),
				});
			case "mappingRule":
				return client.assignRoleToMappingRule({
					roleId: roleId(),
					mappingRuleId: mappingRuleId(memberId),
				});
		}
	}, ctx);
	return { roleId: input.roleId };
}

export function unassignRoleRequest(input: RoleAssignmentInput) {
	const { member, memberId } = memberOf(input, ROLE_MEMBERS);
	return assignmentRequest("DELETE", "roles", input.roleId, member, memberId);
}

export async function unassignRole(
	input: RoleAssignmentInput & ClusterInput,
	ctx: C8ctlContext = {},
): Promise<{ roleId: string }> {
	const { client } = connect(input.target, ctx);
	const { member, memberId } = memberOf(input, ROLE_MEMBERS);
	const roleId = () => brandInput("roleId", input.roleId, RoleId.assumeExists);
	await callCluster(() => {
		switch (member) {
			case "user":
				return client.unassignRoleFromUser({
					roleId: roleId(),
					username: username(memberId),
				});
			case "group":
				return client.unassignRoleFromGroup({
					roleId: roleId(),
					groupId: groupId(memberId),
				});
			case "tenant":
				return client.unassignRoleFromTenant({
					tenantId: tenantId(memberId),
					roleId: roleId(),
				});
			case "mappingRule":
				return client.unassignRoleFromMappingRule({
					roleId: roleId(),
					mappingRuleId: mappingRuleId(memberId),
				});
		}
	}, ctx);
	return { roleId: input.roleId };
}

// ─── user ────────────────────────────────────────────────────────────────────

const USER_MEMBERS = ["group", "tenant"] as const;

/** A user and the one group or tenant it is assigned to. */
export interface UserAssignmentInput {
	username: string;
	group?: string;
	tenant?: string;
}

export function assignUserRequest(input: UserAssignmentInput) {
	const { member, memberId } = memberOf(input, USER_MEMBERS);
	return assignmentRequest("POST", "users", input.username, member, memberId);
}

export async function assignUser(
	input: UserAssignmentInput & ClusterInput,
	ctx: C8ctlContext = {},
): Promise<{ username: string }> {
	const { client } = connect(input.target, ctx);
	const { member, memberId } = memberOf(input, USER_MEMBERS);
	const user = () =>
		brandInput("username", input.username, Username.assumeExists);
	await callCluster(
		() =>
			member === "group"
				? client.assignUserToGroup({
						groupId: groupId(memberId),
						username: user(),
					})
				: client.assignUserToTenant({
						tenantId: tenantId(memberId),
						username: user(),
					}),
		ctx,
	);
	return { username: input.username };
}

export function unassignUserRequest(input: UserAssignmentInput) {
	const { member, memberId } = memberOf(input, USER_MEMBERS);
	return assignmentRequest("DELETE", "users", input.username, member, memberId);
}

export async function unassignUser(
	input: UserAssignmentInput & ClusterInput,
	ctx: C8ctlContext = {},
): Promise<{ username: string }> {
	const { client } = connect(input.target, ctx);
	const { member, memberId } = memberOf(input, USER_MEMBERS);
	const user = () =>
		brandInput("username", input.username, Username.assumeExists);
	await callCluster(
		() =>
			member === "group"
				? client.unassignUserFromGroup({
						groupId: groupId(memberId),
						username: user(),
					})
				: client.unassignUserFromTenant({
						tenantId: tenantId(memberId),
						username: user(),
					}),
		ctx,
	);
	return { username: input.username };
}

// ─── group ───────────────────────────────────────────────────────────────────

const GROUP_MEMBERS = ["tenant"] as const;

/** A group and the tenant it is assigned to. */
export interface GroupAssignmentInput {
	groupId: string;
	tenant?: string;
}

export function assignGroupRequest(input: GroupAssignmentInput) {
	const { member, memberId } = memberOf(input, GROUP_MEMBERS);
	return assignmentRequest("POST", "groups", input.groupId, member, memberId);
}

export async function assignGroup(
	input: GroupAssignmentInput & ClusterInput,
	ctx: C8ctlContext = {},
): Promise<{ groupId: string }> {
	const { client } = connect(input.target, ctx);
	const { memberId } = memberOf(input, GROUP_MEMBERS);
	await callCluster(
		() =>
			client.assignGroupToTenant({
				tenantId: tenantId(memberId),
				groupId: brandInput("groupId", input.groupId, GroupId.assumeExists),
			}),
		ctx,
	);
	return { groupId: input.groupId };
}

export function unassignGroupRequest(input: GroupAssignmentInput) {
	const { member, memberId } = memberOf(input, GROUP_MEMBERS);
	return assignmentRequest("DELETE", "groups", input.groupId, member, memberId);
}

export async function unassignGroup(
	input: GroupAssignmentInput & ClusterInput,
	ctx: C8ctlContext = {},
): Promise<{ groupId: string }> {
	const { client } = connect(input.target, ctx);
	const { memberId } = memberOf(input, GROUP_MEMBERS);
	await callCluster(
		() =>
			client.unassignGroupFromTenant({
				tenantId: tenantId(memberId),
				groupId: brandInput("groupId", input.groupId, GroupId.assumeExists),
			}),
		ctx,
	);
	return { groupId: input.groupId };
}

// ─── mapping rule ────────────────────────────────────────────────────────────

const MAPPING_RULE_MEMBERS = ["group", "tenant"] as const;

/** A mapping rule and the one group or tenant it is assigned to. */
export interface MappingRuleAssignmentInput {
	mappingRuleId: string;
	group?: string;
	tenant?: string;
}

export function assignMappingRuleRequest(input: MappingRuleAssignmentInput) {
	const { member, memberId } = memberOf(input, MAPPING_RULE_MEMBERS);
	return assignmentRequest(
		"POST",
		"mapping-rules",
		input.mappingRuleId,
		member,
		memberId,
	);
}

export async function assignMappingRule(
	input: MappingRuleAssignmentInput & ClusterInput,
	ctx: C8ctlContext = {},
): Promise<{ mappingRuleId: string }> {
	const { client } = connect(input.target, ctx);
	const { member, memberId } = memberOf(input, MAPPING_RULE_MEMBERS);
	const rule = () =>
		brandInput(
			"mappingRuleId",
			input.mappingRuleId,
			MappingRuleId.assumeExists,
		);
	await callCluster(
		() =>
			member === "group"
				? client.assignMappingRuleToGroup({
						groupId: groupId(memberId),
						mappingRuleId: rule(),
					})
				: client.assignMappingRuleToTenant({
						tenantId: tenantId(memberId),
						mappingRuleId: rule(),
					}),
		ctx,
	);
	return { mappingRuleId: input.mappingRuleId };
}

export function unassignMappingRuleRequest(input: MappingRuleAssignmentInput) {
	const { member, memberId } = memberOf(input, MAPPING_RULE_MEMBERS);
	return assignmentRequest(
		"DELETE",
		"mapping-rules",
		input.mappingRuleId,
		member,
		memberId,
	);
}

export async function unassignMappingRule(
	input: MappingRuleAssignmentInput & ClusterInput,
	ctx: C8ctlContext = {},
): Promise<{ mappingRuleId: string }> {
	const { client } = connect(input.target, ctx);
	const { member, memberId } = memberOf(input, MAPPING_RULE_MEMBERS);
	const rule = () =>
		brandInput(
			"mappingRuleId",
			input.mappingRuleId,
			MappingRuleId.assumeExists,
		);
	await callCluster(
		() =>
			member === "group"
				? client.unassignMappingRuleFromGroup({
						groupId: groupId(memberId),
						mappingRuleId: rule(),
					})
				: client.unassignMappingRuleFromTenant({
						tenantId: tenantId(memberId),
						mappingRuleId: rule(),
					}),
		ctx,
	);
	return { mappingRuleId: input.mappingRuleId };
}
