/**
 * Identity mapping rule services: list, search, get, create, delete.
 */

import {
	type CamundaClient,
	MappingRuleId,
} from "@camunda8/orchestration-cluster-api";
import type { C8ctlContext, ClusterInput } from "../core/index.ts";
import {
	brandInput,
	callCluster,
	connect,
	fetchAllPages,
} from "../core/index.ts";
import { requireInput, searchBodyOf } from "./identity-common.ts";

type MappingRule = Awaited<
	ReturnType<CamundaClient["searchMappingRule"]>
>["items"][number];

export interface ListMappingRulesInput {
	/** Maximum number of mapping rules. Default: all. */
	limit?: number;
}

export function listMappingRulesRequest() {
	return { method: "POST", endpoint: "/mapping-rules/search", body: {} };
}

export async function listMappingRules(
	input: ListMappingRulesInput & ClusterInput,
	ctx: C8ctlContext = {},
): Promise<{ items: MappingRule[] }> {
	const { client } = connect(input.target, ctx);
	const items = await callCluster(
		(signal) =>
			fetchAllPages(
				(filter, options) => client.searchMappingRule(filter, options),
				{},
				undefined,
				input.limit,
				signal,
			),
		ctx,
	);
	return { items };
}

export interface SearchMappingRulesInput {
	mappingRuleId?: string;
	name?: string;
	claimName?: string;
	claimValue?: string;
	/** Maximum number of mapping rules. Default: all. */
	limit?: number;
}

export function searchMappingRulesRequest(input: SearchMappingRulesInput) {
	const filter: Record<string, unknown> = {};
	if (input.mappingRuleId) filter.mappingRuleId = input.mappingRuleId;
	if (input.name) filter.name = input.name;
	if (input.claimName) filter.claimName = input.claimName;
	if (input.claimValue) filter.claimValue = input.claimValue;
	return {
		method: "POST",
		endpoint: "/mapping-rules/search",
		body: searchBodyOf(filter),
	};
}

export async function searchMappingRules(
	input: SearchMappingRulesInput & ClusterInput,
	ctx: C8ctlContext = {},
): Promise<{ items: MappingRule[] }> {
	const { client } = connect(input.target, ctx);
	const { body } = searchMappingRulesRequest(input);
	const items = await callCluster(
		(signal) =>
			fetchAllPages(
				(filter, options) => client.searchMappingRule(filter, options),
				body,
				undefined,
				input.limit,
				signal,
			),
		ctx,
	);
	return { items };
}

export interface MappingRuleIdInput {
	mappingRuleId: string;
}

export function getMappingRuleRequest(input: MappingRuleIdInput) {
	return {
		method: "GET",
		endpoint: `/mapping-rules/${input.mappingRuleId}`,
	};
}

export async function getMappingRule(
	input: MappingRuleIdInput & ClusterInput,
	ctx: C8ctlContext = {},
) {
	const { client } = connect(input.target, ctx);
	const mappingRuleId = brandInput(
		"mappingRuleId",
		input.mappingRuleId,
		MappingRuleId.assumeExists,
	);
	return callCluster(
		() =>
			client.getMappingRule(
				{ mappingRuleId },
				{ consistency: { waitUpToMs: 0 } },
			),
		ctx,
	);
}

export interface CreateMappingRuleInput {
	mappingRuleId: string;
	name: string;
	claimName: string;
	claimValue: string;
}

export function createMappingRuleRequest(input: CreateMappingRuleInput) {
	requireInput(input.mappingRuleId, "mappingRuleId");
	requireInput(input.name, "name");
	requireInput(input.claimName, "claimName");
	requireInput(input.claimValue, "claimValue");
	return {
		method: "POST",
		endpoint: "/mapping-rules",
		body: {
			mappingRuleId: input.mappingRuleId,
			name: input.name,
			claimName: input.claimName,
			claimValue: input.claimValue,
		},
	};
}

export async function createMappingRule(
	input: CreateMappingRuleInput & ClusterInput,
	ctx: C8ctlContext = {},
): Promise<{ mappingRuleId: string }> {
	const { client } = connect(input.target, ctx);
	const { body } = createMappingRuleRequest(input);
	const mappingRuleId = brandInput(
		"mappingRuleId",
		body.mappingRuleId,
		MappingRuleId.assumeExists,
	);
	await callCluster(
		() => client.createMappingRule({ ...body, mappingRuleId }),
		ctx,
	);
	return { mappingRuleId: input.mappingRuleId };
}

export function deleteMappingRuleRequest(input: MappingRuleIdInput) {
	return {
		method: "DELETE",
		endpoint: `/mapping-rules/${encodeURIComponent(input.mappingRuleId)}`,
		body: null,
	};
}

export async function deleteMappingRule(
	input: MappingRuleIdInput & ClusterInput,
	ctx: C8ctlContext = {},
): Promise<{ mappingRuleId: string }> {
	const { client } = connect(input.target, ctx);
	const mappingRuleId = brandInput(
		"mappingRuleId",
		input.mappingRuleId,
		MappingRuleId.assumeExists,
	);
	await callCluster(() => client.deleteMappingRule({ mappingRuleId }), ctx);
	return { mappingRuleId: input.mappingRuleId };
}
