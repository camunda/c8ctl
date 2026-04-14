/**
 * Process instance commands
 */

import type { createProcessInstanceInput } from "@camunda8/orchestration-cluster-api";
import {
	ProcessDefinitionId,
	TenantId,
} from "@camunda8/orchestration-cluster-api";
import { fetchAllPages } from "../client.ts";
import { defineCommand, dryRun } from "../command-framework.ts";
import { buildDateFilter, parseBetween } from "../date-filter.ts";
import { handleCommandError } from "../errors.ts";

/**
 * List process instances
 */
export const listProcessInstancesCommand = defineCommand(
	"list",
	"process-instance",
	async (ctx, flags) => {
		const {
			client,
			logger,
			tenantId,
			profile,
			limit,
			all,
			between,
			dateField,
		} = ctx;

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

		// version comes from global --version flag, not resource flags
		const versionIdx = process.argv.indexOf("--version");
		const vIdx = process.argv.indexOf("-v");
		const versionArg =
			versionIdx >= 0
				? process.argv[versionIdx + 1]
				: vIdx >= 0
					? process.argv[vIdx + 1]
					: undefined;
		if (versionArg) {
			const version = parseInt(versionArg, 10);
			if (!Number.isNaN(version)) {
				filter.filter.processDefinitionVersion = version;
			}
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
				logger.error(
					"Invalid --between value. Expected format: <from>..<to> (e.g. 2024-01-01..2024-12-31, ISO 8601 datetimes, or open-ended: ..2024-12-31 or 2024-01-01..)",
				);
				process.exit(1);
			}
		}

		const dr = dryRun({
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
				"Process ID": pi.processDefinitionId,
				State: pi.state,
				Version: pi.processDefinitionVersion,
				"Start Date": pi.startDate || "-",
				"Tenant ID": pi.tenantId,
			})),
			emptyMessage: "No process instances found",
		};
	},
);

/**
 * Get process instance by key
 */
export const getProcessInstanceCommand = defineCommand(
	"get",
	"process-instance",
	async (ctx, _flags, args) => {
		const { client, profile } = ctx;
		const key = args.key;
		const consistencyOptions = { consistency: { waitUpToMs: 0 } };
		// --variables is registered as string type in parseArgs (for create pi --variables '{...}')
		// but used as a boolean toggle for get pi. Check argv directly.
		const includeVariables = process.argv.includes("--variables");

		const dr = dryRun({
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
			logger.error(
				"processDefinitionId is required. Use --processDefinitionId or --bpmnProcessId or --id flag",
			);
			process.exit(1);
		}

		const version = ctx.version;
		const awaitCompletion = flags.awaitCompletion;
		const fetchVariables = flags.fetchVariables;
		const requestTimeout =
			flags.requestTimeout !== undefined
				? parseInt(flags.requestTimeout, 10)
				: undefined;

		// Dry-run: emit the would-be API request without executing
		const body: Record<string, unknown> = {
			processDefinitionId,
			tenantId,
		};
		if (version !== undefined) body.processDefinitionVersion = version;
		if (flags.variables) body.variables = JSON.parse(flags.variables);
		if (awaitCompletion) body.awaitCompletion = true;
		if (requestTimeout !== undefined) body.requestTimeout = requestTimeout;

		const dr = dryRun({
			command: "create process-instance",
			method: "POST",
			endpoint: "/process-instances",
			profile,
			body,
		});
		if (dr) return dr;

		// Validate: fetchVariables requires awaitCompletion
		if (fetchVariables && !awaitCompletion) {
			logger.error("--fetchVariables can only be used with --awaitCompletion");
			process.exit(1);
		}

		// Note: fetchVariables parameter is reserved for future API enhancement
		// The orchestration-cluster-api currently does not support filtering variables
		// The API returns all variables by default when awaitCompletion is true
		if (fetchVariables) {
			logger.info(
				"Note: --fetchVariables is not yet supported by the API. All variables will be returned.",
			);
		}

		// Parse variables early for clear error reporting
		let variables: Record<string, unknown> | undefined;
		if (flags.variables) {
			try {
				variables = JSON.parse(flags.variables);
			} catch (error) {
				handleCommandError(logger, "Invalid JSON for variables", error);
				return;
			}
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
			logger.error(
				"processDefinitionId is required. Use --processDefinitionId or --bpmnProcessId or --id flag",
			);
			process.exit(1);
		}

		const version = ctx.version;
		const requestTimeout =
			flags.requestTimeout !== undefined
				? parseInt(flags.requestTimeout, 10)
				: undefined;

		// Dry-run: emit the would-be API request without executing
		const body: Record<string, unknown> = {
			processDefinitionId,
			tenantId,
			awaitCompletion: true,
		};
		if (version !== undefined) body.processDefinitionVersion = version;
		if (flags.variables) body.variables = JSON.parse(flags.variables);
		if (requestTimeout !== undefined) body.requestTimeout = requestTimeout;

		const dr = dryRun({
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

		// Parse variables early for clear error reporting
		let variables: Record<string, unknown> | undefined;
		if (flags.variables) {
			try {
				variables = JSON.parse(flags.variables);
			} catch (error) {
				handleCommandError(logger, "Invalid JSON for variables", error);
				return;
			}
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

		const dr = dryRun({
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
