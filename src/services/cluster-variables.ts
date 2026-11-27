/**
 * Cluster variable services: list, search, get, create, update, delete.
 *
 * A variable is global, or scoped to the tenant in `tenant`. The scope is
 * never the session tenant: `tenantId` is the tenant scope of every cluster
 * input (`ClusterInput`), which hosts set from their context.
 */

import {
	type CamundaClient,
	ClusterVariableName,
	TenantId,
} from "@camunda8/orchestration-cluster-api";
import type { C8ctlContext, ClusterInput } from "../core/index.ts";
import {
	brandInput,
	C8ctlError,
	callCluster,
	connect,
	fetchAllPages,
	isRecord,
} from "../core/index.ts";
import { toStringFilter } from "../utils/index.ts";
import { requireInput, searchBodyOf } from "./identity-common.ts";

type ClusterVariable = Awaited<
	ReturnType<CamundaClient["searchClusterVariables"]>
>["items"][number];

type Metadata = Record<string, string | number>;

/** The variable's scope: global, or the tenant in `tenant`. */
export interface ClusterVariableScopeInput {
	/** Tenant ID of a tenant-scoped variable. Omit for a global variable. */
	tenant?: string;
}

export interface ClusterVariableNameInput extends ClusterVariableScopeInput {
	name: string;
}

function variablesPath({ tenant, name }: Partial<ClusterVariableNameInput>) {
	const base = tenant
		? `/cluster-variables/tenants/${encodeURIComponent(tenant)}`
		: "/cluster-variables/global";
	return name === undefined ? base : `${base}/${encodeURIComponent(name)}`;
}

function brandName(name: string) {
	return brandInput("name", name, ClusterVariableName.assumeExists);
}

function brandTenant(tenant: string) {
	return brandInput("tenant", tenant, TenantId.assumeExists);
}

function requireValue(value: unknown): Record<string, unknown> {
	if (!isRecord(value) || Array.isArray(value)) {
		throw new C8ctlError("invalid-input", "--value must be a JSON object", {
			field: "value",
		});
	}
	return value;
}

/** Metadata values must be strings or numbers; anything else is `invalid-input`. */
export function assertClusterVariableMetadata(
	metadata: Record<string, unknown> | undefined,
): asserts metadata is Metadata | undefined {
	for (const [key, value] of Object.entries(metadata ?? {})) {
		const valid =
			typeof value === "string" ||
			(typeof value === "number" && Number.isFinite(value));
		if (!valid) {
			throw new C8ctlError(
				"invalid-input",
				`--metadata value for key '${key}' must be a string or number`,
				{ field: "metadata" },
			);
		}
	}
}

export interface ListClusterVariablesInput {
	/** Maximum number of variables. Default: all. */
	limit?: number;
}

export function listClusterVariablesRequest() {
	return { method: "POST", endpoint: "/cluster-variables/search", body: {} };
}

export async function listClusterVariables(
	input: ListClusterVariablesInput & ClusterInput,
	ctx: C8ctlContext = {},
): Promise<{ items: ClusterVariable[] }> {
	const { client } = connect(input.target, ctx);
	const items = await callCluster(
		(signal) =>
			fetchAllPages(
				(filter, options) => client.searchClusterVariables(filter, options),
				{},
				undefined,
				input.limit,
				signal,
			),
		ctx,
	);
	return { items };
}

export interface SearchClusterVariablesInput {
	/** Name; `*` and `?` are wildcards. */
	name?: string;
	/** Value as stored (a JSON string); `*` and `?` are wildcards. */
	value?: string;
	scope?: "GLOBAL" | "TENANT";
	/** Tenant ID of tenant-scoped variables. */
	tenant?: string;
	kind?: "JSON" | "SECRET_REFERENCE";
	/** Metadata entries the variable must have, compared for equality. */
	metadata?: Metadata;
	/** Return full values; the cluster truncates long values by default. */
	fullValue?: boolean;
	/** Maximum number of variables. Default: all. */
	limit?: number;
}

export function searchClusterVariablesRequest(
	input: SearchClusterVariablesInput,
) {
	assertClusterVariableMetadata(input.metadata);
	const filter: Record<string, unknown> = {};
	if (input.name) filter.name = toStringFilter(input.name);
	if (input.value) filter.value = toStringFilter(input.value);
	if (input.scope) filter.scope = input.scope;
	if (input.tenant) filter.tenantId = input.tenant;
	if (input.kind) filter.kind = input.kind;
	if (input.metadata && Object.keys(input.metadata).length > 0) {
		filter.metadata = Object.fromEntries(
			Object.entries(input.metadata).map(([key, value]) => [
				key,
				{ $eq: value },
			]),
		);
	}
	return {
		method: "POST",
		endpoint: `/cluster-variables/search?truncateValues=${!input.fullValue}`,
		body: searchBodyOf(filter),
	};
}

