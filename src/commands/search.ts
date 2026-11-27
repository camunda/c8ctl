/**
 * Search commands — CLI bindings of the search services. Each command
 * describes its criteria, runs the service, and prints a table with the
 * result count.
 */

import { isRecord, type Logger, sortTableData } from "../core/index.ts";
import { clusterInputOf, defineCommand } from "../framework/index.ts";
import {
	searchIncidents,
	searchIncidentsRequest,
	searchJobs,
	searchJobsRequest,
	searchProcessDefinitions,
	searchProcessDefinitionsRequest,
	searchProcessInstances,
	searchProcessInstancesRequest,
	searchUserTasks,
	searchUserTasksRequest,
	searchVariables,
	searchVariablesRequest,
	searchWaitStates,
	searchWaitStatesRequest,
} from "../services/index.ts";
import {
	API_DEFAULT_PAGE_SIZE,
	hasUnescapedWildcard,
	logNoResults,
	logResultCount,
	matchesCaseInsensitive,
	matchesCaseSensitive,
	renderWaitStateDetails,
	toStringFilter,
	wildcardToRegex,
} from "../utils/index.ts";

export {
	API_DEFAULT_PAGE_SIZE,
	hasUnescapedWildcard,
	logNoResults,
	logResultCount,
	matchesCaseInsensitive,
	matchesCaseSensitive,
	toStringFilter,
	wildcardToRegex,
};

/**
 * Build a human-readable description of a filter criterion.
 *
 * @param fieldLabel - Human-readable name of the field being searched
 * @param value - The filter value
 * @param isCaseInsensitive - Whether this is a case-insensitive search
 * @returns A formatted string describing the criterion
 */
function formatCriterion(
	fieldLabel: string,
	value: string | number | boolean,
	isCaseInsensitive: boolean = false,
): string {
	if (typeof value === "boolean") {
		return `'${fieldLabel}' = ${value}`;
	}

	if (typeof value === "number") {
		return `'${fieldLabel}' = ${value}`;
	}

	const hasWildcard = hasUnescapedWildcard(value);
	const prefix = isCaseInsensitive ? "(case-insensitive) " : "";

	if (hasWildcard) {
		return `${prefix}'${fieldLabel}' matching "${value}"`;
	} else {
		return `${prefix}'${fieldLabel}' = "${value}"`;
	}
}

/**
 * Log search criteria for better developer experience.
 * Uses the Logger so output respects the current text/JSON mode.
 *
 * @param logger - Logger instance to use
 * @param resourceName - Human-readable name of the resource type being searched
 * @param criteria - Array of criterion strings describing the filters
 */
function logSearchCriteria(
	logger: Logger,
	resourceName: string,
	criteria: string[],
): void {
	if (criteria.length === 0) {
		logger.info(`Searching ${resourceName} (no filters)`);
	} else if (criteria.length === 1) {
		logger.info(`Searching ${resourceName} where ${criteria[0]}`);
	} else {
		logger.info(`Searching ${resourceName} where ${criteria.join(" AND ")}`);
	}
}

/**
 * Search process definitions
 */
export const searchProcessDefinitionsCommand = defineCommand(
	"search",
	"process-definition",
	async (ctx, flags, _args) => {
		const { logger } = ctx;
		const processDefinitionId =
			flags.id || flags.processDefinitionId || flags.bpmnProcessId;
		const version = ctx.version;

		// Build search criteria description for user feedback
		const criteria: string[] = [];
		if (processDefinitionId) {
			criteria.push(
				formatCriterion("Process Definition ID", processDefinitionId),
			);
		}
		if (flags.name) {
			criteria.push(formatCriterion("name", flags.name));
		}
		if (version !== undefined) {
			criteria.push(formatCriterion("version", version));
		}
		if (flags.key) {
			criteria.push(formatCriterion("key", flags.key));
		}
		if (flags.iid) {
			criteria.push(formatCriterion("Process Definition ID", flags.iid, true));
		}
		if (flags.iname) {
			criteria.push(formatCriterion("name", flags.iname, true));
		}

		const input = {
			processDefinitionId,
			name: flags.name,
			version,
			key: flags.key,
			iid: flags.iid,
			iname: flags.iname,
		};

		const dr = ctx.dryRun({
			command: "search process-definitions",
			profile: ctx.profile,
			...searchProcessDefinitionsRequest(input, ctx.tenantId),
		});
		if (dr) return dr;

		logSearchCriteria(logger, "Process Definitions", criteria);

		const result = await searchProcessDefinitions(
			{ ...input, ...clusterInputOf(ctx) },
			{},
		);

		if (result.items && result.items.length > 0) {
			let tableData = result.items.map((pd) => ({
				Key: pd.processDefinitionKey || pd.key,
				"Process ID": pd.processDefinitionId,
				Name: pd.name || "-",
				Version: pd.version,
				"Tenant ID": pd.tenantId,
			}));
			tableData = sortTableData(tableData, ctx.sortBy, logger, ctx.sortOrder);
			logger.table(tableData);
			logResultCount(
				logger,
				result.items.length,
				"process definition(s)",
				criteria.length > 0,
			);
		} else {
			logNoResults(logger, "process definitions", criteria.length > 0);
		}
	},
);

