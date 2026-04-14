/**
 * Form commands
 */

import {
	type CamundaClient,
	ProcessDefinitionKey,
	UserTaskKey,
} from "@camunda8/orchestration-cluster-api";
import {
	type CommandResult,
	defineCommand,
	dryRun,
} from "../command-framework.ts";
import { isRecord } from "../logger.ts";

/** Extract HTTP status code from an unknown error (SDK errors expose statusCode or status). */
function getErrorStatus(error: unknown): number | undefined {
	if (isRecord(error)) {
		if (typeof error.statusCode === "number") return error.statusCode;
		if (typeof error.status === "number") return error.status;
	}
	return undefined;
}

/**
 * Get form by key, optionally scoped to user task or process definition
 */
export const getFormCommand = defineCommand(
	"get",
	"form",
	async (ctx, _flags, args) => {
		const { client, logger, profile } = ctx;
		const key = args.key;

		// Check for flags and their aliases
		const isUserTask =
			process.argv.includes("--userTask") || process.argv.includes("--ut");
		const isProcessDefinition =
			process.argv.includes("--processDefinition") ||
			process.argv.includes("--pd");

		// If both flags specified, error
		if (isUserTask && isProcessDefinition) {
			logger.error(
				"Cannot specify both --userTask|--ut and --processDefinition|--pd. Use one or the other, or omit both to search both types.",
			);
			process.exit(1);
		}

		if (isUserTask) {
			return handleUserTaskForm(key, profile, client);
		}
		if (isProcessDefinition) {
			return handleStartForm(key, profile, client);
		}
		return handleFormBoth(key, profile, client);
	},
);

async function handleUserTaskForm(
	userTaskKey: string,
	profile: string | undefined,
	client: CamundaClient,
): Promise<CommandResult> {
	const dr = dryRun({
		command: "get form --userTask",
		method: "GET",
		endpoint: `/user-tasks/${userTaskKey}/form`,
		profile,
	});
	if (dr) return dr;

	try {
		const result = await client.getUserTaskForm(
			{ userTaskKey: UserTaskKey.assumeExists(userTaskKey) },
			{ consistency: { waitUpToMs: 0 } },
		);
		if (result === null || result === undefined) {
			return {
				kind: "info",
				message: "User task found but has no associated form",
			};
		}
		return { kind: "get", data: result };
	} catch (error: unknown) {
		if (getErrorStatus(error) === 204) {
			return {
				kind: "info",
				message: "User task found but has no associated form",
			};
		}
		throw error;
	}
}

async function handleStartForm(
	processDefinitionKey: string,
	profile: string | undefined,
	client: CamundaClient,
): Promise<CommandResult> {
	const dr = dryRun({
		command: "get form --processDefinition",
		method: "GET",
		endpoint: `/process-definitions/${processDefinitionKey}/form`,
		profile,
	});
	if (dr) return dr;

	try {
		const result = await client.getStartProcessForm(
			{
				processDefinitionKey:
					ProcessDefinitionKey.assumeExists(processDefinitionKey),
			},
			{ consistency: { waitUpToMs: 0 } },
		);
		if (result === null || result === undefined) {
			return {
				kind: "info",
				message: "Process definition found but has no associated start form",
			};
		}
		return { kind: "get", data: result };
	} catch (error: unknown) {
		if (getErrorStatus(error) === 204) {
			return {
				kind: "info",
				message: "Process definition found but has no associated start form",
			};
		}
		throw error;
	}
}

async function handleFormBoth(
	key: string,
	profile: string | undefined,
	client: CamundaClient,
): Promise<CommandResult> {
	const dr = dryRun({
		command: "get form",
		method: "GET",
		endpoint: `/user-tasks/${key}/form (then /process-definitions/${key}/form)`,
		profile,
	});
	if (dr) return dr;

	const results: {
		type: string;
		key: string;
		form: Record<string, unknown>;
	}[] = [];
	const errors: { type: string; error: unknown }[] = [];

	// Try user task form
	try {
		const result = await client.getUserTaskForm(
			{ userTaskKey: UserTaskKey.assumeExists(key) },
			{ consistency: { waitUpToMs: 0 } },
		);
		if (result !== null && result !== undefined) {
			results.push({ type: "user task", key, form: result });
		}
	} catch (error: unknown) {
		if (getErrorStatus(error) !== 204) {
			errors.push({ type: "user task", error });
		}
	}

	// Try process definition form
	try {
		const result = await client.getStartProcessForm(
			{ processDefinitionKey: ProcessDefinitionKey.assumeExists(key) },
			{ consistency: { waitUpToMs: 0 } },
		);
		if (result !== null && result !== undefined) {
			results.push({ type: "process definition", key, form: result });
		}
	} catch (error: unknown) {
		if (getErrorStatus(error) !== 204) {
			errors.push({ type: "process definition", error });
		}
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
			throw errors[0].error instanceof Error
				? errors[0].error
				: new Error(`not found as ${errors[0].type}`);
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
