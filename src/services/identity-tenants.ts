/**
 * Identity tenant services: list, search, get, create, delete.
 */

import {
	type CamundaClient,
	TenantId,
} from "@camunda8/orchestration-cluster-api";
import type { C8ctlContext, ClusterInput } from "../core/index.ts";
import {
	brandInput,
	callCluster,
	connect,
	fetchAllPages,
} from "../core/index.ts";
import { requireInput, searchBodyOf } from "./identity-common.ts";

type Tenant = Awaited<
	ReturnType<CamundaClient["searchTenants"]>
>["items"][number];

export interface ListTenantsInput {
	/** Maximum number of tenants. Default: all. */
	limit?: number;
}

export function listTenantsRequest() {
	return { method: "POST", endpoint: "/tenants/search", body: {} };
}

export async function listTenants(
	input: ListTenantsInput & ClusterInput,
	ctx: C8ctlContext = {},
): Promise<{ items: Tenant[] }> {
	const { client } = connect(input.target, ctx);
	const items = await callCluster(
		(signal) =>
			fetchAllPages(
				(filter, options) => client.searchTenants(filter, options),
				{},
				undefined,
				input.limit,
				signal,
			),
		ctx,
	);
	return { items };
}

// The tenant's ID is `tenant`: `tenantId` is the tenant scope of every
// cluster input (`ClusterInput`), which hosts set from their context.

export interface SearchTenantsInput {
	/** Tenant ID. */
	tenant?: string;
	name?: string;
	/** Maximum number of tenants. Default: all. */
	limit?: number;
}

export function searchTenantsRequest(input: SearchTenantsInput) {
	const filter: Record<string, unknown> = {};
	if (input.tenant) filter.tenantId = input.tenant;
	if (input.name) filter.name = input.name;
	return {
		method: "POST",
		endpoint: "/tenants/search",
		body: searchBodyOf(filter),
	};
}

export async function searchTenants(
	input: SearchTenantsInput & ClusterInput,
	ctx: C8ctlContext = {},
): Promise<{ items: Tenant[] }> {
	const { client } = connect(input.target, ctx);
	const { body } = searchTenantsRequest(input);
	const items = await callCluster(
		(signal) =>
			fetchAllPages(
				(filter, options) => client.searchTenants(filter, options),
				body,
				undefined,
				input.limit,
				signal,
			),
		ctx,
	);
	return { items };
}

export interface TenantIdInput {
	/** Tenant ID. */
	tenant: string;
}

export function getTenantRequest(input: TenantIdInput) {
	return { method: "GET", endpoint: `/tenants/${input.tenant}` };
}

export async function getTenant(
	input: TenantIdInput & ClusterInput,
	ctx: C8ctlContext = {},
) {
	const { client } = connect(input.target, ctx);
	const tenantId = brandInput("tenant", input.tenant, TenantId.assumeExists);
	return callCluster(
		() => client.getTenant({ tenantId }, { consistency: { waitUpToMs: 0 } }),
		ctx,
	);
}

export interface CreateTenantInput {
	/** Tenant ID. */
	tenant: string;
	name: string;
}

export function createTenantRequest(input: CreateTenantInput) {
	requireInput(input.tenant, "tenantId", "tenant");
	requireInput(input.name, "name");
	return {
		method: "POST",
		endpoint: "/tenants",
		body: { tenantId: input.tenant, name: input.name },
	};
}

export async function createTenant(
	input: CreateTenantInput & ClusterInput,
	ctx: C8ctlContext = {},
): Promise<{ tenantId: string }> {
	const { client } = connect(input.target, ctx);
	const { body } = createTenantRequest(input);
	const tenantId = brandInput("tenant", body.tenantId, TenantId.assumeExists);
	await callCluster(() => client.createTenant({ ...body, tenantId }), ctx);
	return { tenantId: input.tenant };
}

export function deleteTenantRequest(input: TenantIdInput) {
	return {
		method: "DELETE",
		endpoint: `/tenants/${encodeURIComponent(String(input.tenant))}`,
		body: null,
	};
}

export async function deleteTenant(
	input: TenantIdInput & ClusterInput,
	ctx: C8ctlContext = {},
): Promise<{ tenantId: string }> {
	const { client } = connect(input.target, ctx);
	const tenantId = brandInput("tenant", input.tenant, TenantId.assumeExists);
	await callCluster(() => client.deleteTenant({ tenantId }), ctx);
	return { tenantId: input.tenant };
}