/**
 * Search process instances
 */
export const searchProcessInstancesCommand = defineCommand(
	"search",
	"process-instance",
	async (ctx, flags, _args) => {
		const { logger } = ctx;
		const processDefinitionId =
			flags.id || flags.processDefinitionId || flags.bpmnProcessId;
		const version = ctx.version;

		// Build search criteria description for user feedback
		const criteria: string[] = [];
		if (processDefinitionId) {
			criteria.push(
				formatCriterion("Process Definition ID", processDefinitionId),
			);
		}
		if (flags.businessId) {
			criteria.push(formatCriterion("Business ID", flags.businessId));
		}
		if (flags.processDefinitionKey) {
			criteria.push(
				formatCriterion("Process Definition Key", flags.processDefinitionKey),
			);
		}
		if (flags.state) {
			criteria.push(formatCriterion("state", flags.state));
		}
		if (version !== undefined) {
			criteria.push(formatCriterion("version", version));
		}
		if (flags.key) {
			criteria.push(formatCriterion("key", flags.key));
		}
		if (flags.parentProcessInstanceKey) {
			criteria.push(
				formatCriterion(
					"Parent Process Instance Key",
					flags.parentProcessInstanceKey,
				),
			);
		}
		if (flags.iid) {
			criteria.push(formatCriterion("Process Definition ID", flags.iid, true));
		}
		if (ctx.between) {
			const field = ctx.dateField ?? "startDate";
			criteria.push(`'${field}' between "${ctx.between}"`);
		}

		const input = {
			processDefinitionId,
			businessId: flags.businessId,
			processDefinitionKey: flags.processDefinitionKey,
			state: flags.state,
			version,
			key: flags.key,
			parentProcessInstanceKey: flags.parentProcessInstanceKey,
			iid: flags.iid,
			between: ctx.between,
			dateField: ctx.dateField,
		};

		const dr = ctx.dryRun({
			command: "search process-instances",
			profile: ctx.profile,
			...searchProcessInstancesRequest(input, ctx.tenantId),
		});
		if (dr) return dr;

		logSearchCriteria(logger, "Process Instances", criteria);

		const result = await searchProcessInstances(
			{ ...input, ...clusterInputOf(ctx) },
			{},
		);

		if (result.items && result.items.length > 0) {
			let tableData = result.items.map((pi) => ({
				Key: pi.processInstanceKey || pi.key,
				"Business ID": pi.businessId || "-",
				"Process ID": pi.processDefinitionId,
				State: pi.state,
				Version: pi.processDefinitionVersion || pi.version,
				"Start Date": pi.startDate || "-",
				"Tenant ID": pi.tenantId,
			}));
			tableData = sortTableData(tableData, ctx.sortBy, logger, ctx.sortOrder);
			logger.table(tableData);
			logResultCount(
				logger,
				result.items.length,
				"process instance(s)",
				criteria.length > 0,
			);
		} else {
			logNoResults(logger, "process instances", criteria.length > 0);
		}
	},
);

/**
 * Search user tasks
 */