export async function searchClusterVariables(
	input: SearchClusterVariablesInput & ClusterInput,
	ctx: C8ctlContext = {},
): Promise<{ items: ClusterVariable[] }> {
	const { client } = connect(input.target, ctx);
	const { body } = searchClusterVariablesRequest(input);
	const truncateValues = !input.fullValue;
	const items = await callCluster(
		(signal) =>
			fetchAllPages(
				(filter, options) =>
					client.searchClusterVariables({ ...filter, truncateValues }, options),
				body,
				undefined,
				input.limit,
				signal,
			),
		ctx,
	);
	return { items };
}

export function getClusterVariableRequest(input: ClusterVariableNameInput) {
	return { method: "GET", endpoint: variablesPath(input) };
}

/** The variable with its full value. */
export async function getClusterVariable(
	input: ClusterVariableNameInput & ClusterInput,
	ctx: C8ctlContext = {},
) {
	const { client } = connect(input.target, ctx);
	const name = brandName(input.name);
	const consistency = { consistency: { waitUpToMs: 0 } };
	return callCluster(
		() =>
			input.tenant
				? client.getTenantClusterVariable(
						{ tenantId: brandTenant(input.tenant), name },
						consistency,
					)
				: client.getGlobalClusterVariable({ name }, consistency),
		ctx,
	);
}

export interface CreateClusterVariableInput extends ClusterVariableNameInput {
	value: Record<string, unknown>;
	metadata?: Metadata;
	/** Default: `JSON`. */
	kind?: "JSON" | "SECRET_REFERENCE";
}

export function createClusterVariableRequest(
	input: CreateClusterVariableInput,
) {
	requireInput(input.name, "name");
	const value = requireValue(input.value);
	assertClusterVariableMetadata(input.metadata);
	return {
		method: "POST",
		endpoint: variablesPath({ tenant: input.tenant }),
		body: {
			name: input.name,
			value,
			...(input.metadata && { metadata: input.metadata }),
			...(input.kind && { kind: input.kind }),
		},
	};
}

export async function createClusterVariable(
	input: CreateClusterVariableInput & ClusterInput,
	ctx: C8ctlContext = {},
): Promise<ClusterVariableNameInput> {
	const { client } = connect(input.target, ctx);
	const { body } = createClusterVariableRequest(input);
	const name = brandName(body.name);
	await callCluster(
		() =>
			input.tenant
				? client.createTenantClusterVariable({
						...body,
						name,
						tenantId: brandTenant(input.tenant),
					})
				: client.createGlobalClusterVariable({ ...body, name }),
		ctx,
	);
	return scopedName(input);
}

export interface UpdateClusterVariableInput extends ClusterVariableNameInput {
	value: Record<string, unknown>;
	/** Replaces the metadata; omit to keep it. */
	metadata?: Metadata;
}

export function updateClusterVariableRequest(
	input: UpdateClusterVariableInput,
) {
	const value = requireValue(input.value);
	assertClusterVariableMetadata(input.metadata);
	return {
		method: "PUT",
		endpoint: variablesPath(input),
		body: { value, ...(input.metadata && { metadata: input.metadata }) },
	};
}

export async function updateClusterVariable(
	input: UpdateClusterVariableInput & ClusterInput,
	ctx: C8ctlContext = {},
): Promise<ClusterVariableNameInput> {
	const { client } = connect(input.target, ctx);
	const { body } = updateClusterVariableRequest(input);
	const name = brandName(input.name);
	await callCluster(
		() =>
			input.tenant
				? client.updateTenantClusterVariable({
						...body,
						name,
						tenantId: brandTenant(input.tenant),
					})
				: client.updateGlobalClusterVariable({ ...body, name }),
		ctx,
	);
	return scopedName(input);
}

export function deleteClusterVariableRequest(input: ClusterVariableNameInput) {
	return { method: "DELETE", endpoint: variablesPath(input), body: null };
}

export async function deleteClusterVariable(
	input: ClusterVariableNameInput & ClusterInput,
	ctx: C8ctlContext = {},
): Promise<ClusterVariableNameInput> {
	const { client } = connect(input.target, ctx);
	const name = brandName(input.name);
	await callCluster(
		() =>
			input.tenant
				? client.deleteTenantClusterVariable({
						name,
						tenantId: brandTenant(input.tenant),
					})
				: client.deleteGlobalClusterVariable({ name }),
		ctx,
	);
	return scopedName(input);
}

function scopedName({
	name,
	tenant,
}: ClusterVariableNameInput): ClusterVariableNameInput {
	return tenant ? { name, tenant } : { name };
}
