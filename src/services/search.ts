/**
 * Search services: process definitions, process instances, user tasks,
 * incidents, jobs, variables, wait states.
 *
 * String filters take `*` and `?` wildcards. The `i…` inputs (e.g. `iid`,
 * `iname`) match case-insensitively; the API cannot, so these searches
 * fetch larger pages and filter the results here.
 */

import type { C8ctlContext, ClusterInput } from "../core/index.ts";
import {
	C8ctlError,
	callCluster,
	connect,
	DEFAULT_PAGE_SIZE,
	fetchAllPages,
} from "../core/index.ts";
import {
	buildDateFilter,
	hasUnescapedWildcard,
	matchesCaseInsensitive,
	matchesCaseSensitive,
	parseBetween,
	toStringFilter,
} from "../utils/index.ts";

/** A search result item, as the API returns it. */
export type SearchItem = Record<string, unknown>;

/** Max page size for case-insensitive search (client-side filtering needs broader result set) */
const CI_PAGE_SIZE = 1000;

/** `fetchAllPages`'s page size argument: larger pages to filter here. */
const toBigIntSafe = (value: unknown): bigint => {
	try {
		return BigInt(String(value));
	} catch {
		return 0n;
	}
};

function dateRangeFilter(between: string) {
	const parsed = parseBetween(between);
	if (!parsed) {
		throw new C8ctlError(
			"invalid-input",
			"Invalid --between value. Expected format: <from>..<to> (e.g. 2024-01-01..2024-12-31, ISO 8601 datetimes, or open-ended: ..2024-12-31 or 2024-01-01..)",
			{ field: "between" },
		);
	}
	return buildDateFilter(parsed.from, parsed.to);
}

// ─── process definitions ─────────────────────────────────────────────────────

export interface SearchProcessDefinitionsInput {
	processDefinitionId?: string;
	name?: string;
	version?: number;
	/** Process definition key. */
	key?: string;
	/** Process definition ID, case-insensitive. */
	iid?: string;
	/** Name, case-insensitive. */
	iname?: string;
}

export function searchProcessDefinitionsRequest(
	input: SearchProcessDefinitionsInput,
	tenantId: string | undefined,
) {
	const filter: Record<string, unknown> = { tenantId };
	if (input.processDefinitionId) {
		filter.processDefinitionId = toStringFilter(input.processDefinitionId);
	}
	if (input.name) filter.name = toStringFilter(input.name);
	if (input.version !== undefined) filter.version = input.version;
	if (input.key) filter.processDefinitionKey = input.key;
	return {
		method: "POST",
		endpoint: "/process-definitions/search",
		body: { filter },
	};
}

/** Newest first: by version, then by key, both descending. */
export async function searchProcessDefinitions(
	input: SearchProcessDefinitionsInput & ClusterInput,
	ctx: C8ctlContext = {},
): Promise<{ items: SearchItem[] }> {
	const { client, defaultTenantId } = connect(input.target, ctx);
	const { body } = searchProcessDefinitionsRequest(
		input,
		input.tenantId ?? defaultTenantId,
	);
	const caseInsensitive = !!(input.iid || input.iname);
	let items = await callCluster(
		(signal) =>
			fetchAllPages<SearchItem>(
				(f, opts) => client.searchProcessDefinitions(f, opts),
				body,
				caseInsensitive ? CI_PAGE_SIZE : undefined,
				undefined,
				signal,
			),
		ctx,
	);

	if (items.length) {
		items = [...items].sort((left, right) => {
			const versionDelta =
				(Number(right.version) || 0) - (Number(left.version) || 0);
			if (versionDelta !== 0) return versionDelta;

			const leftKey = toBigIntSafe(left.processDefinitionKey ?? left.key);
			const rightKey = toBigIntSafe(right.processDefinitionKey ?? right.key);
			if (leftKey === rightKey) return 0;
			return rightKey > leftKey ? 1 : -1;
		});
	}

	if (caseInsensitive) {
		items = items.filter((pd) => {
			if (
				input.iid &&
				!matchesCaseInsensitive(pd.processDefinitionId, input.iid)
			)
				return false;
			if (input.iname && !matchesCaseInsensitive(pd.name, input.iname))
				return false;
			return true;
		});
	}
	return { items };
}

// ─── process instances ───────────────────────────────────────────────────────

