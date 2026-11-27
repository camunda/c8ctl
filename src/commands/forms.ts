/**
 * Form commands. `get form` looks up the form of a user task, the start
 * form of a process definition, or tries both; each lookup is an
 * service.
 */

import type { FormResult } from "@camunda8/orchestration-cluster-api";
import { C8ctlError, isC8ctlError } from "../core/index.ts";
import {
	type CommandContext,
	type CommandResult,
	clusterInputOf,
	defineCommand,
} from "../framework/index.ts";
import {
	getProcessDefinitionForm,
	getProcessDefinitionFormRequest,
	getUserTaskForm,
	getUserTaskFormRequest,
} from "../services/index.ts";

/**
 * Get form by key, optionally scoped to user task or process definition
 */
export const getFormCommand = defineCommand(
	"get",
	"form",
	async (ctx, flags, args) => {
		const key = args.key;

		const isUserTask = flags.userTask === true || flags.ut === true;
		const isProcessDefinition =
			flags.processDefinition === true || flags.pd === true;

		// If both flags specified, error
		if (isUserTask && isProcessDefinition) {
			throw new C8ctlError(
				"invalid-input",
				"Cannot specify both --userTask|--ut and --processDefinition|--pd. Use one or the other, or omit both to search both types.",
				{ field: "processDefinition" },
			);
		}

		if (isUserTask) {
			return handleUserTaskForm(key, ctx);
		}
		if (isProcessDefinition) {
			return handleStartForm(key, ctx);
		}
		return handleFormBoth(key, ctx);
	},
);

async function handleUserTaskForm(
	userTaskKey: string,
	ctx: CommandContext,
): Promise<CommandResult> {
	const input = { userTaskKey };
	const dr = ctx.dryRun({
		command: "get form --userTask",
		profile: ctx.profile,
		...getUserTaskFormRequest(input),
	});
	if (dr) return dr;

	const form = await getUserTaskForm({ ...input, ...clusterInputOf(ctx) }, {});
	if (form === null) {
		return {
			kind: "info",
			message: "User task found but has no associated form",
		};
	}
	return { kind: "get", data: form };
}

async function handleStartForm(
	processDefinitionKey: string,
	ctx: CommandContext,
): Promise<CommandResult> {
	const input = { processDefinitionKey };
	const dr = ctx.dryRun({
		command: "get form --processDefinition",
		profile: ctx.profile,
		...getProcessDefinitionFormRequest(input),
	});
	if (dr) return dr;

	const form = await getProcessDefinitionForm(
		{ ...input, ...clusterInputOf(ctx) },
		{},
	);
	if (form === null) {
		return {
			kind: "info",
			message: "Process definition found but has no associated start form",
		};
	}
	return { kind: "get", data: form };
}

/** The error to report when only one of the two lookups failed. */
function lookupError(error: unknown, type: string): unknown {
	// A request failure keeps the SDK's error as its cause; an error that
	// was not an `Error` (e.g. a bare problem detail) is reported by type.
	const raw =
		isC8ctlError(error) && error.cause !== undefined ? error.cause : error;
	return raw instanceof Error ? error : new Error(`not found as ${type}`);
}

async function handleFormBoth(
	key: string,
	ctx: CommandContext,
): Promise<CommandResult> {
	const dr = ctx.dryRun({
		command: "get form",
		method: "GET",
		endpoint: `/user-tasks/${key}/form (then /process-definitions/${key}/form)`,
		profile: ctx.profile,
	});
	if (dr) return dr;

	const results: {
		type: string;
		key: string;
		form: FormResult;
	}[] = [];
	const errors: { type: string; error: unknown }[] = [];

	// Try user task form
	try {
		const form = await getUserTaskForm(
			{ userTaskKey: key, ...clusterInputOf(ctx) },
			{},
		);
		if (form !== null) {
			results.push({ type: "user task", key, form });
		}
	} catch (error: unknown) {
		errors.push({ type: "user task", error });
	}

	// Try process definition form
	try {
		const form = await getProcessDefinitionForm(
			{ processDefinitionKey: key, ...clusterInputOf(ctx) },
			{},
		);
		if (form !== null) {
			results.push({ type: "process definition", key, form });
		}
	} catch (error: unknown) {
		errors.push({ type: "process definition", error });
	}

	// Report results
	if (results.length === 0) {
		if (errors.length === 0) {
			return {
				kind: "info",
				message: "No form found for user task or process definition",
			};
		}
		if (errors.length === 1) {
			throw lookupError(errors[0].error, errors[0].type);
		}
		throw new Error("not found as user task or process definition");
	}

	if (results.length === 1) {
		const keyType =
			results[0].type === "user task" ? "userTaskKey" : "processDefinitionKey";
		return {
			kind: "get",
			data: results[0].form,
			message: `Form found for ${results[0].type} (${keyType}: ${key}):`,
		};
	}

	return {
		kind: "get",
		data: {
			userTaskKey: key,
			userTask: results.find((r) => r.type === "user task")?.form,
			processDefinitionKey: key,
			processDefinition: results.find((r) => r.type === "process definition")
				?.form,
		},
	};
}
