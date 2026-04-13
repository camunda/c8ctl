/**
 * Process instance commands
 */

import type {
	createProcessInstanceInput,
	ProcessInstanceResult,
} from "@camunda8/orchestration-cluster-api";
import {
	ProcessDefinitionId,
	ProcessInstanceKey,
	TenantId,
} from "@camunda8/orchestration-cluster-api";
import { createClient, emitDryRun, fetchAllPages } from "../client.ts";
import { resolveClusterConfig, resolveTenantId } from "../config.ts";
import { buildDateFilter, parseBetween } from "../date-filter.ts";
import { handleCommandError } from "../errors.ts";
import { getLogger, type SortOrder, sortTableData } from "../logger.ts";
import { c8ctl } from "../runtime.ts";

/**
 * List process instances
 */
export async function listProcessInstances(options: {
	profile?: string;
	processDefinitionId?: string;
	version?: number;
	state?: string;
	all?: boolean;
	sortBy?: string;
	sortOrder?: SortOrder;
	limit?: number;
	between?: string;
	dateField?: string;
}): Promise<{ items: ProcessInstanceResult[]; total?: number } | undefined> {
	const logger = getLogger();
	const client = createClient(options.profile);
	const tenantId = resolveTenantId(options.profile);

	try {
		const filter: { filter: Record<string, unknown> } = {
			filter: {
				tenantId,
			},
		};

		if (options.processDefinitionId) {
			filter.filter.processDefinitionId = options.processDefinitionId;
		}

		if (options.version !== undefined) {
			filter.filter.processDefinitionVersion = options.version;
		}

		if (options.state) {
			filter.filter.state = options.state;
		} else if (!options.all) {
			// By default, exclude COMPLETED instances unless --all is specified
			filter.filter.state = "ACTIVE";
		}

		if (options.between) {
			const parsed = parseBetween(options.between);
			if (parsed) {
				const field = options.dateField ?? "startDate";
				filter.filter[field] = buildDateFilter(parsed.from, parsed.to);
			} else {
				logger.error(
					"Invalid --between value. Expected format: <from>..<to> (e.g. 2024-01-01..2024-12-31, ISO 8601 datetimes, or open-ended: ..2024-12-31 or 2024-01-01..)",
				);
				process.exit(1);
			}
		}

		if (emitDryRun({ command: "list process-instances", method: "POST", endpoint: "/process-instances/search", profile: options.profile, body: filter })) return;

		const allItems = await fetchAllPages(
			(f, opts) => client.searchProcessInstances(f, opts),
			filter,
			undefined,
			options.limit,
		);

		if (allItems.length > 0) {
			let tableData = allItems.map((pi) => ({
				Key: `${pi.hasIncident ? "⚠ " : ""}${pi.processInstanceKey}`,
				"Process ID": pi.processDefinitionId,
				State: pi.state,
				Version: pi.processDefinitionVersion,
				"Start Date": pi.startDate || "-",
				"Tenant ID": pi.tenantId,
			}));
			tableData = sortTableData(
				tableData,
				options.sortBy,
				logger,
				options.sortOrder,
			);
			logger.table(tableData);
		} else {
			logger.info("No process instances found");
		}

		return { items: allItems, total: allItems.length };
	} catch (error) {
		handleCommandError(logger, "Failed to list process instances", error);
	}
}

/**
 * Get process instance by key
 */
export async function getProcessInstance(
	key: string,
	options: {
		profile?: string;
		variables?: boolean;
	},
): Promise<void> {
	const logger = getLogger();
	const client = createClient(options.profile);
	const consistencyOptions = { consistency: { waitUpToMs: 0 } };

	if (emitDryRun({ command: "get process-instance", method: "GET", endpoint: `/process-instances/${key}`, profile: options.profile })) return;

	try {
		const result = await client.getProcessInstance(
			{ processInstanceKey: ProcessInstanceKey.assumeExists(key) },
			consistencyOptions,
		);

		// Fetch variables if requested
		if (options.variables) {
			try {
				const variablesResult = await client.searchVariables(
					{
						filter: {
							processInstanceKey: ProcessInstanceKey.assumeExists(key),
						},
						truncateValues: false, // Get full variable values
					},
					consistencyOptions,
				);

				// Add variables to the result
				const resultWithVariables = {
					...result,
					variables: variablesResult.items || [],
				};
				logger.json(resultWithVariables);
			} catch (varError) {
				handleCommandError(
					logger,
					`Failed to fetch variables for process instance ${key}. The process instance was found, but variables could not be retrieved.`,
					varError,
				);
			}
		} else {
			logger.json(result);
		}
	} catch (error) {
		handleCommandError(logger, `Failed to get process instance ${key}`, error);
	}
}

