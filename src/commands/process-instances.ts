/**
 * Process instance commands
 */

import type {
	createProcessInstanceInput,
	migrateProcessInstanceInput,
	migrateProcessInstancesBatchOperationInput,
	modifyProcessInstanceInput,
	modifyProcessInstancesBatchOperationInput,
	ProcessInstanceModificationInstruction,
} from "@camunda8/orchestration-cluster-api";
import {
	ProcessDefinitionId,
	ProcessDefinitionKey,
	TenantId,
} from "@camunda8/orchestration-cluster-api";
import { fetchAllPages } from "../core/index.ts";
import { defineCommand } from "../framework/index.ts";
import {
	buildDateFilter,
	parseActivateFlag,
	parseBetween,
	parseJsonObjectFlag,
	parseMigrationMapping,
	parseModificationInstructions,
	parseMoveFlag,
	parseOperationReference,
	parseTerminateFlag,
	parseVariablesFlag,
	processInstancesEmptyMessage,
	toBatchMoveInstruction,
} from "../utils/index.ts";

/**
 * List process instances
 */
export const listProcessInstancesCommand = defineCommand(
	"list",
	"process-instance",
	async (ctx, flags) => {
		const { client, tenantId, profile, limit, all, between, dateField } = ctx;

		const filter: { filter: Record<string, unknown> } = {
			filter: {
				tenantId,
			},
		};

		const processDefinitionId =
			flags.id || flags.processDefinitionId || flags.bpmnProcessId;
		if (processDefinitionId) {
			filter.filter.processDefinitionId = processDefinitionId;
		}
		if (flags.businessId) {
			filter.filter.businessId = flags.businessId;
		}

		// `--version` is a global flag, parsed as a string after the verb
		// (stage 2 of the two-stage parser) and surfaced as ctx.version.
		const version = ctx.version;
		if (version !== undefined && !Number.isNaN(version)) {
			filter.filter.processDefinitionVersion = version;
		}

		if (flags.state) {
			filter.filter.state = flags.state;
		} else if (!all) {
			filter.filter.state = "ACTIVE";
		}

		if (between) {
			const parsed = parseBetween(between);
			if (parsed) {
				const field = dateField ?? "startDate";
				filter.filter[field] = buildDateFilter(parsed.from, parsed.to);
			} else {
				throw new Error(
					"Invalid --between value. Expected format: <from>..<to> (e.g. 2024-01-01..2024-12-31, ISO 8601 datetimes, or open-ended: ..2024-12-31 or 2024-01-01..)",
				);
			}
		}

		const dr = ctx.dryRun({
			command: "list process-instances",
			method: "POST",
			endpoint: "/process-instances/search",
			profile,
			body: filter,
		});
		if (dr) return dr;

		const allItems = await fetchAllPages(
			(f, opts) => client.searchProcessInstances(f, opts),
			filter,
			undefined,
			limit,
		);

		return {
			kind: "list",
			items: allItems.map((pi) => ({
				Key: `${pi.hasIncident ? "⚠ " : ""}${pi.processInstanceKey}`,
				"Business ID": pi.businessId || "-",
				"Process ID": pi.processDefinitionId,
				State: pi.state,
				Version: pi.processDefinitionVersion,
				"Start Date": pi.startDate || "-",
				"Tenant ID": pi.tenantId,
			})),
			emptyMessage: processInstancesEmptyMessage(filter.filter),
		};
	},
);

/**
 * Get process instance by key
 */
export const getProcessInstanceCommand = defineCommand(
	"get",
	"process-instance",
	async (ctx, flags, args) => {
		const { client, profile } = ctx;
		const key = args.key;
		const consistencyOptions = { consistency: { waitUpToMs: 0 } };
		// --variables is a boolean toggle for `get pi` (and a string for
		// `create pi`): stage 2 parses it against this command's own flag table.
		const includeVariables = flags.variables === true;

		const dr = ctx.dryRun({
			command: "get process-instance",
			method: "GET",
			endpoint: `/process-instances/${key}`,
			profile,
		});
		if (dr) return dr;

		const result = await client.getProcessInstance(
			{ processInstanceKey: key },
			consistencyOptions,
		);

		if (includeVariables) {
			const variablesResult = await client.searchVariables(
				{
					filter: {
						processInstanceKey: key,
					},
					truncateValues: false,
				},
				consistencyOptions,
			);

			return {
				kind: "get",
				data: {
					...result,
					variables: variablesResult.items || [],
				},
			};
		}

		return { kind: "get", data: result };
	},
);