export interface SearchProcessInstancesInput {
	processDefinitionId?: string;
	businessId?: string;
	processDefinitionKey?: string;
	state?: string;
	/** Process definition version. */
	version?: number;
	/** Process instance key. */
	key?: string;
	parentProcessInstanceKey?: string;
	/** Process definition ID, case-insensitive. */
	iid?: string;
	/** Date range `<from>..<to>`, e.g. `7d` or `2024-01-01..`. */
	between?: string;
	/** Date field `between` filters on. Default: `startDate`. */
	dateField?: string;
}

export function searchProcessInstancesRequest(
	input: SearchProcessInstancesInput,
	tenantId: string | undefined,
) {
	const filter: Record<string, unknown> = { tenantId };
	if (input.processDefinitionId) {
		filter.processDefinitionId = toStringFilter(input.processDefinitionId);
	}
	if (input.businessId) filter.businessId = toStringFilter(input.businessId);
	if (input.processDefinitionKey) {
		filter.processDefinitionKey = input.processDefinitionKey;
	}
	if (input.version !== undefined) {
		filter.processDefinitionVersion = input.version;
	}
	if (input.state) filter.state = input.state;
	if (input.key) filter.processInstanceKey = input.key;
	if (input.parentProcessInstanceKey) {
		filter.parentProcessInstanceKey = input.parentProcessInstanceKey;
	}
	if (input.between) {
		filter[input.dateField ?? "startDate"] = dateRangeFilter(input.between);
	}
	return {
		method: "POST",
		endpoint: "/process-instances/search",
		body: { filter },
	};
}

export async function searchProcessInstances(
	input: SearchProcessInstancesInput & ClusterInput,
	ctx: C8ctlContext = {},
): Promise<{ items: SearchItem[] }> {
	const { client, defaultTenantId } = connect(input.target, ctx);
	const { body } = searchProcessInstancesRequest(
		input,
		input.tenantId ?? defaultTenantId,
	);
	const caseInsensitive = !!input.iid;
	let items = await callCluster(
		(signal) =>
			fetchAllPages<SearchItem>(
				(f, opts) => client.searchProcessInstances(f, opts),
				body,
				caseInsensitive ? CI_PAGE_SIZE : undefined,
				undefined,
				signal,
			),
		ctx,
	);

	if (caseInsensitive) {
		items = items.filter((pi) => {
			if (
				input.iid &&
				!matchesCaseInsensitive(pi.processDefinitionId, input.iid)
			)
				return false;
			return true;
		});
	}
	return { items };
}

// ─── user tasks ──────────────────────────────────────────────────────────────

export interface SearchUserTasksInput {
	state?: string;
	assignee?: string;
	processInstanceKey?: string;
	processDefinitionKey?: string;
	elementId?: string;
	/** Assignee, case-insensitive. */
	iassignee?: string;
	/** Date range `<from>..<to>`, e.g. `7d` or `2024-01-01..`. */
	between?: string;
	/** Date field `between` filters on. Default: `creationDate`. */
	dateField?: string;
}

export function searchUserTasksRequest(
	input: SearchUserTasksInput,
	tenantId: string | undefined,
) {
	const filter: Record<string, unknown> = { tenantId };
	if (input.state) filter.state = input.state;
	if (input.assignee) filter.assignee = toStringFilter(input.assignee);
	if (input.processInstanceKey) {
		filter.processInstanceKey = input.processInstanceKey;
	}
	if (input.processDefinitionKey) {
		filter.processDefinitionKey = input.processDefinitionKey;
	}
	if (input.elementId) filter.elementId = input.elementId;
	if (input.between) {
		filter[input.dateField ?? "creationDate"] = dateRangeFilter(input.between);
	}
	return { method: "POST", endpoint: "/user-tasks/search", body: { filter } };
}

export async function searchUserTasks(
	input: SearchUserTasksInput & ClusterInput,
	ctx: C8ctlContext = {},
): Promise<{ items: SearchItem[] }> {
	const { client, defaultTenantId } = connect(input.target, ctx);
	const { body } = searchUserTasksRequest(
		input,
		input.tenantId ?? defaultTenantId,
	);
	const caseInsensitive = !!input.iassignee;
	let items = await callCluster(
		(signal) =>
			fetchAllPages<SearchItem>(
				(f, opts) => client.searchUserTasks(f, opts),
				body,
				caseInsensitive ? CI_PAGE_SIZE : undefined,
				undefined,
				signal,
			),
		ctx,
	);

	if (caseInsensitive) {
		items = items.filter((task) => {
			if (
				input.iassignee &&
				!matchesCaseInsensitive(task.assignee, input.iassignee)
			)
				return false;
			return true;
		});
	}
	return { items };
}

// ─── incidents ───────────────────────────────────────────────────────────────