/**
 * Create process instance
 */
export async function createProcessInstance(options: {
	profile?: string;
	processDefinitionId?: string;
	version?: number;
	variables?: string;
	awaitCompletion?: boolean;
	fetchVariables?: boolean;
	requestTimeout?: number;
}): Promise<
	| {
			processInstanceKey: string | number;
			variables?: Record<string, unknown>;
			[key: string]: unknown;
	  }
	| undefined
> {
	const logger = getLogger();

	if (!options.processDefinitionId) {
		logger.error(
			"processDefinitionId is required. Use --processDefinitionId or --bpmnProcessId or --id flag",
		);
		process.exit(1);
	}

	const tenantId = resolveTenantId(options.profile);

	// Dry-run: emit the would-be API request without executing
	if (c8ctl.dryRun) {
		const config = resolveClusterConfig(options.profile);
		const body: Record<string, unknown> = {
			processDefinitionId: options.processDefinitionId,
			tenantId,
		};
		if (options.version !== undefined)
			body.processDefinitionVersion = options.version;
		if (options.variables) body.variables = JSON.parse(options.variables);
		if (options.awaitCompletion) body.awaitCompletion = true;
		if (options.requestTimeout !== undefined)
			body.requestTimeout = options.requestTimeout;
		logger.json({
			dryRun: true,
			command: "create process-instance",
			method: "POST",
			url: `${config.baseUrl}/process-instances`,
			body,
		});
		return;
	}

	const client = createClient(options.profile);

	// Validate: fetchVariables requires awaitCompletion
	if (options.fetchVariables && !options.awaitCompletion) {
		logger.error("--fetchVariables can only be used with --awaitCompletion");
		process.exit(1);
	}

	// Note: fetchVariables parameter is reserved for future API enhancement
	// The orchestration-cluster-api currently does not support filtering variables
	// The API returns all variables by default when awaitCompletion is true
	if (options.fetchVariables) {
		logger.info(
			"Note: --fetchVariables is not yet supported by the API. All variables will be returned.",
		);
	}

	try {
		// Parse variables early for clear error reporting
		let variables: Record<string, unknown> | undefined;
		if (options.variables) {
			try {
				variables = JSON.parse(options.variables);
			} catch (error) {
				handleCommandError(logger, "Invalid JSON for variables", error);
				return;
			}
		}

		if (options.awaitCompletion) {
			logger.info("Waiting for process instance to complete...");
		}

		// Build the request with SDK types as single source of truth
		const request = {
			processDefinitionId: ProcessDefinitionId.assumeExists(
				options.processDefinitionId,
			),
			tenantId: TenantId.assumeExists(tenantId),
			...(options.version !== undefined && {
				processDefinitionVersion: options.version,
			}),
			...(variables !== undefined && { variables }),
			...(options.awaitCompletion && { awaitCompletion: true }),
			...(options.requestTimeout !== undefined && {
				requestTimeout: options.requestTimeout,
			}),
		} satisfies createProcessInstanceInput;

		const result = await client.createProcessInstance(request);

		if (options.awaitCompletion) {
			// When awaitCompletion is true, the API returns the completed process instance with variables
			logger.success("Process instance completed", result.processInstanceKey);
			logger.json(result);
		} else {
			// When awaitCompletion is false, just show the process instance key
			logger.success("Process instance created", result.processInstanceKey);
		}

		return result;
	} catch (error) {
		handleCommandError(logger, "Failed to create process instance", error);
	}
}

/**
 * Cancel process instance
 */
export async function cancelProcessInstance(
	key: string,
	options: {
		profile?: string;
	},
): Promise<void> {
	const logger = getLogger();

	// Dry-run: emit the would-be API request without executing
	if (c8ctl.dryRun) {
		const config = resolveClusterConfig(options.profile);
		logger.json({
			dryRun: true,
			command: "cancel process-instance",
			method: "POST",
			url: `${config.baseUrl}/process-instances/${key}/cancellation`,
			body: {},
		});
		return;
	}

	const client = createClient(options.profile);

	try {
		await client.cancelProcessInstance({
			processInstanceKey: ProcessInstanceKey.assumeExists(key),
		});
		logger.success(`Process instance ${key} cancelled`);
	} catch (error) {
		handleCommandError(
			logger,
			`Failed to cancel process instance ${key}`,
			error,
		);
	}
}
