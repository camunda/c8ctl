/**
 * Search commands
 */

import { DEFAULT_PAGE_SIZE, fetchAllPages } from "../client.ts";
import { defineCommand, dryRun } from "../command-framework.ts";
import { buildDateFilter, parseBetween } from "../date-filter.ts";
import { type Logger, sortTableData } from "../logger.ts";
import {
	API_DEFAULT_PAGE_SIZE,
	hasUnescapedWildcard,
	logNoResults,
	logResultCount,
	matchesCaseInsensitive,
	matchesCaseSensitive,
	toStringFilter,
	wildcardToRegex,
} from "../search-helpers.ts";

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

export type SearchResult = {
	items: Array<Record<string, unknown>>;
	total?: number;
};

const toBigIntSafe = (value: unknown): bigint => {
	try {
		return BigInt(String(value));
	} catch {
		return 0n;
	}
};

/** Max page size for case-insensitive search (client-side filtering needs broader result set) */
const CI_PAGE_SIZE = 1000;

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
		const { client, logger, tenantId, profile } = ctx;
		const processDefinitionId =
			flags.id || flags.processDefinitionId || flags.bpmnProcessId;
		const version = ctx.version;
		const hasCiFilter = !!(flags.iid || flags.iname);

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

		const filter: { filter: Record<string, unknown> } = {
			filter: {
				tenantId,
			},
		};

		if (processDefinitionId) {
			filter.filter.processDefinitionId = toStringFilter(processDefinitionId);
		}

		if (flags.name) {
			filter.filter.name = toStringFilter(flags.name);
		}

		if (version !== undefined) {
			filter.filter.version = version;
		}

		if (flags.key) {
			filter.filter.processDefinitionKey = flags.key;
		}

		const dr = dryRun({
			command: "search process-definitions",
			method: "POST",
			endpoint: "/process-definitions/search",
			profile,
			body: filter,
		});
		if (dr) return dr;

		logSearchCriteria(logger, "Process Definitions", criteria);

		const allItems = await fetchAllPages<Record<string, unknown>>(
			(f, opts) => client.searchProcessDefinitions(f, opts),
			filter,
			...(hasCiFilter ? ([CI_PAGE_SIZE] as const) : []),
		);
		const result: SearchResult = { items: allItems };

		if (result.items?.length) {
			result.items = [...result.items].sort((left, right) => {
				const versionDelta =
					(Number(right.version) || 0) - (Number(left.version) || 0);
				if (versionDelta !== 0) return versionDelta;

				const leftKey = toBigIntSafe(left.processDefinitionKey ?? left.key);
				const rightKey = toBigIntSafe(right.processDefinitionKey ?? right.key);
				if (leftKey === rightKey) return 0;
				return rightKey > leftKey ? 1 : -1;
			});
		}

		// Client-side case-insensitive post-filtering
		if (hasCiFilter && result.items) {
			result.items = result.items.filter((pd) => {
				if (
					flags.iid &&
					!matchesCaseInsensitive(pd.processDefinitionId, flags.iid)
				)
					return false;
				if (flags.iname && !matchesCaseInsensitive(pd.name, flags.iname))
					return false;
				return true;
			});
		}

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
		const { client, logger, tenantId, profile } = ctx;
		const processDefinitionId =
			flags.id || flags.processDefinitionId || flags.bpmnProcessId;
		const version = ctx.version;
		const hasCiFilter = !!flags.iid;

		// Build search criteria description for user feedback
		const criteria: string[] = [];
		if (processDefinitionId) {
			criteria.push(
				formatCriterion("Process Definition ID", processDefinitionId),
			);
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

		const filter: { filter: Record<string, unknown> } = {
			filter: {
				tenantId,
			},
		};

		if (processDefinitionId) {
			filter.filter.processDefinitionId = toStringFilter(processDefinitionId);
		}

		if (flags.processDefinitionKey) {
			filter.filter.processDefinitionKey = flags.processDefinitionKey;
		}

		if (version !== undefined) {
			filter.filter.processDefinitionVersion = version;
		}

		if (flags.state) {
			filter.filter.state = flags.state;
		}

		if (flags.key) {
			filter.filter.processInstanceKey = flags.key;
		}

		if (flags.parentProcessInstanceKey) {
			filter.filter.parentProcessInstanceKey = flags.parentProcessInstanceKey;
		}

		if (ctx.between) {
			const parsed = parseBetween(ctx.between);
			if (parsed) {
				const field = ctx.dateField ?? "startDate";
				filter.filter[field] = buildDateFilter(parsed.from, parsed.to);
			} else {
				throw new Error(
					"Invalid --between value. Expected format: <from>..<to> (e.g. 2024-01-01..2024-12-31, ISO 8601 datetimes, or open-ended: ..2024-12-31 or 2024-01-01..)",
				);
			}
		}

		const dr = dryRun({
			command: "search process-instances",
			method: "POST",
			endpoint: "/process-instances/search",
			profile,
			body: filter,
		});
		if (dr) return dr;

		logSearchCriteria(logger, "Process Instances", criteria);

		const allItems = await fetchAllPages<Record<string, unknown>>(
			(f, opts) => client.searchProcessInstances(f, opts),
			filter,
			...(hasCiFilter ? ([CI_PAGE_SIZE] as const) : []),
		);
		const result: SearchResult = { items: allItems };

		if (hasCiFilter && result.items) {
			result.items = result.items.filter((pi) => {
				if (
					flags.iid &&
					!matchesCaseInsensitive(pi.processDefinitionId, flags.iid)
				)
					return false;
				return true;
			});
		}

		if (result.items && result.items.length > 0) {
			let tableData = result.items.map((pi) => ({
				Key: pi.processInstanceKey || pi.key,
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
		const { client, logger, tenantId, profile } = ctx;
		const hasCiFilter = !!flags.iassignee;

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

		const filter: { filter: Record<string, unknown> } = {
			filter: {
				tenantId,
			},
		};

		if (flags.state) {
			filter.filter.state = flags.state;
		}

		if (flags.assignee) {
			filter.filter.assignee = toStringFilter(flags.assignee);
		}

		if (flags.processInstanceKey) {
			filter.filter.processInstanceKey = flags.processInstanceKey;
		}

		if (flags.processDefinitionKey) {
			filter.filter.processDefinitionKey = flags.processDefinitionKey;
		}

		if (flags.elementId) {
			filter.filter.elementId = flags.elementId;
		}

		if (ctx.between) {
			const parsed = parseBetween(ctx.between);
			if (parsed) {
				const field = ctx.dateField ?? "creationDate";
				filter.filter[field] = buildDateFilter(parsed.from, parsed.to);
			} else {
				throw new Error(
					"Invalid --between value. Expected format: <from>..<to> (e.g. 2024-01-01..2024-12-31, ISO 8601 datetimes, or open-ended: ..2024-12-31 or 2024-01-01..)",
				);
			}
		}

		const dr = dryRun({
			command: "search user-tasks",
			method: "POST",
			endpoint: "/user-tasks/search",
			profile,
			body: filter,
		});
		if (dr) return dr;

		logSearchCriteria(logger, "User Tasks", criteria);

		const allItems = await fetchAllPages<Record<string, unknown>>(
			(f, opts) => client.searchUserTasks(f, opts),
			filter,
			...(hasCiFilter ? ([CI_PAGE_SIZE] as const) : []),
		);
		const result: SearchResult = { items: allItems };

		if (hasCiFilter && result.items) {
			result.items = result.items.filter((task) => {
				if (
					flags.iassignee &&
					!matchesCaseInsensitive(task.assignee, flags.iassignee)
				)
					return false;
				return true;
			});
		}

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
		const { client, logger, tenantId, profile } = ctx;
		const processDefinitionId =
			flags.id || flags.processDefinitionId || flags.bpmnProcessId;
		// The incident API does not support a $like filter for errorMessage; fall back to client-side filtering for wildcard patterns
		const errorMessageHasWildcard = !!(
			flags.errorMessage && hasUnescapedWildcard(flags.errorMessage)
		);
		const hasCiFilter = !!(
			flags.ierrorMessage ||
			flags.iid ||
			errorMessageHasWildcard
		);

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

		const filter: { filter: Record<string, unknown> } = {
			filter: {
				tenantId,
			},
		};

		if (flags.state) {
			filter.filter.state = flags.state;
		}

		if (flags.processInstanceKey) {
			filter.filter.processInstanceKey = flags.processInstanceKey;
		}

		if (flags.processDefinitionKey) {
			filter.filter.processDefinitionKey = flags.processDefinitionKey;
		}

		if (flags.errorType) {
			filter.filter.errorType = flags.errorType;
		}

		if (flags.errorMessage && !errorMessageHasWildcard) {
			filter.filter.errorMessage = flags.errorMessage;
		}

		if (processDefinitionId) {
			filter.filter.processDefinitionId = toStringFilter(processDefinitionId);
		}

		if (ctx.between) {
			const parsed = parseBetween(ctx.between);
			if (parsed) {
				filter.filter.creationTime = buildDateFilter(parsed.from, parsed.to);
			} else {
				throw new Error(
					"Invalid --between value. Expected format: <from>..<to> (e.g. 2024-01-01..2024-12-31, ISO 8601 datetimes, or open-ended: ..2024-12-31 or 2024-01-01..)",
				);
			}
		}

		const dr = dryRun({
			command: "search incidents",
			method: "POST",
			endpoint: "/incidents/search",
			profile,
			body: filter,
		});
		if (dr) return dr;

		logSearchCriteria(logger, "Incidents", criteria);

		const allItems = await fetchAllPages<Record<string, unknown>>(
			(f, opts) => client.searchIncidents(f, opts),
			filter,
			...(hasCiFilter ? ([CI_PAGE_SIZE] as const) : []),
		);
		const result: SearchResult = { items: allItems };

		if (hasCiFilter && result.items) {
			result.items = result.items.filter((incident) => {
				if (
					flags.ierrorMessage &&
					!matchesCaseInsensitive(incident.errorMessage, flags.ierrorMessage)
				)
					return false;
				if (
					flags.iid &&
					!matchesCaseInsensitive(incident.processDefinitionId, flags.iid)
				)
					return false;
				if (
					errorMessageHasWildcard &&
					flags.errorMessage &&
					!matchesCaseSensitive(incident.errorMessage, flags.errorMessage)
				)
					return false;
				return true;
			});
		}

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
		const { client, logger, tenantId, profile } = ctx;
		const hasCiFilter = !!flags.itype;

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

		const filter: { filter: Record<string, unknown> } = {
			filter: {
				tenantId,
			},
		};

		if (flags.state) {
			filter.filter.state = flags.state;
		}

		if (flags.type) {
			filter.filter.type = toStringFilter(flags.type);
		}

		if (flags.processInstanceKey) {
			filter.filter.processInstanceKey = flags.processInstanceKey;
		}

		if (flags.processDefinitionKey) {
			filter.filter.processDefinitionKey = flags.processDefinitionKey;
		}

		if (ctx.between) {
			const parsed = parseBetween(ctx.between);
			if (parsed) {
				const field = ctx.dateField ?? "creationTime";
				filter.filter[field] = buildDateFilter(parsed.from, parsed.to);
			} else {
				throw new Error(
					"Invalid --between value. Expected format: <from>..<to> (e.g. 2024-01-01..2024-12-31, ISO 8601 datetimes, or open-ended: ..2024-12-31 or 2024-01-01..)",
				);
			}
		}

		const dr = dryRun({
			command: "search jobs",
			method: "POST",
			endpoint: "/jobs/search",
			profile,
			body: filter,
		});
		if (dr) return dr;

		logSearchCriteria(logger, "Jobs", criteria);

		const allItems = await fetchAllPages<Record<string, unknown>>(
			(f, opts) => client.searchJobs(f, opts),
			filter,
			...(hasCiFilter ? ([CI_PAGE_SIZE] as const) : []),
		);
		const result: SearchResult = { items: allItems };

		if (hasCiFilter && result.items) {
			result.items = result.items.filter((job) => {
				if (flags.itype && !matchesCaseInsensitive(job.type, flags.itype))
					return false;
				return true;
			});
		}

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
		const { client, logger, tenantId, profile } = ctx;
		const hasCiFilter = !!(flags.iname || flags.ivalue);

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

		const filter: { filter: Record<string, unknown> } = {
			filter: {
				tenantId,
			},
		};

		if (flags.name) {
			filter.filter.name = toStringFilter(flags.name);
		}

		if (flags.value) {
			filter.filter.value = toStringFilter(flags.value);
		}

		if (flags.processInstanceKey) {
			filter.filter.processInstanceKey = flags.processInstanceKey;
		}

		if (flags.scopeKey) {
			filter.filter.scopeKey = flags.scopeKey;
		}

		// By default, truncate values unless --fullValue is specified
		const truncateValues = !flags.fullValue;

		const dr = dryRun({
			command: "search variables",
			method: "POST",
			endpoint: "/variables/search",
			profile,
			body: { ...filter, truncateValues },
		});
		if (dr) return dr;

		logSearchCriteria(logger, "Variables", criteria);

		const allItems = await fetchAllPages<Record<string, unknown>>(
			(f, opts) => client.searchVariables({ ...f, truncateValues }, opts),
			filter,
			hasCiFilter ? CI_PAGE_SIZE : DEFAULT_PAGE_SIZE,
			ctx.limit,
		);

		const result: SearchResult = { items: allItems };

		if (hasCiFilter && result.items) {
			result.items = result.items.filter((variable) => {
				if (flags.iname && !matchesCaseInsensitive(variable.name, flags.iname))
					return false;
				if (flags.ivalue) {
					// Variable values come JSON-encoded from the API (e.g., '"PendingReview"').
					// Unwrap the JSON string for comparison so users can match the actual value.
					let rawValue =
						typeof variable.value === "string"
							? variable.value
							: String(variable.value ?? "");
					try {
						const parsed = JSON.parse(rawValue);
						if (typeof parsed === "string") rawValue = parsed;
					} catch {
						/* keep original value */
					}
					if (!matchesCaseInsensitive(rawValue, flags.ivalue)) return false;
				}
				return true;
			});
		}

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
