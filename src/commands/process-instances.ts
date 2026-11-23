/**
 * Process instance commands
 */

import type { ProcessInstanceModificationInstruction } from "@camunda8/orchestration-cluster-api";
import { ProcessDefinitionKey } from "@camunda8/orchestration-cluster-api";
import { C8ctlError } from "../core/index.ts";
import {
	type CommandContext,
	clusterInputOf,
	defineCommand,
	defineServiceCommand,
} from "../framework/index.ts";
import {
	awaitProcessInstance,
	awaitProcessInstanceRequest,
	cancelProcessInstance,
	cancelProcessInstanceRequest,
	createProcessInstance,
	createProcessInstanceRequest,
	getProcessInstance,
	getProcessInstanceRequest,
	listProcessInstances,
	listProcessInstancesRequest,
	migrateProcessInstance,
	migrateProcessInstanceRequest,
	migrateProcessInstances,
	migrateProcessInstancesRequest,
	modifyProcessInstance,
	modifyProcessInstanceRequest,
	modifyProcessInstances,
	modifyProcessInstancesRequest,
	resumeProcessInstance,
	resumeProcessInstanceRequest,
	suspendProcessInstance,
	suspendProcessInstanceRequest,
} from "../services/index.ts";
import {
	parseActivateFlag,
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
export const listProcessInstancesCommand = defineServiceCommand(
	"list",
	"process-instance",
	{
		toInput: (flags, _args, scope) => ({
			processDefinitionId:
				flags.id || flags.processDefinitionId || flags.bpmnProcessId,
			businessId: flags.businessId,
			// `--version` is a global flag, parsed as a string after the verb
			// (stage 2 of the two-stage parser) and surfaced as scope.version.
			version: scope.version,
			state: flags.state,
			all: scope.all,
			between: scope.between,
			dateField: scope.dateField,
			limit: scope.limit,
		}),
		dryRun: {
			command: "list process-instances",
			request: listProcessInstancesRequest,
		},
		service: listProcessInstances,
		render: ({ items }, input, scope) => ({
			kind: "list",
			items: items.map((pi) => ({
				Key: `${pi.hasIncident ? "⚠ " : ""}${pi.processInstanceKey}`,
				"Business ID": pi.businessId || "-",
				"Process ID": pi.processDefinitionId,
				State: pi.state,
				Version: pi.processDefinitionVersion,
				"Start Date": pi.startDate || "-",
				"Tenant ID": pi.tenantId,
			})),
			emptyMessage: processInstancesEmptyMessage(
				listProcessInstancesRequest(input, scope.tenantId).body.filter,
			),
		}),
	},
);

/**
 * Get process instance by key
 */
export const getProcessInstanceCommand = defineServiceCommand(
	"get",
	"process-instance",
	{
		toInput: (flags, args) => ({
			processInstanceKey: args.key,
			// --variables is a boolean toggle for `get pi` (and a string for
			// `create pi`): stage 2 parses it against this command's own flag
			// table.
			includeVariables: flags.variables === true,
		}),
		dryRun: {
			command: "get process-instance",
			request: getProcessInstanceRequest,
		},
		service: getProcessInstance,
		render: (processInstance) => ({ kind: "get", data: processInstance }),
	},
);

const PROCESS_DEFINITION_ID_REQUIRED =
	"processDefinitionId is required. Use --processDefinitionId or --bpmnProcessId or --id flag";

/** The flags `create` and `await` share, as the service input. */
function createInputOf(
	ctx: CommandContext,
	flags: {
		id?: string;
		processDefinitionId?: string;
		bpmnProcessId?: string;
		variables?: string;
		businessId?: string;
		requestTimeout?: string;
	},
) {
	const processDefinitionId =
		flags.id || flags.processDefinitionId || flags.bpmnProcessId;
	if (!processDefinitionId) {
		throw new C8ctlError("invalid-input", PROCESS_DEFINITION_ID_REQUIRED, {
			field: "processDefinitionId",
		});
	}
	return {
		processDefinitionId,
		version: ctx.version,
		// Parse variables early for clear error reporting
		variables: flags.variables
			? parseVariablesFlag({ raw: flags.variables })
			: undefined,
		businessId: flags.businessId,
		requestTimeout:
			flags.requestTimeout !== undefined
				? parseInt(flags.requestTimeout, 10)
				: undefined,
	};
}

const FETCH_VARIABLES_NOTE =
	"Note: --fetchVariables is not yet supported by the API. All variables will be returned.";

/**
 * Create process instance. A plain handler: it reports progress and prints
 * the completed instance next to the success message.
 */
export const createProcessInstanceCommand = defineCommand(
	"create",
	"process-instance",
	async (ctx, flags, _args) => {
		const { logger } = ctx;
		const awaitCompletion = flags.awaitCompletion;
		const fetchVariables = flags.fetchVariables;
		const input = { ...createInputOf(ctx, flags), awaitCompletion };

		const dr = ctx.dryRun({
			command: "create process-instance",
			profile: ctx.profile,
			...createProcessInstanceRequest(input, ctx.tenantId),
		});
		if (dr) return dr;

		// Validate: fetchVariables requires awaitCompletion
		if (fetchVariables && !awaitCompletion) {
			throw new C8ctlError(
				"invalid-input",
				"--fetchVariables can only be used with --awaitCompletion",
				{ field: "fetchVariables" },
			);
		}

		// Note: fetchVariables parameter is reserved for future API enhancement
		// The orchestration-cluster-api currently does not support filtering variables
		// The API returns all variables by default when awaitCompletion is true
		if (fetchVariables) {
			logger.info(FETCH_VARIABLES_NOTE);
		}

		if (awaitCompletion) {
			logger.info("Waiting for process instance to complete...");
		}

		const result = await createProcessInstance(
			{ ...input, ...clusterInputOf(ctx) },
			{},
		);

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
		const { logger } = ctx;
		const input = createInputOf(ctx, flags);

		const dr = ctx.dryRun({
			command: "await process-instance",
			profile: ctx.profile,
			...awaitProcessInstanceRequest(input, ctx.tenantId),
		});
		if (dr) return dr;

		// Note: fetchVariables parameter is reserved for future API enhancement
		if (flags.fetchVariables) {
			logger.info(FETCH_VARIABLES_NOTE);
		}

		logger.info("Waiting for process instance to complete...");

		const result = await awaitProcessInstance(
			{ ...input, ...clusterInputOf(ctx) },
			{},
		);

		logger.success("Process instance completed", result.processInstanceKey);
		logger.json(result);
	},
);

/**
 * Cancel process instance
 */
export const cancelProcessInstanceCommand = defineServiceCommand(
	"cancel",
	"process-instance",
	{
		toInput: (_flags, args) => ({ processInstanceKey: args.key }),
		dryRun: {
			command: "cancel process-instance",
			request: cancelProcessInstanceRequest,
		},
		service: cancelProcessInstance,
		render: ({ processInstanceKey }) => ({
			kind: "success",
			message: `Process instance ${processInstanceKey} cancelled`,
		}),
	},
);

/**
 * Suspend process instance
 */
export const suspendProcessInstanceCommand = defineServiceCommand(
	"suspend",
	"process-instance",
	{
		toInput: (_flags, args) => ({ processInstanceKey: args.key }),
		dryRun: {
			command: "suspend process-instance",
			request: suspendProcessInstanceRequest,
		},
		service: suspendProcessInstance,
		render: ({ processInstanceKey }) => ({
			kind: "success",
			message: `Process instance ${processInstanceKey} suspended`,
		}),
	},
);

/**
 * Resume process instance
 */
export const resumeProcessInstanceCommand = defineServiceCommand(
	"resume",
	"process-instance",
	{
		toInput: (_flags, args) => ({ processInstanceKey: args.key }),
		dryRun: {
			command: "resume process-instance",
			request: resumeProcessInstanceRequest,
		},
		service: resumeProcessInstance,
		render: ({ processInstanceKey }) => ({
			kind: "success",
			message: `Process instance ${processInstanceKey} resumed`,
		}),
	},
);

/** Run a flag-value parser, prefixing its error with the flag name. */
function parseFlagValue<T>(flag: string, parse: () => T): T {
	try {
		return parse();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new C8ctlError("invalid-input", `Invalid --${flag}: ${message}`, {
			field: flag,
		});
	}
}

/**
 * Migrate process instance(s) to another process definition.
 *
 * With a positional key, migrates that single instance synchronously. With
 * `--processDefinitionKey` instead, starts an asynchronous batch operation
 * that migrates every active instance of that source definition. Exactly one
 * of the two must be given so a batch is never started by accident. A plain
 * handler, because the two forms are two services.
 */
export const migrateProcessInstanceCommand = defineCommand(
	"migrate",
	"process-instance",
	async (ctx, flags, args) => {
		const key = args.key;
		const sourceDefinitionKey = flags.processDefinitionKey;
		// Branded here rather than via a FlagDef validator: required flags stay
		// validator-free so the framework's required-flag checks remain uniform.
		const targetProcessDefinitionKey = parseFlagValue(
			"targetProcessDefinitionKey",
			() => ProcessDefinitionKey.assumeExists(flags.targetProcessDefinitionKey),
		);

		if (key && sourceDefinitionKey) {
			throw new C8ctlError(
				"invalid-input",
				"Pass either a process instance key (single migration) or --processDefinitionKey (batch migration), not both",
				{ field: "processDefinitionKey" },
			);
		}
		if (!key && !sourceDefinitionKey) {
			throw new C8ctlError(
				"invalid-input",
				"Process instance key or --processDefinitionKey required. Usage: c8 migrate pi <key> --targetProcessDefinitionKey <key> --map <sourceElementId>=<targetElementId>, or replace <key> with --processDefinitionKey <sourceKey> to migrate all active instances of a definition",
				{ field: "processDefinitionKey" },
			);
		}
		if (!flags.map) {
			throw new C8ctlError(
				"invalid-input",
				"At least one --map <sourceElementId>=<targetElementId> is required: map each active element of the source instance to its counterpart in the target definition",
				{ field: "map" },
			);
		}

		const mappingInstructions = flags.map.map((value) =>
			parseFlagValue("map", () => parseMigrationMapping(value)),
		);
		const plan = { targetProcessDefinitionKey, mappingInstructions };

		if (key) {
			const input = { processInstanceKey: key, ...plan };
			const dr = ctx.dryRun({
				command: "migrate process-instance",
				profile: ctx.profile,
				...migrateProcessInstanceRequest(input),
			});
			if (dr) return dr;

			await migrateProcessInstance({ ...input, ...clusterInputOf(ctx) }, {});
			return {
				kind: "success",
				message: `Process instance ${key} migrated to process definition ${targetProcessDefinitionKey}`,
			};
		}

		const input = { processDefinitionKey: sourceDefinitionKey ?? "", ...plan };
		const dr = ctx.dryRun({
			command: "migrate process-instances",
			profile: ctx.profile,
			...migrateProcessInstancesRequest(input),
		});
		if (dr) return dr;

		const result = await migrateProcessInstances(
			{ ...input, ...clusterInputOf(ctx) },
			{},
		);
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
 * the two must be given so a batch is never started by accident. A plain
 * handler, because the two forms are two services.
 */
export const modifyProcessInstanceCommand = defineCommand(
	"modify",
	"process-instance",
	async (ctx, flags, args) => {
		const key = args.key;
		const definitionKey = flags.processDefinitionKey;

		if (key && definitionKey) {
			throw new C8ctlError(
				"invalid-input",
				"Pass either a process instance key (single modification) or --processDefinitionKey (batch modification), not both",
				{ field: "processDefinitionKey" },
			);
		}
		if (!key && !definitionKey) {
			throw new C8ctlError(
				"invalid-input",
				"Process instance key or --processDefinitionKey required. Usage: c8 modify pi <key> --move <source>=<targetElementId> (or --activate / --terminate / --instructions), or replace <key> with --processDefinitionKey <key> to move tokens in all active instances of a definition",
				{ field: "processDefinitionKey" },
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
				throw new C8ctlError(
					"invalid-input",
					"Batch modification only supports --move <sourceElementId>=<targetElementId>: the API cannot activate, terminate or apply --instructions across a batch. Pass a process instance key to modify a single instance instead",
					{ field: "move" },
				);
			}
			if (moves.length === 0) {
				throw new C8ctlError(
					"invalid-input",
					"At least one --move <sourceElementId>=<targetElementId> is required for batch modification",
					{ field: "move" },
				);
			}
			const input = {
				processDefinitionKey: definitionKey ?? "",
				moveInstructions: moves.map((move) =>
					parseFlagValue("move", () => toBatchMoveInstruction(move)),
				),
				operationReference,
			};

			const dr = ctx.dryRun({
				command: "modify process-instances",
				profile: ctx.profile,
				...modifyProcessInstancesRequest(input),
			});
			if (dr) return dr;

			const result = await modifyProcessInstances(
				{ ...input, ...clusterInputOf(ctx) },
				{},
			);
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
			throw new C8ctlError(
				"invalid-input",
				"Pass operationReference either inside --instructions or as --operationReference, not both",
				{ field: "operationReference" },
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
			throw new C8ctlError(
				"invalid-input",
				"At least one modification instruction is required: pass --activate <elementId>, --terminate <elementId|elementInstanceKey>, --move <source>=<targetElementId> or --instructions <json>",
				{ field: "instructions" },
			);
		}

		const input = {
			processInstanceKey: key,
			activateInstructions,
			moveInstructions,
			terminateInstructions,
			operationReference: operationReference ?? fromJson.operationReference,
		};
		const dr = ctx.dryRun({
			command: "modify process-instance",
			profile: ctx.profile,
			...modifyProcessInstanceRequest(input),
		});
		if (dr) return dr;

		await modifyProcessInstance({ ...input, ...clusterInputOf(ctx) }, {});
		return {
			kind: "success",
			message: `Process instance ${key} modified`,
		};
	},
);
