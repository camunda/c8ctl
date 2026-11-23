/**
 * Process instance services: list, get, create, await, cancel, suspend,
 * resume, migrate, modify.
 */

import {
	BusinessId,
	type CamundaClient,
	type createProcessInstanceInput,
	ElementId,
	type MigrateProcessInstanceMappingInstruction,
	type migrateProcessInstancesBatchOperationInput,
	type modifyProcessInstancesBatchOperationInput,
	ProcessDefinitionId,
	ProcessDefinitionKey,
	ProcessInstanceKey,
	type ProcessInstanceModificationActivateInstruction,
	type ProcessInstanceModificationInstruction,
	type ProcessInstanceModificationMoveBatchOperationInstruction,
	type ProcessInstanceModificationMoveInstruction,
	type ProcessInstanceModificationTerminateInstruction,
	TenantId,
} from "@camunda8/orchestration-cluster-api";
import type { C8ctlContext, ClusterInput } from "../core/index.ts";
import {
	brandInput,
	C8ctlError,
	callCluster,
	connect,
	fetchAllPages,
} from "../core/index.ts";
import { buildDateFilter, parseBetween } from "../utils/index.ts";

type ProcessInstance = Awaited<ReturnType<CamundaClient["getProcessInstance"]>>;
type Variable = Awaited<
	ReturnType<CamundaClient["searchVariables"]>
>["items"][number];
type CreatedProcessInstance = Awaited<
	ReturnType<CamundaClient["createProcessInstance"]>
>;

const CONSISTENCY = { consistency: { waitUpToMs: 0 } };

// ─── list ────────────────────────────────────────────────────────────────────

export interface ListProcessInstancesInput {
	processDefinitionId?: string;
	businessId?: string;
	/** Process definition version. */
	version?: number;
	/** Instance state. Default: `ACTIVE`, unless `all` is set. */
	state?: string;
	/** Include instances in every state (no default state filter). */
	all?: boolean;
	/** Date range `<from>..<to>`, e.g. `7d` or `2024-01-01..`. */
	between?: string;
	/** Date field `between` filters on. Default: `startDate`. */
	dateField?: string;
	/** Maximum number of process instances. Default: all. */
	limit?: number;
}

/** The search request `listProcessInstances` sends. */
export function listProcessInstancesRequest(
	input: ListProcessInstancesInput,
	tenantId: string | undefined,
) {
	const filter: Record<string, unknown> = { tenantId };
	if (input.processDefinitionId) {
		filter.processDefinitionId = input.processDefinitionId;
	}
	if (input.businessId) filter.businessId = input.businessId;
	if (input.version !== undefined && !Number.isNaN(input.version)) {
		filter.processDefinitionVersion = input.version;
	}
	if (input.state) {
		filter.state = input.state;
	} else if (!input.all) {
		filter.state = "ACTIVE";
	}
	if (input.between) {
		const parsed = parseBetween(input.between);
		if (!parsed) {
			throw new C8ctlError(
				"invalid-input",
				"Invalid --between value. Expected format: <from>..<to> (e.g. 2024-01-01..2024-12-31, ISO 8601 datetimes, or open-ended: ..2024-12-31 or 2024-01-01..)",
				{ field: "between" },
			);
		}
		filter[input.dateField ?? "startDate"] = buildDateFilter(
			parsed.from,
			parsed.to,
		);
	}
	return {
		method: "POST",
		endpoint: "/process-instances/search",
		body: { filter },
	};
}

export async function listProcessInstances(
	input: ListProcessInstancesInput & ClusterInput,
	ctx: C8ctlContext = {},
): Promise<{ items: ProcessInstance[] }> {
	const { client, defaultTenantId } = connect(input.target, ctx);
	const { body } = listProcessInstancesRequest(
		input,
		input.tenantId ?? defaultTenantId,
	);
	const items = await callCluster(
		(signal) =>
			fetchAllPages(
				(filter, options) => client.searchProcessInstances(filter, options),
				body,
				undefined,
				input.limit,
				signal,
			),
		ctx,
	);
	return { items };
}

// ─── get ─────────────────────────────────────────────────────────────────────

export interface ProcessInstanceKeyInput {
	processInstanceKey: string;
}

export interface GetProcessInstanceInput extends ProcessInstanceKeyInput {
	/** Add the instance's variables (values not truncated). */
	includeVariables?: boolean;
}

export function getProcessInstanceRequest(input: ProcessInstanceKeyInput) {
	return {
		method: "GET",
		endpoint: `/process-instances/${input.processInstanceKey}`,
	};
}

