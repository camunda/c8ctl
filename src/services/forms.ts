/**
 * Form services: the form of a user task, the start form of a process
 * definition.
 */

import {
	type FormResult,
	ProcessDefinitionKey,
	UserTaskKey,
} from "@camunda8/orchestration-cluster-api";
import type { C8ctlContext, ClusterInput } from "../core/index.ts";
import {
	brandInput,
	callCluster,
	connect,
	isRecord,
	withAbort,
} from "../core/index.ts";

const CONSISTENCY = { consistency: { waitUpToMs: 0 } };

/** HTTP status of an SDK error (SDK errors expose statusCode or status). */
function statusOf(error: unknown): number | undefined {
	if (isRecord(error)) {
		if (typeof error.statusCode === "number") return error.statusCode;
		if (typeof error.status === "number") return error.status;
	}
	return undefined;
}

/** The SDK types "no form" as `void`; anything else is the form. */
function isForm(value: unknown): value is FormResult {
	return value !== null && value !== undefined;
}

/** The form, or `null` when there is none (the API answers 204). */
async function formOrNull(
	request: () => Promise<unknown>,
): Promise<FormResult | null> {
	try {
		const form = await request();
		return isForm(form) ? form : null;
	} catch (error) {
		if (statusOf(error) === 204) return null;
		throw error;
	}
}

export interface UserTaskFormInput {
	userTaskKey: string;
}

export function getUserTaskFormRequest(input: UserTaskFormInput) {
	return { method: "GET", endpoint: `/user-tasks/${input.userTaskKey}/form` };
}

/** The form of a user task; `null` if it has none. */
export async function getUserTaskForm(
	input: UserTaskFormInput & ClusterInput,
	ctx: C8ctlContext = {},
): Promise<FormResult | null> {
	const { client } = connect(input.target, ctx);
	const userTaskKey = brandInput(
		"userTaskKey",
		input.userTaskKey,
		UserTaskKey.assumeExists,
	);
	return callCluster(
		(signal) =>
			formOrNull(() =>
				withAbort(
					() => client.getUserTaskForm({ userTaskKey }, CONSISTENCY),
					signal,
				),
			),
		ctx,
	);
}

export interface ProcessDefinitionFormInput {
	processDefinitionKey: string;
}

export function getProcessDefinitionFormRequest(
	input: ProcessDefinitionFormInput,
) {
	return {
		method: "GET",
		endpoint: `/process-definitions/${input.processDefinitionKey}/form`,
	};
}

/** The start form of a process definition; `null` if it has none. */
export async function getProcessDefinitionForm(
	input: ProcessDefinitionFormInput & ClusterInput,
	ctx: C8ctlContext = {},
): Promise<FormResult | null> {
	const { client } = connect(input.target, ctx);
	const processDefinitionKey = brandInput(
		"processDefinitionKey",
		input.processDefinitionKey,
		ProcessDefinitionKey.assumeExists,
	);
	return callCluster(
		(signal) =>
			formOrNull(() =>
				withAbort(
					() =>
						client.getStartProcessForm({ processDefinitionKey }, CONSISTENCY),
					signal,
				),
			),
		ctx,
	);
}
