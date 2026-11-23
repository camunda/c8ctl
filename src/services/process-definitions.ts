/**
 * Process definition services: list, get, get XML.
 */

import type { CamundaClient } from "@camunda8/orchestration-cluster-api";
import type { C8ctlContext, ClusterInput } from "../core/index.ts";
import { callCluster, connect, fetchAllPages } from "../core/index.ts";

type ProcessDefinition = Awaited<
	ReturnType<CamundaClient["getProcessDefinition"]>
>;

export interface ListProcessDefinitionsInput {
	/** Maximum number of process definitions. Default: all. */
	limit?: number;
}

/** The search request `listProcessDefinitions` sends. */
export function listProcessDefinitionsRequest(
	_input: ListProcessDefinitionsInput,
	tenantId: string | undefined,
) {
	const filter: Record<string, unknown> = { tenantId };
	return {
		method: "POST",
		endpoint: "/process-definitions/search",
		body: { filter },
	};
}

export async function listProcessDefinitions(
	input: ListProcessDefinitionsInput & ClusterInput,
	ctx: C8ctlContext = {},
): Promise<{ items: ProcessDefinition[] }> {
	const { client, defaultTenantId } = connect(input.target, ctx);
	const { body } = listProcessDefinitionsRequest(
		input,
		input.tenantId ?? defaultTenantId,
	);
	const items = await callCluster(
		(signal) =>
			fetchAllPages(
				(filter, options) => client.searchProcessDefinitions(filter, options),
				body,
				undefined,
				input.limit,
				signal,
			),
		ctx,
	);
	return { items };
}

export interface ProcessDefinitionKeyInput {
	processDefinitionKey: string;
}

export function getProcessDefinitionRequest(input: ProcessDefinitionKeyInput) {
	return {
		method: "GET",
		endpoint: `/process-definitions/${input.processDefinitionKey}`,
	};
}

export async function getProcessDefinition(
	input: ProcessDefinitionKeyInput & ClusterInput,
	ctx: C8ctlContext = {},
): Promise<ProcessDefinition> {
	const { client } = connect(input.target, ctx);
	return callCluster(
		() =>
			client.getProcessDefinition(
				{ processDefinitionKey: input.processDefinitionKey },
				{ consistency: { waitUpToMs: 0 } },
			),
		ctx,
	);
}

export function getProcessDefinitionXmlRequest(
	input: ProcessDefinitionKeyInput,
) {
	return {
		method: "GET",
		endpoint: `/process-definitions/${input.processDefinitionKey}/xml`,
	};
}

/** The BPMN XML of a process definition. */
export async function getProcessDefinitionXml(
	input: ProcessDefinitionKeyInput & ClusterInput,
	ctx: C8ctlContext = {},
): Promise<string> {
	const { client } = connect(input.target, ctx);
	return callCluster(
		() =>
			client.getProcessDefinitionXml(
				{ processDefinitionKey: input.processDefinitionKey },
				{ consistency: { waitUpToMs: 0 } },
			),
		ctx,
	);
}
