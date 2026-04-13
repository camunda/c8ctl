/**
 * Form commands
 */

import {
	ProcessDefinitionKey,
	UserTaskKey,
} from "@camunda8/orchestration-cluster-api";
import { createClient, emitDryRun } from "../client.ts";
import { isRecord } from "../index.ts";
import { getLogger } from "../logger.ts";

/** Extract HTTP status code from an unknown error (SDK errors expose statusCode or status). */
function getErrorStatus(error: unknown): number | undefined {
	if (isRecord(error)) {
		if (typeof error.statusCode === "number") return error.statusCode;
		if (typeof error.status === "number") return error.status;
	}
	return undefined;
}

/**
 * Get form for a user task
 */
export async function getUserTaskForm(
	userTaskKey: string,
	options: {
		profile?: string;
	},
): Promise<Record<string, unknown> | undefined> {
	if (
		emitDryRun({
			command: "get form --userTask",
			method: "GET",
			endpoint: `/user-tasks/${userTaskKey}/form`,
			profile: options.profile,
		})
	)
		return;
	const logger = getLogger();
	const client = createClient(options.profile);

	try {
		const result = await client.getUserTaskForm(
			{ userTaskKey: UserTaskKey.assumeExists(userTaskKey) },
			{ consistency: { waitUpToMs: 0 } },
		);
		// API returns null when user task exists but has no form
		if (result === null || result === undefined) {
			logger.info("User task found but has no associated form");
			return undefined;
		}
		logger.json(result);

		return;
	} catch (error: unknown) {
		// Handle 204 No Content (user task exists but has no form)
		if (getErrorStatus(error) === 204) {
			logger.info("User task found but has no associated form");
			return undefined;
		}
		logger.error(
			`Failed to get form for user task ${userTaskKey}`,
			error instanceof Error ? error : new Error(String(error)),
		);
		process.exit(1);
	}
}

/**
 * Get start form for a process definition
 */
export async function getStartForm(
	processDefinitionKey: string,
	options: {
		profile?: string;
	},
): Promise<Record<string, unknown> | undefined> {
	if (
		emitDryRun({
			command: "get form --processDefinition",
			method: "GET",
			endpoint: `/process-definitions/${processDefinitionKey}/form`,
			profile: options.profile,
		})
	)
		return;
	const logger = getLogger();
	const client = createClient(options.profile);

	try {
		const result = await client.getStartProcessForm(
			{
				processDefinitionKey:
					ProcessDefinitionKey.assumeExists(processDefinitionKey),
			},
			{ consistency: { waitUpToMs: 0 } },
		);
		// API returns null when process definition exists but has no start form
		if (result === null || result === undefined) {
			logger.info("Process definition found but has no associated start form");
			return undefined;
		}
		logger.json(result);
		// biome-ignore lint/plugin: safe widening — SDK result to generic Record return type
		return result as Record<string, unknown>;
	} catch (error: unknown) {
		// Handle 204 No Content (process definition exists but has no form)
		if (getErrorStatus(error) === 204) {
			logger.info("Process definition found but has no associated start form");
			return undefined;
		}
		logger.error(
			`Failed to get start form for process definition ${processDefinitionKey}`,
			error instanceof Error ? error : new Error(String(error)),
		);
		process.exit(1);
	}
}

/**
 * Get form by trying both user task and process definition APIs
 */
export async function getForm(
	key: string,
	options: {
		profile?: string;
	},
): Promise<
	{ type: string; key: string; form: Record<string, unknown> } | undefined
> {
	if (
		emitDryRun({
			command: "get form",
			method: "GET",
			endpoint: `/user-tasks/${key}/form (then /process-definitions/${key}/form)`,
			profile: options.profile,
		})
	)
		return;
	const logger = getLogger();
	const client = createClient(options.profile);

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
		// 204 means resource exists but no form - not an error
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
		// 204 means resource exists but no form - not an error
		if (getErrorStatus(error) !== 204) {
			errors.push({ type: "process definition", error });
		}
	}

	// Report results
	if (results.length === 0) {
		if (errors.length === 0) {
			logger.info("No form found for user task or process definition");
			return undefined;
		} else if (errors.length === 1) {
			logger.error(
				`Failed to get form: not found as ${errors[0].type}`,
				errors[0].error instanceof Error
					? errors[0].error
					: new Error(String(errors[0].error)),
			);
			process.exit(1);
		} else {
			logger.error(
				"Failed to get form: not found as user task or process definition",
			);
			process.exit(1);
		}
	} else if (results.length === 1) {
		const keyType =
			results[0].type === "user task" ? "userTaskKey" : "processDefinitionKey";
		logger.info(`Form found for ${results[0].type} (${keyType}: ${key}):`);
		logger.json(results[0].form);
		return {
			type: results[0].type,
			key,
			// biome-ignore lint/plugin: safe widening — SDK result to generic Record return type
			form: results[0].form as Record<string, unknown>,
		};
	} else {
		logger.info(
			`Form found in both user task and process definition (key: ${key}):`,
		);
		const combined = {
			userTaskKey: key,
			userTask: results.find((r) => r.type === "user task")?.form,
			processDefinitionKey: key,
			processDefinition: results.find((r) => r.type === "process definition")
				?.form,
		};
		logger.json(combined);
		// biome-ignore lint/plugin: safe widening — combined object to generic Record return type
		return { type: "both", key, form: combined as Record<string, unknown> };
	}
}