export async function getProcessInstance(
	input: GetProcessInstanceInput & ClusterInput,
	ctx: C8ctlContext = {},
): Promise<ProcessInstance & { variables?: Variable[] }> {
	const { client } = connect(input.target, ctx);
	const processInstanceKey = input.processInstanceKey;
	const result = await callCluster(
		() => client.getProcessInstance({ processInstanceKey }, CONSISTENCY),
		ctx,
	);
	if (!input.includeVariables) return result;

	const filter = {
		processInstanceKey: brandInput(
			"processInstanceKey",
			processInstanceKey,
			ProcessInstanceKey.assumeExists,
		),
	};
	const variables = await callCluster(
		() =>
			client.searchVariables({ filter, truncateValues: false }, CONSISTENCY),
		ctx,
	);
	return { ...result, variables: variables.items || [] };
}

// ─── create / await ──────────────────────────────────────────────────────────

export interface CreateProcessInstanceInput {
	/** The process to start, by ID. Give this or `processDefinitionKey`. */
	processDefinitionId?: string;
	/** The exact deployed process definition to start. */
	processDefinitionKey?: string;
	/** Process definition version (with `processDefinitionId`). Default: the latest. */
	version?: number;
	/** Start at these elements instead of the start event. */
	startInstructions?: { elementId: string }[];
	/** E.g. terminate the instance after an element completed. */
	runtimeInstructions?: {
		type: "TERMINATE_PROCESS_INSTANCE";
		afterElementId: string;
	}[];
	variables?: Record<string, unknown>;
	businessId?: string;
	/** Wait for the instance to complete and return its variables. */
	awaitCompletion?: boolean;
	/** Timeout in milliseconds when awaiting completion. */
	requestTimeout?: number;
}

export type AwaitProcessInstanceInput = Omit<
	CreateProcessInstanceInput,
	"awaitCompletion"
>;

/** The request `createProcessInstance` sends. */
export function createProcessInstanceRequest(
	input: CreateProcessInstanceInput,
	tenantId: string | undefined,
) {
	const body: Record<string, unknown> =
		input.processDefinitionKey !== undefined
			? { processDefinitionKey: input.processDefinitionKey, tenantId }
			: { processDefinitionId: input.processDefinitionId, tenantId };
	if (input.version !== undefined) {
		body.processDefinitionVersion = input.version;
	}
	if (input.variables !== undefined) body.variables = input.variables;
	if (input.businessId) body.businessId = input.businessId;
	if (input.startInstructions) body.startInstructions = input.startInstructions;
	if (input.runtimeInstructions) {
		body.runtimeInstructions = input.runtimeInstructions;
	}
	if (input.awaitCompletion) body.awaitCompletion = true;
	if (input.requestTimeout !== undefined) {
		body.requestTimeout = input.requestTimeout;
	}
	return { method: "POST", endpoint: "/process-instances", body };
}

/** The request `awaitProcessInstance` sends. */
export function awaitProcessInstanceRequest(
	input: AwaitProcessInstanceInput,
	tenantId: string | undefined,
) {
	const body: Record<string, unknown> = {
		processDefinitionId: input.processDefinitionId,
		tenantId,
		awaitCompletion: true,
	};
	if (input.version !== undefined) {
		body.processDefinitionVersion = input.version;
	}
	if (input.variables !== undefined) body.variables = input.variables;
	if (input.businessId) body.businessId = input.businessId;
	if (input.requestTimeout !== undefined) {
		body.requestTimeout = input.requestTimeout;
	}
	return { method: "POST", endpoint: "/process-instances", body };
}

export async function createProcessInstance(
	input: CreateProcessInstanceInput & ClusterInput,
	ctx: C8ctlContext = {},
): Promise<CreatedProcessInstance> {
	if (
		(input.processDefinitionId === undefined) ===
		(input.processDefinitionKey === undefined)
	) {
		throw new C8ctlError(
			"invalid-input",
			"Give either processDefinitionId or processDefinitionKey.",
			{ field: "processDefinitionId" },
		);
	}
	const { client, defaultTenantId } = connect(input.target, ctx);
	const tenantId = input.tenantId ?? defaultTenantId;
	const definition =
		input.processDefinitionKey !== undefined
			? {
					processDefinitionKey: brandInput(
						"processDefinitionKey",
						input.processDefinitionKey,
						ProcessDefinitionKey.assumeExists,
					),
				}
			: {
					processDefinitionId: brandInput(
						"processDefinitionId",
						input.processDefinitionId ?? "",
						ProcessDefinitionId.assumeExists,
					),
				};
	const request = {
		...definition,
		...(input.startInstructions && {
			startInstructions: input.startInstructions.map(({ elementId }) => ({
				elementId: ElementId.assumeExists(elementId),
			})),
		}),
		...(input.runtimeInstructions && {
			runtimeInstructions: input.runtimeInstructions.map((instruction) => ({
				type: instruction.type,
				afterElementId: ElementId.assumeExists(instruction.afterElementId),
			})),
		}),
		...(tenantId !== undefined && {
			tenantId: TenantId.assumeExists(tenantId),
		}),
		...(input.version !== undefined && {
			processDefinitionVersion: input.version,
		}),
		...(input.variables !== undefined && { variables: input.variables }),
		...(input.businessId !== undefined && {
			businessId: brandInput(
				"businessId",
				input.businessId,
				BusinessId.assumeExists,
			),
		}),
		...(input.awaitCompletion && { awaitCompletion: true }),
		...(input.requestTimeout !== undefined && {
			requestTimeout: input.requestTimeout,
		}),
	} satisfies createProcessInstanceInput;
	return callCluster(() => client.createProcessInstance(request), ctx);
}