export const searchUserTasksCommand = defineCommand(
	"search",
	"user-task",
	async (ctx, flags, _args) => {
		const { logger } = ctx;

		// Build search criteria description for user feedback
		const criteria: string[] = [];
		if (flags.state) {
			criteria.push(formatCriterion("state", flags.state));
		}
		if (flags.assignee) {
			criteria.push(formatCriterion("assignee", flags.assignee));
		}
		if (flags.processInstanceKey) {
			criteria.push(
				formatCriterion("Process Instance Key", flags.processInstanceKey),
			);
		}
		if (flags.processDefinitionKey) {
			criteria.push(
				formatCriterion("Process Definition Key", flags.processDefinitionKey),
			);
		}
		if (flags.elementId) {
			criteria.push(formatCriterion("Element ID", flags.elementId));
		}
		if (flags.iassignee) {
			criteria.push(formatCriterion("assignee", flags.iassignee, true));
		}
		if (ctx.between) {
			const field = ctx.dateField ?? "creationDate";
			criteria.push(`'${field}' between "${ctx.between}"`);
		}

		const input = {
			state: flags.state,
			assignee: flags.assignee,
			processInstanceKey: flags.processInstanceKey,
			processDefinitionKey: flags.processDefinitionKey,
			elementId: flags.elementId,
			iassignee: flags.iassignee,
			between: ctx.between,
			dateField: ctx.dateField,
		};

		const dr = ctx.dryRun({
			command: "search user-tasks",
			profile: ctx.profile,
			...searchUserTasksRequest(input, ctx.tenantId),
		});
		if (dr) return dr;

		logSearchCriteria(logger, "User Tasks", criteria);

		const result = await searchUserTasks(
			{ ...input, ...clusterInputOf(ctx) },
			{},
		);

		if (result.items && result.items.length > 0) {
			let tableData = result.items.map((task) => ({
				Key: task.userTaskKey || task.key,
				Name: task.name || task.elementId,
				State: task.state,
				Assignee: task.assignee || "(unassigned)",
				Created: task.creationDate || "-",
				"Process Instance": task.processInstanceKey,
				"Tenant ID": task.tenantId,
			}));
			tableData = sortTableData(tableData, ctx.sortBy, logger, ctx.sortOrder);
			logger.table(tableData);
			logResultCount(
				logger,
				result.items.length,
				"user task(s)",
				criteria.length > 0,
			);
		} else {
			logNoResults(logger, "user tasks", criteria.length > 0);
		}
	},
);

/**
 * Search incidents
 */
export const searchIncidentsCommand = defineCommand(
	"search",
	"incident",
	async (ctx, flags, _args) => {
		const { logger } = ctx;
		const processDefinitionId =
			flags.id || flags.processDefinitionId || flags.bpmnProcessId;

		// Build search criteria description for user feedback
		const criteria: string[] = [];
		if (flags.state) {
			criteria.push(formatCriterion("state", flags.state));
		}
		if (flags.processInstanceKey) {
			criteria.push(
				formatCriterion("Process Instance Key", flags.processInstanceKey),
			);
		}
		if (flags.processDefinitionKey) {
			criteria.push(
				formatCriterion("Process Definition Key", flags.processDefinitionKey),
			);
		}
		if (flags.errorType) {
			criteria.push(formatCriterion("Error Type", flags.errorType));
		}
		if (flags.errorMessage) {
			criteria.push(formatCriterion("Error Message", flags.errorMessage));
		}
		if (processDefinitionId) {
			criteria.push(
				formatCriterion("Process Definition ID", processDefinitionId),
			);
		}
		if (flags.ierrorMessage) {
			criteria.push(
				formatCriterion("Error Message", flags.ierrorMessage, true),
			);
		}
		if (flags.iid) {
			criteria.push(formatCriterion("Process Definition ID", flags.iid, true));
		}
		if (ctx.between) {
			criteria.push(`'creationTime' between "${ctx.between}"`);
		}

		const input = {
			state: flags.state,
			processInstanceKey: flags.processInstanceKey,
			processDefinitionKey: flags.processDefinitionKey,
			errorType: flags.errorType,
			errorMessage: flags.errorMessage,
			processDefinitionId,
			ierrorMessage: flags.ierrorMessage,
			iid: flags.iid,
			between: ctx.between,
		};

		const dr = ctx.dryRun({
			command: "search incidents",
			profile: ctx.profile,
			...searchIncidentsRequest(input, ctx.tenantId),
		});
		if (dr) return dr;

		logSearchCriteria(logger, "Incidents", criteria);

		const result = await searchIncidents(
			{ ...input, ...clusterInputOf(ctx) },
			{},
		);

		if (result.items && result.items.length > 0) {
			let tableData = result.items.map((incident) => ({
				Key: incident.incidentKey || incident.key,
				Type: incident.errorType,
				Message:
					typeof incident.errorMessage === "string"
						? incident.errorMessage.substring(0, 50)
						: "",
				State: incident.state,
				Created: incident.creationTime || "-",
				"Process Instance": incident.processInstanceKey,
				"Tenant ID": incident.tenantId,
			}));
			tableData = sortTableData(tableData, ctx.sortBy, logger, ctx.sortOrder);
			logger.table(tableData);
			logResultCount(
				logger,
				result.items.length,
				"incident(s)",
				criteria.length > 0,
			);
		} else {
			logNoResults(logger, "incidents", criteria.length > 0);
		}
	},
);