/**
 * Create process instance
 */
export const createProcessInstanceCommand = defineCommand(
	"create",
	"process-instance",
	async (ctx, flags, _args) => {
		const { client, logger, tenantId, profile } = ctx;
		const processDefinitionId =
			flags.id || flags.processDefinitionId || flags.bpmnProcessId;

		if (!processDefinitionId) {
			throw new Error(
				"processDefinitionId is required. Use --processDefinitionId or --bpmnProcessId or --id flag",
			);
		}

		const version = ctx.version;
		const awaitCompletion = flags.awaitCompletion;
		const fetchVariables = flags.fetchVariables;
		const requestTimeout =
			flags.requestTimeout !== undefined
				? parseInt(flags.requestTimeout, 10)
				: undefined;

		// Parse variables early for clear error reporting
		let variables: Record<string, unknown> | undefined;
		if (flags.variables) {
			variables = parseVariablesFlag({ raw: flags.variables });
		}

		// Dry-run: emit the would-be API request without executing
		const body: Record<string, unknown> = {
			processDefinitionId,
			tenantId,
		};
		if (version !== undefined) body.processDefinitionVersion = version;
		if (variables !== undefined) body.variables = variables;
		if (flags.businessId) body.businessId = flags.businessId;
		if (awaitCompletion) body.awaitCompletion = true;
		if (requestTimeout !== undefined) body.requestTimeout = requestTimeout;

		const dr = ctx.dryRun({
			command: "create process-instance",
			method: "POST",
			endpoint: "/process-instances",
			profile,
			body,
		});
		if (dr) return dr;

		// Validate: fetchVariables requires awaitCompletion
		if (fetchVariables && !awaitCompletion) {
			throw new Error(
				"--fetchVariables can only be used with --awaitCompletion",
			);
		}

		// Note: fetchVariables parameter is reserved for future API enhancement
		// The orchestration-cluster-api currently does not support filtering variables
		// The API returns all variables by default when awaitCompletion is true
		if (fetchVariables) {
			logger.info(
				"Note: --fetchVariables is not yet supported by the API. All variables will be returned.",
			);
		}

		if (awaitCompletion) {
			logger.info("Waiting for process instance to complete...");
		}

		// Build the request with SDK types as single source of truth
		const request = {
			processDefinitionId:
				ProcessDefinitionId.assumeExists(processDefinitionId),
			...(tenantId !== undefined && {
				tenantId: TenantId.assumeExists(tenantId),
			}),
			...(version !== undefined && {
				processDefinitionVersion: version,
			}),
			...(variables !== undefined && { variables }),
			...(flags.businessId !== undefined && {
				businessId: flags.businessId,
			}),
			...(awaitCompletion && { awaitCompletion: true }),
			...(requestTimeout !== undefined && {
				requestTimeout,
			}),
		} satisfies createProcessInstanceInput;

		const result = await client.createProcessInstance(request);

		if (awaitCompletion) {
			// When awaitCompletion is true, the API returns the completed process instance with variables
			logger.success("Process instance completed", result.processInstanceKey);
			logger.json(result);
		} else {
			// When awaitCompletion is false, just show the process instance key
			logger.success("Process instance created", result.processInstanceKey);
		}
	},
);

/**
 * Await process instance completion (alias for create --awaitCompletion)
 */