/** Create a process instance and wait for it to complete. */
export async function awaitProcessInstance(
	input: AwaitProcessInstanceInput & ClusterInput,
	ctx: C8ctlContext = {},
): Promise<CreatedProcessInstance> {
	return createProcessInstance({ ...input, awaitCompletion: true }, ctx);
}

// ─── cancel / suspend / resume ───────────────────────────────────────────────

export function cancelProcessInstanceRequest(input: ProcessInstanceKeyInput) {
	return {
		method: "POST",
		endpoint: `/process-instances/${input.processInstanceKey}/cancellation`,
		body: {},
	};
}

export async function cancelProcessInstance(
	input: ProcessInstanceKeyInput & ClusterInput,
	ctx: C8ctlContext = {},
): Promise<{ processInstanceKey: string }> {
	const { client } = connect(input.target, ctx);
	await callCluster(
		() =>
			client.cancelProcessInstance({
				processInstanceKey: input.processInstanceKey,
			}),
		ctx,
	);
	return { processInstanceKey: input.processInstanceKey };
}

export function suspendProcessInstanceRequest(input: ProcessInstanceKeyInput) {
	return {
		method: "POST",
		endpoint: `/process-instances/${input.processInstanceKey}/suspension`,
		body: {},
	};
}

export async function suspendProcessInstance(
	input: ProcessInstanceKeyInput & ClusterInput,
	ctx: C8ctlContext = {},
): Promise<{ processInstanceKey: string }> {
	const { client } = connect(input.target, ctx);
	await callCluster(
		() =>
			client.suspendProcessInstance({
				processInstanceKey: input.processInstanceKey,
			}),
		ctx,
	);
	return { processInstanceKey: input.processInstanceKey };
}

export function resumeProcessInstanceRequest(input: ProcessInstanceKeyInput) {
	return {
		method: "POST",
		endpoint: `/process-instances/${input.processInstanceKey}/resumption`,
		body: {},
	};
}

export async function resumeProcessInstance(
	input: ProcessInstanceKeyInput & ClusterInput,
	ctx: C8ctlContext = {},
): Promise<{ processInstanceKey: string }> {
	const { client } = connect(input.target, ctx);
	await callCluster(
		() =>
			client.resumeProcessInstance({
				processInstanceKey: input.processInstanceKey,
			}),
		ctx,
	);
	return { processInstanceKey: input.processInstanceKey };
}

function definitionKeyOf(input: { processDefinitionKey: string }) {
	return brandInput(
		"processDefinitionKey",
		input.processDefinitionKey,
		ProcessDefinitionKey.assumeExists,
	);
}

// ─── migrate ─────────────────────────────────────────────────────────────────

/** Map each active source element to its counterpart in the target. */
export interface MigrationPlanInput {
	targetProcessDefinitionKey: string;
	mappingInstructions: MigrateProcessInstanceMappingInstruction[];
}

export interface MigrateProcessInstanceInput
	extends ProcessInstanceKeyInput,
		MigrationPlanInput {}

/** Migrate every active instance of a source process definition. */
export interface MigrateProcessInstancesInput extends MigrationPlanInput {
	processDefinitionKey: string;
}

function migrationPlanOf(input: MigrationPlanInput) {
	return {
		targetProcessDefinitionKey: brandInput(
			"targetProcessDefinitionKey",
			input.targetProcessDefinitionKey,
			ProcessDefinitionKey.assumeExists,
		),
		mappingInstructions: input.mappingInstructions,
	};
}