/**
 * Search jobs
 */
export const searchJobsCommand = defineCommand(
	"search",
	"jobs",
	async (ctx, flags, _args) => {
		const { logger } = ctx;

		// Build search criteria description for user feedback
		const criteria: string[] = [];
		if (flags.state) {
			criteria.push(formatCriterion("state", flags.state));
		}
		if (flags.type) {
			criteria.push(formatCriterion("type", flags.type));
		}
		if (flags.processInstanceKey) {
			criteria.push(
				formatCriterion("Process Instance Key", flags.processInstanceKey),
			);
		}
		if (flags.processDefinitionKey) {
			criteria.push(
				formatCriterion("Process Definition Key", flags.processDefinitionKey),
			);
		}
		if (flags.itype) {
			criteria.push(formatCriterion("type", flags.itype, true));
		}
		if (ctx.between) {
			const field = ctx.dateField ?? "creationTime";
			criteria.push(`'${field}' between "${ctx.between}"`);
		}

		const input = {
			state: flags.state,
			type: flags.type,
			processInstanceKey: flags.processInstanceKey,
			processDefinitionKey: flags.processDefinitionKey,
			itype: flags.itype,
			between: ctx.between,
			dateField: ctx.dateField,
		};

		const dr = ctx.dryRun({
			command: "search jobs",
			profile: ctx.profile,
			...searchJobsRequest(input, ctx.tenantId),
		});
		if (dr) return dr;

		logSearchCriteria(logger, "Jobs", criteria);

		const result = await searchJobs({ ...input, ...clusterInputOf(ctx) }, {});

		if (result.items && result.items.length > 0) {
			let tableData = result.items.map((job) => ({
				Key: job.jobKey || job.key,
				Type: job.type,
				State: job.state,
				Retries: job.retries,
				Created: job.creationTime || "-",
				"Process Instance": job.processInstanceKey,
				"Tenant ID": job.tenantId,
			}));
			tableData = sortTableData(tableData, ctx.sortBy, logger, ctx.sortOrder);
			logger.table(tableData);
			logResultCount(
				logger,
				result.items.length,
				"job(s)",
				criteria.length > 0,
			);
		} else {
			logNoResults(logger, "jobs", criteria.length > 0);
		}
	},
);

/**
 * Search variables
 */