export const awaitProcessInstanceCommand = defineCommand(
	"await",
	"process-instance",
	async (ctx, flags, _args) => {
		const { client, logger, tenantId, profile } = ctx;
		const processDefinitionId =
			flags.id || flags.processDefinitionId || flags.bpmnProcessId;

		if (!processDefinitionId) {
			throw new Error(
				"processDefinitionId is required. Use --processDefinitionId or --bpmnProcessId or --id flag",
			);
		}

		const version = ctx.version;
		const requestTimeout =
			flags.requestTimeout !== undefined
				? parseInt(flags.requestTimeout, 10)
				: undefined;

		// Parse variables early for clear error reporting
		let variables: Record<string, unknown> | undefined;
		if (flags.variables) {
			variables = parseVariablesFlag({ raw: flags.variables });
		}

		// Dry-run: emit the would-be API request without executing
		const body: Record<string, unknown> = {
			processDefinitionId,
			tenantId,
			awaitCompletion: true,
		};
		if (version !== undefined) body.processDefinitionVersion = version;
		if (variables !== undefined) body.variables = variables;
		if (flags.businessId) body.businessId = flags.businessId;
		if (requestTimeout !== undefined) body.requestTimeout = requestTimeout;

		const dr = ctx.dryRun({
			command: "await process-instance",
			method: "POST",
			endpoint: "/process-instances",
			profile,
			body,
		});
		if (dr) return dr;

		// Note: fetchVariables parameter is reserved for future API enhancement
		if (flags.fetchVariables) {
			logger.info(
				"Note: --fetchVariables is not yet supported by the API. All variables will be returned.",
			);
		}

		logger.info("Waiting for process instance to complete...");

		const request = {
			processDefinitionId:
				ProcessDefinitionId.assumeExists(processDefinitionId),
			...(tenantId !== undefined && {
				tenantId: TenantId.assumeExists(tenantId),
			}),
			...(version !== undefined && {
				processDefinitionVersion: version,
			}),
			...(variables !== undefined && { variables }),
			...(flags.businessId !== undefined && {
				businessId: flags.businessId,
			}),
			awaitCompletion: true,
			...(requestTimeout !== undefined && {
				requestTimeout,
			}),
		} satisfies createProcessInstanceInput;

		const result = await client.createProcessInstance(request);

		logger.success("Process instance completed", result.processInstanceKey);
		logger.json(result);
	},
);

/**
 * Cancel process instance
 */
export const cancelProcessInstanceCommand = defineCommand(
	"cancel",
	"process-instance",
	async (ctx, _flags, args) => {
		const { client, profile } = ctx;
		const key = args.key;

		const dr = ctx.dryRun({
			command: "cancel process-instance",
			method: "POST",
			endpoint: `/process-instances/${key}/cancellation`,
			profile,
			body: {},
		});
		if (dr) return dr;

		await client.cancelProcessInstance({ processInstanceKey: key });
		return { kind: "success", message: `Process instance ${key} cancelled` };
	},
);

/**
 * Suspend process instance
 */
export const suspendProcessInstanceCommand = defineCommand(
	"suspend",
	"process-instance",
	async (ctx, _flags, args) => {
		const { client, profile } = ctx;
		const key = args.key;

		const dr = ctx.dryRun({
			command: "suspend process-instance",
			method: "POST",
			endpoint: `/process-instances/${key}/suspension`,
			profile,
			body: {},
		});
		if (dr) return dr;

		await client.suspendProcessInstance({ processInstanceKey: key });
		return { kind: "success", message: `Process instance ${key} suspended` };
	},
);

/**
 * Resume process instance
 */
export const resumeProcessInstanceCommand = defineCommand(
	"resume",
	"process-instance",
	async (ctx, _flags, args) => {
		const { client, profile } = ctx;
		const key = args.key;

		const dr = ctx.dryRun({
			command: "resume process-instance",
			method: "POST",
			endpoint: `/process-instances/${key}/resumption`,
			profile,
			body: {},
		});
		if (dr) return dr;

		await client.resumeProcessInstance({ processInstanceKey: key });
		return { kind: "success", message: `Process instance ${key} resumed` };
	},
);