export interface SearchIncidentsInput {
	state?: string;
	processInstanceKey?: string;
	processDefinitionKey?: string;
	errorType?: string;
	errorMessage?: string;
	processDefinitionId?: string;
	/** Error message, case-insensitive. */
	ierrorMessage?: string;
	/** Process definition ID, case-insensitive. */
	iid?: string;
	/** Creation time range `<from>..<to>`, e.g. `7d` or `2024-01-01..`. */
	between?: string;
}

/**
 * The incident API has no `$like` filter for `errorMessage`, so a wildcard
 * error message is matched here instead of sent.
 */
function errorMessageHasWildcard(input: SearchIncidentsInput): boolean {
	return !!(input.errorMessage && hasUnescapedWildcard(input.errorMessage));
}

export function searchIncidentsRequest(
	input: SearchIncidentsInput,
	tenantId: string | undefined,
) {
	const filter: Record<string, unknown> = { tenantId };
	if (input.state) filter.state = input.state;
	if (input.processInstanceKey) {
		filter.processInstanceKey = input.processInstanceKey;
	}
	if (input.processDefinitionKey) {
		filter.processDefinitionKey = input.processDefinitionKey;
	}
	if (input.errorType) filter.errorType = input.errorType;
	if (input.errorMessage && !errorMessageHasWildcard(input)) {
		filter.errorMessage = input.errorMessage;
	}
	if (input.processDefinitionId) {
		filter.processDefinitionId = toStringFilter(input.processDefinitionId);
	}
	if (input.between) filter.creationTime = dateRangeFilter(input.between);
	return { method: "POST", endpoint: "/incidents/search", body: { filter } };
}

export async function searchIncidents(
	input: SearchIncidentsInput & ClusterInput,
	ctx: C8ctlContext = {},
): Promise<{ items: SearchItem[] }> {
	const { client, defaultTenantId } = connect(input.target, ctx);
	const { body } = searchIncidentsRequest(
		input,
		input.tenantId ?? defaultTenantId,
	);
	const wildcardMessage = errorMessageHasWildcard(input);
	const caseInsensitive = !!(
		input.ierrorMessage ||
		input.iid ||
		wildcardMessage
	);
	let items = await callCluster(
		(signal) =>
			fetchAllPages<SearchItem>(
				(f, opts) => client.searchIncidents(f, opts),
				body,
				caseInsensitive ? CI_PAGE_SIZE : undefined,
				undefined,
				signal,
			),
		ctx,
	);

	if (caseInsensitive) {
		items = items.filter((incident) => {
			if (
				input.ierrorMessage &&
				!matchesCaseInsensitive(incident.errorMessage, input.ierrorMessage)
			)
				return false;
			if (
				input.iid &&
				!matchesCaseInsensitive(incident.processDefinitionId, input.iid)
			)
				return false;
			if (
				wildcardMessage &&
				input.errorMessage &&
				!matchesCaseSensitive(incident.errorMessage, input.errorMessage)
			)
				return false;
			return true;
		});
	}
	return { items };
}

// ─── jobs ────────────────────────────────────────────────────────────────────

export interface SearchJobsInput {
	state?: string;
	type?: string;
	processInstanceKey?: string;
	processDefinitionKey?: string;
	/** Job type, case-insensitive. */
	itype?: string;
	/** Date range `<from>..<to>`, e.g. `7d` or `2024-01-01..`. */
	between?: string;
	/** Date field `between` filters on. Default: `creationTime`. */
	dateField?: string;
}

export function searchJobsRequest(
	input: SearchJobsInput,
	tenantId: string | undefined,
) {
	const filter: Record<string, unknown> = { tenantId };
	if (input.state) filter.state = input.state;
	if (input.type) filter.type = toStringFilter(input.type);
	if (input.processInstanceKey) {
		filter.processInstanceKey = input.processInstanceKey;
	}
	if (input.processDefinitionKey) {
		filter.processDefinitionKey = input.processDefinitionKey;
	}
	if (input.between) {
		filter[input.dateField ?? "creationTime"] = dateRangeFilter(input.between);
	}
	return { method: "POST", endpoint: "/jobs/search", body: { filter } };
}

export async function searchJobs(
	input: SearchJobsInput & ClusterInput,
	ctx: C8ctlContext = {},
): Promise<{ items: SearchItem[] }> {
	const { client, defaultTenantId } = connect(input.target, ctx);
	const { body } = searchJobsRequest(input, input.tenantId ?? defaultTenantId);
	const caseInsensitive = !!input.itype;
	let items = await callCluster(
		(signal) =>
			fetchAllPages<SearchItem>(
				(f, opts) => client.searchJobs(f, opts),
				body,
				caseInsensitive ? CI_PAGE_SIZE : undefined,
				undefined,
				signal,
			),
		ctx,
	);

	if (caseInsensitive) {
		items = items.filter((job) => {
			if (input.itype && !matchesCaseInsensitive(job.type, input.itype))
				return false;
			return true;
		});
	}
	return { items };
}