export const searchVariablesCommand = defineCommand(
	"search",
	"variable",
	async (ctx, flags, _args) => {
		const { logger } = ctx;

		// Build search criteria description for user feedback
		const criteria: string[] = [];
		if (flags.name) {
			criteria.push(formatCriterion("name", flags.name));
		}
		if (flags.value) {
			criteria.push(formatCriterion("value", flags.value));
		}
		if (flags.processInstanceKey) {
			criteria.push(
				formatCriterion("Process Instance Key", flags.processInstanceKey),
			);
		}
		if (flags.scopeKey) {
			criteria.push(formatCriterion("Scope Key", flags.scopeKey));
		}
		if (flags.iname) {
			criteria.push(formatCriterion("name", flags.iname, true));
		}
		if (flags.ivalue) {
			criteria.push(formatCriterion("value", flags.ivalue, true));
		}
		if (flags.fullValue) {
			criteria.push(formatCriterion("fullValue", true));
		}

		const input = {
			name: flags.name,
			value: flags.value,
			processInstanceKey: flags.processInstanceKey,
			scopeKey: flags.scopeKey,
			iname: flags.iname,
			ivalue: flags.ivalue,
			fullValue: flags.fullValue,
			limit: ctx.limit,
		};

		const dr = ctx.dryRun({
			command: "search variables",
			profile: ctx.profile,
			...searchVariablesRequest(input, ctx.tenantId),
		});
		if (dr) return dr;

		logSearchCriteria(logger, "Variables", criteria);

		const result = await searchVariables(
			{ ...input, ...clusterInputOf(ctx) },
			{},
		);

		if (result.items && result.items.length > 0) {
			let tableData = result.items.map((variable) => {
				const row: Record<string, unknown> = {
					Name: variable.name,
					Value: variable.value || "",
					"Process Instance": variable.processInstanceKey,
					"Scope Key": variable.scopeKey,
					"Tenant ID": variable.tenantId,
				};

				if (variable.isTruncated) {
					row.Truncated = "✓";
				}

				return row;
			});
			tableData = sortTableData(tableData, ctx.sortBy, logger, ctx.sortOrder);
			logger.table(tableData);
			logResultCount(
				logger,
				result.items.length,
				"variable(s)",
				criteria.length > 0,
			);

			if (!flags.fullValue && result.items.some((v) => v.isTruncated)) {
				logger.info(
					"Some values are truncated. Use --fullValue to see full values.",
				);
			}
		} else {
			logNoResults(logger, "variables", criteria.length > 0);
		}
	},
);

/**
 * Search wait states (element instances currently waiting for an external event).
 * API: POST /v2/element-instances/wait-states/search
 *
 * Uses the SDK client method `searchElementInstanceWaitStates`, exposed since
 * `@camunda8/orchestration-cluster-api` v10.
 */
export const searchWaitStatesCommand = defineCommand(
	"search",
	"wait-state",
	async (ctx, flags, _args) => {
		const { logger } = ctx;

		const criteria: string[] = [];
		if (flags.processInstanceKey) {
			criteria.push(
				formatCriterion("Process Instance Key", flags.processInstanceKey),
			);
		}
		if (flags.rootProcessInstanceKey) {
			criteria.push(
				formatCriterion(
					"Root Process Instance Key",
					flags.rootProcessInstanceKey,
				),
			);
		}
		if (flags.elementInstanceKey) {
			criteria.push(
				formatCriterion("Element Instance Key", flags.elementInstanceKey),
			);
		}
		if (flags.elementId) {
			criteria.push(formatCriterion("Element ID", flags.elementId));
		}
		if (flags.elementType) {
			criteria.push(formatCriterion("Element Type", flags.elementType));
		}
		if (flags.waitStateType) {
			criteria.push(formatCriterion("Wait State Type", flags.waitStateType));
		}

		const input = {
			processInstanceKey: flags.processInstanceKey,
			rootProcessInstanceKey: flags.rootProcessInstanceKey,
			elementInstanceKey: flags.elementInstanceKey,
			elementId: flags.elementId,
			elementType: flags.elementType,
			waitStateType: flags.waitStateType,
			limit: ctx.limit,
		};

		const dr = ctx.dryRun({
			command: "search wait-state",
			profile: ctx.profile,
			...searchWaitStatesRequest(input),
		});
		if (dr) return dr;

		logSearchCriteria(logger, "Wait States", criteria);

		const { items: allItems } = await searchWaitStates(
			{ ...input, ...clusterInputOf(ctx) },
			{},
		);

		if (allItems.length > 0) {
			let tableData = allItems.map((ws) => ({
				"Element Instance Key": ws.elementInstanceKey,
				"Process Instance Key": ws.processInstanceKey,
				"Root PI Key": ws.rootProcessInstanceKey ?? "-",
				"Element ID": ws.elementId,
				"Element Type": ws.elementType,
				"Wait State":
					isRecord(ws.details) && typeof ws.details.waitStateType === "string"
						? ws.details.waitStateType
						: "-",
				Details: renderWaitStateDetails(ws.details),
			}));
			tableData = sortTableData(tableData, ctx.sortBy, logger, ctx.sortOrder);
			logger.table(tableData);
			logResultCount(
				logger,
				allItems.length,
				"wait state(s)",
				criteria.length > 0,
			);
		} else {
			logNoResults(logger, "wait states", criteria.length > 0);
		}
	},
);
