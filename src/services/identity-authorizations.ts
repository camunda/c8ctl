/**
 * Identity authorization services: list, search, get, create, delete.
 */

import {
	AuthorizationKey,
	type CamundaClient,
	type OwnerTypeEnum,
	type PermissionTypeEnum,
	type ResourceTypeEnum,
} from "@camunda8/orchestration-cluster-api";
import type { C8ctlContext, ClusterInput } from "../core/index.ts";
import {
	brandInput,
	callCluster,
	connect,
	fetchAllPages,
} from "../core/index.ts";
import { searchBodyOf } from "./identity-common.ts";

type Authorization = Awaited<
	ReturnType<CamundaClient["searchAuthorizations"]>
>["items"][number];

export interface ListAuthorizationsInput {
	/** Maximum number of authorizations. Default: all. */
	limit?: number;
}

export function listAuthorizationsRequest() {
	return { method: "POST", endpoint: "/authorizations/search", body: {} };
}

export async function listAuthorizations(
	input: ListAuthorizationsInput & ClusterInput,
	ctx: C8ctlContext = {},
): Promise<{ items: Authorization[] }> {
	const { client } = connect(input.target, ctx);
	const items = await callCluster(
		(signal) =>
			fetchAllPages(
				(filter, options) => client.searchAuthorizations(filter, options),
				{},
				undefined,
				input.limit,
				signal,
			),
		ctx,
	);
	return { items };
}

export interface SearchAuthorizationsInput {
	ownerId?: string;
	ownerType?: string;
	resourceType?: string;
	resourceId?: string;
	/**
	 * Only the authorizations of the authenticated user or client, including
	 * those granted through a group, role or mapping rule. Needs no admin
	 * permission (Camunda 8.10+).
	 */
	own?: boolean;
	/** Maximum number of authorizations. Default: all. */
	limit?: number;
}

export function searchAuthorizationsRequest(input: SearchAuthorizationsInput) {
	const filter: Record<string, unknown> = {};
	if (input.ownerId) filter.ownerId = input.ownerId;
	if (input.ownerType) filter.ownerType = input.ownerType;
	if (input.resourceType) filter.resourceType = input.resourceType;
	if (input.resourceId) filter.resourceIds = [input.resourceId];
	return {
		method: "POST",
		endpoint: input.own
			? "/authentication/me/authorizations/search"
			: "/authorizations/search",
		body: searchBodyOf(filter),
	};
}

/**
 * With `own`, `authorizationsEnabled` tells whether the cluster checks
 * authorizations at all; when it is `false`, every request is allowed.
 */
export async function searchAuthorizations(
	input: SearchAuthorizationsInput & ClusterInput,
	ctx: C8ctlContext = {},
): Promise<{ items: Authorization[]; authorizationsEnabled?: boolean }> {
	const { client } = connect(input.target, ctx);
	const { body } = searchAuthorizationsRequest(input);
	let authorizationsEnabled: boolean | undefined;
	const items = await callCluster(
		(signal) =>
			fetchAllPages(
				async (filter, options) => {
					if (!input.own) return client.searchAuthorizations(filter, options);
					const page = await client.searchOwnAuthorizations(filter, options);
					authorizationsEnabled = page.authorizationsEnabled;
					return page;
				},
				body,
				undefined,
				input.limit,
				signal,
			),
		ctx,
	);
	return authorizationsEnabled === undefined
		? { items }
		: { items, authorizationsEnabled };
}

export interface AuthorizationKeyInput {
	authorizationKey: string;
}

export function getAuthorizationRequest(input: AuthorizationKeyInput) {
	return {
		method: "GET",
		endpoint: `/authorizations/${input.authorizationKey}`,
	};
}

export async function getAuthorization(
	input: AuthorizationKeyInput & ClusterInput,
	ctx: C8ctlContext = {},
) {
	const { client } = connect(input.target, ctx);
	const authorizationKey = brandInput(
		"authorizationKey",
		input.authorizationKey,
		AuthorizationKey.assumeExists,
	);
	return callCluster(
		() =>
			client.getAuthorization(
				{ authorizationKey },
				{ consistency: { waitUpToMs: 0 } },
			),
		ctx,
	);
}

export interface CreateAuthorizationInput {
	ownerId: string;
	ownerType: OwnerTypeEnum;
	resourceType: ResourceTypeEnum;
	resourceId: string;
	permissionTypes: PermissionTypeEnum[];
}

export function createAuthorizationRequest(input: CreateAuthorizationInput) {
	return {
		method: "POST",
		endpoint: "/authorizations",
		body: {
			ownerId: input.ownerId,
			ownerType: input.ownerType,
			resourceType: input.resourceType,
			resourceId: input.resourceId,
			permissionTypes: input.permissionTypes,
		},
	};
}

export async function createAuthorization(
	input: CreateAuthorizationInput & ClusterInput,
	ctx: C8ctlContext = {},
) {
	const { client } = connect(input.target, ctx);
	const { body } = createAuthorizationRequest(input);
	return callCluster(() => client.createAuthorization(body), ctx);
}

export function deleteAuthorizationRequest(input: AuthorizationKeyInput) {
	return {
		method: "DELETE",
		endpoint: `/authorizations/${encodeURIComponent(String(input.authorizationKey))}`,
		body: null,
	};
}

export async function deleteAuthorization(
	input: AuthorizationKeyInput & ClusterInput,
	ctx: C8ctlContext = {},
): Promise<{ authorizationKey: string }> {
	const { client } = connect(input.target, ctx);
	const authorizationKey = brandInput(
		"authorizationKey",
		input.authorizationKey,
		AuthorizationKey.assumeExists,
	);
	await callCluster(
		() => client.deleteAuthorization({ authorizationKey }),
		ctx,
	);
	return { authorizationKey: input.authorizationKey };
}