// ─── variables ───────────────────────────────────────────────────────────────

export interface SearchVariablesInput {
	name?: string;
	value?: string;
	processInstanceKey?: string;
	scopeKey?: string;
	/** Name, case-insensitive. */
	iname?: string;
	/** Value, case-insensitive; a JSON string value is compared unquoted. */
	ivalue?: string;
	/** Return full values. Default: values are truncated. */
	fullValue?: boolean;
	/** Maximum number of variables. Default: all. */
	limit?: number;
}

export function searchVariablesRequest(
	input: SearchVariablesInput,
	tenantId: string | undefined,
) {
	const filter: Record<string, unknown> = { tenantId };
	if (input.name) filter.name = toStringFilter(input.name);
	if (input.value) filter.value = toStringFilter(input.value);
	if (input.processInstanceKey) {
		filter.processInstanceKey = input.processInstanceKey;
	}
	if (input.scopeKey) filter.scopeKey = input.scopeKey;
	return {
		method: "POST",
		endpoint: "/variables/search",
		body: { filter, truncateValues: !input.fullValue },
	};
}

export async function searchVariables(
	input: SearchVariablesInput & ClusterInput,
	ctx: C8ctlContext = {},
): Promise<{ items: SearchItem[] }> {
	const { client, defaultTenantId } = connect(input.target, ctx);
	const {
		body: { filter, truncateValues },
	} = searchVariablesRequest(input, input.tenantId ?? defaultTenantId);
	const caseInsensitive = !!(input.iname || input.ivalue);
	let items = await callCluster(
		(signal) =>
			fetchAllPages<SearchItem>(
				(f, opts) => client.searchVariables({ ...f, truncateValues }, opts),
				{ filter },
				caseInsensitive ? CI_PAGE_SIZE : DEFAULT_PAGE_SIZE,
				input.limit,
				signal,
			),
		ctx,
	);

	if (caseInsensitive) {
		items = items.filter((variable) => {
			if (input.iname && !matchesCaseInsensitive(variable.name, input.iname))
				return false;
			if (input.ivalue) {
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
				if (!matchesCaseInsensitive(rawValue, input.ivalue)) return false;
			}
			return true;
		});
	}
	return { items };
}

// ─── wait states ─────────────────────────────────────────────────────────────

/** Element instances currently waiting for an external event. */
export interface SearchWaitStatesInput {
	processInstanceKey?: string;
	rootProcessInstanceKey?: string;
	elementInstanceKey?: string;
	elementId?: string;
	elementType?: string;
	/** e.g. `JOB`, `MESSAGE`, `TIMER`. */
	waitStateType?: string;
	/** Maximum number of wait states. Default: all. */
	limit?: number;
}

/** Wait states are not tenant-scoped: the request has no tenant filter. */
export function searchWaitStatesRequest(input: SearchWaitStatesInput) {
	const filter: Record<string, unknown> = {};
	if (input.processInstanceKey) {
		filter.processInstanceKey = input.processInstanceKey;
	}
	if (input.rootProcessInstanceKey) {
		filter.rootProcessInstanceKey = input.rootProcessInstanceKey;
	}
	if (input.elementInstanceKey) {
		filter.elementInstanceKey = input.elementInstanceKey;
	}
	if (input.elementId) filter.elementId = toStringFilter(input.elementId);
	if (input.elementType) filter.elementType = input.elementType;
	if (input.waitStateType) filter.waitStateType = input.waitStateType;
	return {
		method: "POST",
		endpoint: "/element-instances/wait-states/search",
		body: { filter },
	};
}

export async function searchWaitStates(
	input: SearchWaitStatesInput & ClusterInput,
	ctx: C8ctlContext = {},
): Promise<{ items: SearchItem[] }> {
	const { client } = connect(input.target, ctx);
	const { body } = searchWaitStatesRequest(input);
	const items = await callCluster(
		(signal) =>
			fetchAllPages<SearchItem>(
				(f, opts) => client.searchElementInstanceWaitStates(f, opts),
				body,
				DEFAULT_PAGE_SIZE,
				input.limit,
				signal,
			),
		ctx,
	);
	return { items };
}