/** Run a flag-value parser, prefixing its error with the flag name. */
function parseFlagValue<T>(flag: string, parse: () => T): T {
	try {
		return parse();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Invalid --${flag}: ${message}`);
	}
}

/**
 * Migrate process instance(s) to another process definition.
 *
 * With a positional key, migrates that single instance synchronously. With
 * `--processDefinitionKey` instead, starts an asynchronous batch operation
 * that migrates every active instance of that source definition. Exactly one
 * of the two must be given so a batch is never started by accident.
 */
export const migrateProcessInstanceCommand = defineCommand(
	"migrate",
	"process-instance",
	async (ctx, flags, args) => {
		const { client, profile } = ctx;
		const key = args.key;
		const sourceDefinitionKey = flags.processDefinitionKey;
		// Branded here rather than via a FlagDef validator: required flags stay
		// validator-free so the framework's required-flag checks remain uniform.
		const targetProcessDefinitionKey = parseFlagValue(
			"targetProcessDefinitionKey",
			() => ProcessDefinitionKey.assumeExists(flags.targetProcessDefinitionKey),
		);

		if (key && sourceDefinitionKey) {
			throw new Error(
				"Pass either a process instance key (single migration) or --processDefinitionKey (batch migration), not both",
			);
		}
		if (!key && !sourceDefinitionKey) {
			throw new Error(
				"Process instance key or --processDefinitionKey required. Usage: c8 migrate pi <key> --targetProcessDefinitionKey <key> --map <sourceElementId>=<targetElementId>, or replace <key> with --processDefinitionKey <sourceKey> to migrate all active instances of a definition",
			);
		}
		if (!flags.map) {
			throw new Error(
				"At least one --map <sourceElementId>=<targetElementId> is required: map each active element of the source instance to its counterpart in the target definition",
			);
		}

		const mappingInstructions = flags.map.map((value) =>
			parseFlagValue("map", () => parseMigrationMapping(value)),
		);
		const migrationPlan = { targetProcessDefinitionKey, mappingInstructions };

		if (key) {
			const dr = ctx.dryRun({
				command: "migrate process-instance",
				method: "POST",
				endpoint: `/process-instances/${key}/migration`,
				profile,
				body: migrationPlan,
			});
			if (dr) return dr;

			await client.migrateProcessInstance({
				processInstanceKey: key,
				...migrationPlan,
			} satisfies migrateProcessInstanceInput);
			return {
				kind: "success",
				message: `Process instance ${key} migrated to process definition ${targetProcessDefinitionKey}`,
			};
		}

		const request = {
			filter: { processDefinitionKey: sourceDefinitionKey },
			migrationPlan,
		} satisfies migrateProcessInstancesBatchOperationInput;

		const dr = ctx.dryRun({
			command: "migrate process-instances",
			method: "POST",
			endpoint: "/process-instances/migration",
			profile,
			body: request,
		});
		if (dr) return dr;

		const result = await client.migrateProcessInstancesBatchOperation(request);
		return {
			kind: "success",
			message: `Batch migration operation created for active instances of process definition ${sourceDefinitionKey}`,
			key: result.batchOperationKey,
		};
	},
);

const INSTRUCTIONS_FLAG = {
	name: "instructions",
	exampleFile: "instructions.json",
};

/**
 * Modify process instance(s): activate elements, terminate element
 * instances, or move tokens.
 *
 * With a positional key, applies the instructions to that single instance
 * atomically (all or nothing). With `--processDefinitionKey` instead, starts
 * an asynchronous batch operation over every active instance of that
 * definition; the API only supports moves by element ID there. Exactly one of
 * the two must be given so a batch is never started by accident.
 */
export const modifyProcessInstanceCommand = defineCommand(
	"modify",
	"process-instance",
	async (ctx, flags, args) => {
		const { client, profile } = ctx;
		const key = args.key;
		const definitionKey = flags.processDefinitionKey;

		if (key && definitionKey) {
			throw new Error(
				"Pass either a process instance key (single modification) or --processDefinitionKey (batch modification), not both",
			);
		}
		if (!key && !definitionKey) {
			throw new Error(
				"Process instance key or --processDefinitionKey required. Usage: c8 modify pi <key> --move <source>=<targetElementId> (or --activate / --terminate / --instructions), or replace <key> with --processDefinitionKey <key> to move tokens in all active instances of a definition",
			);
		}

		const rawOperationReference = flags.operationReference;
		const operationReference =
			rawOperationReference === undefined
				? undefined
				: parseFlagValue("operationReference", () =>
						parseOperationReference(rawOperationReference),
					);
		const moves = (flags.move ?? []).map((value) =>
			parseFlagValue("move", () => parseMoveFlag(value)),
		);

		if (!key) {
			if (
				flags.activate ||
				flags.terminate ||
				flags.instructions !== undefined
			) {
				throw new Error(
					"Batch modification only supports --move <sourceElementId>=<targetElementId>: the API cannot activate, terminate or apply --instructions across a batch. Pass a process instance key to modify a single instance instead",
				);
			}
			if (moves.length === 0) {
				throw new Error(
					"At least one --move <sourceElementId>=<targetElementId> is required for batch modification",
				);
			}
			const request = {
				filter: { processDefinitionKey: definitionKey },
				moveInstructions: moves.map((move) =>
					parseFlagValue("move", () => toBatchMoveInstruction(move)),
				),
				...(operationReference !== undefined && { operationReference }),
			} satisfies modifyProcessInstancesBatchOperationInput;

			const dr = ctx.dryRun({
				command: "modify process-instances",
				method: "POST",
				endpoint: "/process-instances/modification",
				profile,
				body: request,
			});
			if (dr) return dr;

			const result = await client.modifyProcessInstancesBatchOperation(request);
			return {
				kind: "success",
				message: `Batch modification operation created for active instances of process definition ${definitionKey}`,
				key: result.batchOperationKey,
			};
		}

		const rawInstructions = flags.instructions;
		// Outside parseFlagValue: the JSON reader already names the flag.
		const json =
			rawInstructions === undefined
				? undefined
				: parseJsonObjectFlag({
						raw: rawInstructions,
						flag: INSTRUCTIONS_FLAG,
					});
		const fromJson: ProcessInstanceModificationInstruction =
			json === undefined
				? {}
				: parseFlagValue("instructions", () =>
						parseModificationInstructions(json),
					);
		if (
			operationReference !== undefined &&
			fromJson.operationReference !== undefined
		) {
			throw new Error(
				"Pass operationReference either inside --instructions or as --operationReference, not both",
			);
		}

		const activateInstructions = [
			...(fromJson.activateInstructions ?? []),
			...(flags.activate ?? []).map((value) =>
				parseFlagValue("activate", () => parseActivateFlag(value)),
			),
		];
		const moveInstructions = [...(fromJson.moveInstructions ?? []), ...moves];
		const terminateInstructions = [
			...(fromJson.terminateInstructions ?? []),
			...(flags.terminate ?? []).map((value) =>
				parseFlagValue("terminate", () => parseTerminateFlag(value)),
			),
		];
		if (
			activateInstructions.length +
				moveInstructions.length +
				terminateInstructions.length ===
			0
		) {
			throw new Error(
				"At least one modification instruction is required: pass --activate <elementId>, --terminate <elementId|elementInstanceKey>, --move <source>=<targetElementId> or --instructions <json>",
			);
		}

		const reference = operationReference ?? fromJson.operationReference;
		const body = {
			...(activateInstructions.length > 0 && { activateInstructions }),
			...(moveInstructions.length > 0 && { moveInstructions }),
			...(terminateInstructions.length > 0 && { terminateInstructions }),
			...(reference !== undefined && { operationReference: reference }),
		} satisfies ProcessInstanceModificationInstruction;

		const dr = ctx.dryRun({
			command: "modify process-instance",
			method: "POST",
			endpoint: `/process-instances/${key}/modification`,
			profile,
			body,
		});
		if (dr) return dr;

		await client.modifyProcessInstance({
			processInstanceKey: key,
			...body,
		} satisfies modifyProcessInstanceInput);
		return {
			kind: "success",
			message: `Process instance ${key} modified`,
		};
	},
);