export function migrateProcessInstanceRequest(
	input: MigrateProcessInstanceInput,
) {
	return {
		method: "POST",
		endpoint: `/process-instances/${input.processInstanceKey}/migration`,
		body: migrationPlanOf(input),
	};
}

export async function migrateProcessInstance(
	input: MigrateProcessInstanceInput & ClusterInput,
	ctx: C8ctlContext = {},
): Promise<{ processInstanceKey: string; targetProcessDefinitionKey: string }> {
	const { client } = connect(input.target, ctx);
	const { body } = migrateProcessInstanceRequest(input);
	await callCluster(
		() =>
			client.migrateProcessInstance({
				processInstanceKey: input.processInstanceKey,
				...body,
			}),
		ctx,
	);
	return {
		processInstanceKey: input.processInstanceKey,
		targetProcessDefinitionKey: input.targetProcessDefinitionKey,
	};
}

export function migrateProcessInstancesRequest(
	input: MigrateProcessInstancesInput,
) {
	return {
		method: "POST",
		endpoint: "/process-instances/migration",
		body: {
			filter: { processDefinitionKey: definitionKeyOf(input) },
			migrationPlan: migrationPlanOf(input),
		} satisfies migrateProcessInstancesBatchOperationInput,
	};
}

/** Start a batch operation that migrates the instances. */
export async function migrateProcessInstances(
	input: MigrateProcessInstancesInput & ClusterInput,
	ctx: C8ctlContext = {},
): Promise<{ batchOperationKey: string }> {
	const { client } = connect(input.target, ctx);
	const { body } = migrateProcessInstancesRequest(input);
	const result = await callCluster(
		() => client.migrateProcessInstancesBatchOperation(body),
		ctx,
	);
	return { batchOperationKey: result.batchOperationKey };
}

// ─── modify ──────────────────────────────────────────────────────────────────

export interface ModifyProcessInstanceInput extends ProcessInstanceKeyInput {
	activateInstructions?: ProcessInstanceModificationActivateInstruction[];
	moveInstructions?: ProcessInstanceModificationMoveInstruction[];
	terminateInstructions?: ProcessInstanceModificationTerminateInstruction[];
	/** Positive integer that marks the resulting events. */
	operationReference?: number;
}

/** Move tokens in every active instance of a process definition. */
export interface ModifyProcessInstancesInput {
	processDefinitionKey: string;
	moveInstructions: ProcessInstanceModificationMoveBatchOperationInstruction[];
	/** Positive integer that marks the resulting events. */
	operationReference?: number;
}

export function modifyProcessInstanceRequest(
	input: ModifyProcessInstanceInput,
) {
	const activate = input.activateInstructions ?? [];
	const move = input.moveInstructions ?? [];
	const terminate = input.terminateInstructions ?? [];
	return {
		method: "POST",
		endpoint: `/process-instances/${input.processInstanceKey}/modification`,
		body: {
			...(activate.length > 0 && { activateInstructions: activate }),
			...(move.length > 0 && { moveInstructions: move }),
			...(terminate.length > 0 && { terminateInstructions: terminate }),
			...(input.operationReference !== undefined && {
				operationReference: input.operationReference,
			}),
		} satisfies ProcessInstanceModificationInstruction,
	};
}

export async function modifyProcessInstance(
	input: ModifyProcessInstanceInput & ClusterInput,
	ctx: C8ctlContext = {},
): Promise<{ processInstanceKey: string }> {
	const { client } = connect(input.target, ctx);
	const { body } = modifyProcessInstanceRequest(input);
	await callCluster(
		() =>
			client.modifyProcessInstance({
				processInstanceKey: input.processInstanceKey,
				...body,
			}),
		ctx,
	);
	return { processInstanceKey: input.processInstanceKey };
}

export function modifyProcessInstancesRequest(
	input: ModifyProcessInstancesInput,
) {
	return {
		method: "POST",
		endpoint: "/process-instances/modification",
		body: {
			filter: { processDefinitionKey: definitionKeyOf(input) },
			moveInstructions: input.moveInstructions,
			...(input.operationReference !== undefined && {
				operationReference: input.operationReference,
			}),
		} satisfies modifyProcessInstancesBatchOperationInput,
	};
}

/** Start a batch operation that modifies the instances. */
export async function modifyProcessInstances(
	input: ModifyProcessInstancesInput & ClusterInput,
	ctx: C8ctlContext = {},
): Promise<{ batchOperationKey: string }> {
	const { client } = connect(input.target, ctx);
	const { body } = modifyProcessInstancesRequest(input);
	const result = await callCluster(
		() => client.modifyProcessInstancesBatchOperation(body),
		ctx,
	);
	return { batchOperationKey: result.batchOperationKey };
}
