/**
 * Search commands
 */

import { getLogger, Logger, sortTableData, type SortOrder } from '../logger.ts';
import { createClient, fetchAllPages } from '../client.ts';
import { resolveTenantId } from '../config.ts';
import { parseBetween, buildDateFilter } from '../date-filter.ts';

export type SearchResult = { items: Array<Record<string, unknown>>; total?: number };

/**
 * Flags that are valid globally (not specific to any search resource).
 */
export const GLOBAL_FLAGS = new Set([
  'profile', 'sortBy', 'asc', 'desc', 'help', 'version',
]);

/**
 * Valid search filter flags per resource (values keys that are consumed by the search handler).
 * This map is used to detect when a user passes a flag that looks valid but is not recognized
 * for the specific resource, causing silent filter drops.
 */
export const SEARCH_RESOURCE_FLAGS: Record<string, Set<string>> = {
  'process-definition': new Set(['bpmnProcessId', 'id', 'processDefinitionId', 'name', 'key', 'iid', 'iname']),
  'process-instance': new Set(['bpmnProcessId', 'id', 'processDefinitionId', 'processDefinitionKey', 'state', 'key', 'parentProcessInstanceKey', 'iid']),
  'user-task': new Set(['state', 'assignee', 'processInstanceKey', 'processDefinitionKey', 'elementId', 'iassignee']),
  'incident': new Set(['state', 'processInstanceKey', 'processDefinitionKey', 'bpmnProcessId', 'id', 'processDefinitionId', 'errorType', 'errorMessage', 'ierrorMessage', 'iid']),
  'jobs': new Set(['state', 'type', 'processInstanceKey', 'processDefinitionKey', 'itype']),
  'variable': new Set(['name', 'value', 'processInstanceKey', 'scopeKey', 'fullValue', 'iname', 'ivalue', 'limit']),
};

/**
 * Detect flags the user set that are not recognized for the given search resource.
 * Returns the list of unknown flag names (without the --prefix).
 */
export function detectUnknownSearchFlags(values: Record<string, unknown>, normalizedResource: string): string[] {
  const validFlags = SEARCH_RESOURCE_FLAGS[normalizedResource]
    || SEARCH_RESOURCE_FLAGS[normalizedResource.replace(/s$/, '')];
  if (!validFlags) return [];

  const unknown: string[] = [];
  for (const [key, val] of Object.entries(values)) {
    if (val === undefined || val === false) continue; // not set by the user
    if (GLOBAL_FLAGS.has(key)) continue;
    if (validFlags.has(key)) continue;
    unknown.push(key);
  }
  return unknown;
}

/**
 * Detect wildcard characters (* or ?) in a string value and return
 * a $like filter object for the API. Returns the plain string for exact match.
 *
 * Supported wildcards (per Camunda REST API LikeFilter):
 *   * — matches zero, one, or multiple characters
 *   ? — matches exactly one character
 *   Escape with backslash: \* or \?
 */
export const hasUnescapedWildcard = (value: string): boolean =>
  /(?<!\\)[*?]/.test(value);

export const toStringFilter = (value: string): string | { $like: string } =>
  hasUnescapedWildcard(value) ? { $like: value } : value;

/**
 * Convert a wildcard pattern (* and ?) to a case-insensitive RegExp.
 * Handles escaped wildcards (\* and \?).
 */
export const wildcardToRegex = (pattern: string, caseInsensitive = true): RegExp => {
  let regex = '';
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === '\\' && i + 1 < pattern.length && (pattern[i + 1] === '*' || pattern[i + 1] === '?')) {
      regex += pattern[i + 1] === '*' ? '\\*' : '\\?';
      i++;
    } else if (pattern[i] === '*') {
      regex += '.*';
    } else if (pattern[i] === '?') {
      regex += '.';
    } else {
      regex += pattern[i].replace(/[[\]{}()+.,\\^$|#]/g, '\\$&');
    }
  }
  return new RegExp(`^${regex}$`, caseInsensitive ? 'i' : '');
};

/**
 * Test if a value matches a wildcard pattern case-insensitively.
 * Without wildcards, performs exact case-insensitive match.
 */
export const matchesCaseInsensitive = (value: string | undefined | null, pattern: string): boolean => {
  if (value == null) return false;
  return wildcardToRegex(pattern).test(value);
};

/**
 * Test if a value matches a wildcard pattern case-sensitively.
 * Without wildcards, performs exact case-sensitive match.
 */
export const matchesCaseSensitive = (value: string | undefined | null, pattern: string): boolean => {
  if (value == null) return false;
  return wildcardToRegex(pattern, false).test(value);
};

const toBigIntSafe = (value: unknown): bigint => {
  try {
    return BigInt(String(value));
  } catch {
    return 0n;
  }
};

/** Default page size the Camunda REST API uses when no explicit limit is set */
const API_DEFAULT_PAGE_SIZE = 100;

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
function formatCriterion(fieldLabel: string, value: string | number | boolean, isCaseInsensitive: boolean = false): string {
  if (typeof value === 'boolean') {
    return `'${fieldLabel}' = ${value}`;
  }
  
  if (typeof value === 'number') {
    return `'${fieldLabel}' = ${value}`;
  }
  
  const hasWildcard = hasUnescapedWildcard(value);
  const prefix = isCaseInsensitive ? '(case-insensitive) ' : '';
  
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
function logSearchCriteria(logger: Logger, resourceName: string, criteria: string[]): void {
  if (criteria.length === 0) {
    logger.info(`Searching ${resourceName} (no filters)`);
  } else if (criteria.length === 1) {
    logger.info(`Searching ${resourceName} where ${criteria[0]}`);
  } else {
    logger.info(`Searching ${resourceName} where ${criteria.join(' AND ')}`);
  }
}

/**
 * Log a "no results" message with 🕳️ emoji and contextual hint.
 */
function logNoResults(logger: Logger, resourceName: string, hasFilters: boolean): void {
  logger.info(`🕳️ No ${resourceName} found matching the criteria`);
  if (!hasFilters) {
    logger.info('No filters were applied. Use "c8ctl help search" to see available filter flags.');
  }
}

/**
 * Log the result count with a truncation warning when the count matches the API default page size.
 */
function logResultCount(logger: Logger, count: number, resourceName: string, hasFilters: boolean): void {
  logger.info(`Found ${count} ${resourceName}`);
  if (count === API_DEFAULT_PAGE_SIZE && !hasFilters) {
    logger.warn(`Showing first ${API_DEFAULT_PAGE_SIZE} results (API default page size). More results may exist — add filters to narrow down.`);
  } else if (count === API_DEFAULT_PAGE_SIZE) {
    logger.warn(`Result count equals the API default page size (${API_DEFAULT_PAGE_SIZE}). There may be more results.`);
  }
}

/**
 * Search process definitions
 */
export async function searchProcessDefinitions(options: {
  profile?: string;
  processDefinitionId?: string;
  name?: string;
  version?: number;
  key?: string;
  iProcessDefinitionId?: string;
  iName?: string;
  sortBy?: string;
  sortOrder?: SortOrder;
  _unknownFlags?: string[];
}): Promise<SearchResult | undefined> {
  const logger = getLogger();
  const client = createClient(options.profile);
  const tenantId = resolveTenantId(options.profile);
  const hasCiFilter = !!(options.iProcessDefinitionId || options.iName);

  // Build search criteria description for user feedback
  const criteria: string[] = [];
  if (options.processDefinitionId) {
    criteria.push(formatCriterion('Process Definition ID', options.processDefinitionId));
  }
  if (options.name) {
    criteria.push(formatCriterion('name', options.name));
  }
  if (options.version !== undefined) {
    criteria.push(formatCriterion('version', options.version));
  }
  if (options.key) {
    criteria.push(formatCriterion('key', options.key));
  }
  if (options.iProcessDefinitionId) {
    criteria.push(formatCriterion('Process Definition ID', options.iProcessDefinitionId, true));
  }
  if (options.iName) {
    criteria.push(formatCriterion('name', options.iName, true));
  }
  logSearchCriteria(logger, 'Process Definitions', criteria);

  try {
    const filter: any = {
      filter: {
        tenantId,
      },
    };

    if (hasCiFilter) filter.page = { limit: CI_PAGE_SIZE };

    if (options.processDefinitionId) {
      filter.filter.processDefinitionId = toStringFilter(options.processDefinitionId);
    }

    if (options.name) {
      filter.filter.name = toStringFilter(options.name);
    }

    if (options.version !== undefined) {
      filter.filter.version = options.version;
    }

    if (options.key) {
      filter.filter.processDefinitionKey = options.key;
    }

    const result = await client.searchProcessDefinitions(filter, { consistency: { waitUpToMs: 0 } });

    if (result.items?.length) {
      result.items = [...result.items].sort((left: any, right: any) => {
        const versionDelta = (Number(right.version) || 0) - (Number(left.version) || 0);
        if (versionDelta !== 0) return versionDelta;

        const leftKey = toBigIntSafe(left.processDefinitionKey ?? left.key);
        const rightKey = toBigIntSafe(right.processDefinitionKey ?? right.key);
        if (leftKey === rightKey) return 0;
        return rightKey > leftKey ? 1 : -1;
      });
    }

    // Client-side case-insensitive post-filtering
    if (hasCiFilter && result.items) {
      result.items = result.items.filter((pd: any) => {
        if (options.iProcessDefinitionId && !matchesCaseInsensitive(pd.processDefinitionId, options.iProcessDefinitionId)) return false;
        if (options.iName && !matchesCaseInsensitive(pd.name, options.iName)) return false;
        return true;
      });
    }
    
    if (result.items && result.items.length > 0) {
      let tableData = result.items.map((pd: any) => ({
        Key: pd.processDefinitionKey || pd.key,
        'Process ID': pd.processDefinitionId,
        Name: pd.name || '-',
        Version: pd.version,
        'Tenant ID': pd.tenantId,
      }));
      tableData = sortTableData(tableData, options.sortBy, logger, options.sortOrder);
      logger.table(tableData);
      logResultCount(logger, result.items.length, 'process definition(s)', criteria.length > 0);
    } else {
      logNoResults(logger, 'process definitions', criteria.length > 0, options._unknownFlags);
    }

    return result as SearchResult;
  } catch (error) {
    logger.error('Failed to search process definitions', error as Error);
    process.exit(1);
  }
}

/**
 * Search process instances
 */
export async function searchProcessInstances(options: {
  profile?: string;
  processDefinitionId?: string;
  processDefinitionKey?: string;
  state?: string;
  key?: string;
  parentProcessInstanceKey?: string;
  iProcessDefinitionId?: string;
  sortBy?: string;
  sortOrder?: SortOrder;
  _unknownFlags?: string[];
  between?: string;
  dateField?: string;
}): Promise<SearchResult | undefined> {
  const logger = getLogger();
  const client = createClient(options.profile);
  const tenantId = resolveTenantId(options.profile);
  const hasCiFilter = !!options.iProcessDefinitionId;

  // Build search criteria description for user feedback
  const criteria: string[] = [];
  if (options.processDefinitionId) {
    criteria.push(formatCriterion('Process Definition ID', options.processDefinitionId));
  }
  if (options.processDefinitionKey) {
    criteria.push(formatCriterion('Process Definition Key', options.processDefinitionKey));
  }
  if (options.state) {
    criteria.push(formatCriterion('state', options.state));
  }
  if (options.key) {
    criteria.push(formatCriterion('key', options.key));
  }
  if (options.parentProcessInstanceKey) {
    criteria.push(formatCriterion('Parent Process Instance Key', options.parentProcessInstanceKey));
  }
  if (options.iProcessDefinitionId) {
    criteria.push(formatCriterion('Process Definition ID', options.iProcessDefinitionId, true));
  }
  if (options.between) {
    const field = options.dateField ?? 'startDate';
    criteria.push(`'${field}' between "${options.between}"`);
  }
  logSearchCriteria(logger, 'Process Instances', criteria);

  try {
    const filter: any = {
      filter: {
        tenantId,
      },
    };

    if (hasCiFilter) filter.page = { limit: CI_PAGE_SIZE };

    if (options.processDefinitionId) {
      filter.filter.processDefinitionId = toStringFilter(options.processDefinitionId);
    }

    if (options.processDefinitionKey) {
      filter.filter.processDefinitionKey = options.processDefinitionKey;
    }

    if (options.state) {
      filter.filter.state = options.state;
    }

    if (options.key) {
      filter.filter.processInstanceKey = options.key;
    }

    if (options.parentProcessInstanceKey) {
      filter.filter.parentProcessInstanceKey = options.parentProcessInstanceKey;
    }

    if (options.between) {
      const parsed = parseBetween(options.between);
      if (parsed) {
        const field = options.dateField ?? 'startDate';
        filter.filter[field] = buildDateFilter(parsed.from, parsed.to);
      } else {
        logger.error('Invalid --between value. Expected format: <from>..<to> (e.g. 2024-01-01..2024-12-31 or ISO 8601 datetimes)');
        process.exit(1);
      }
    }

    const result = await client.searchProcessInstances(filter, { consistency: { waitUpToMs: 0 } });

    if (hasCiFilter && result.items) {
      result.items = result.items.filter((pi: any) => {
        if (options.iProcessDefinitionId && !matchesCaseInsensitive(pi.processDefinitionId, options.iProcessDefinitionId)) return false;
        return true;
      });
    }
    
    if (result.items && result.items.length > 0) {
      let tableData = result.items.map((pi: any) => ({
        Key: pi.processInstanceKey || pi.key,
        'Process ID': pi.processDefinitionId,
        State: pi.state,
        Version: pi.processDefinitionVersion || pi.version,
        'Tenant ID': pi.tenantId,
      }));
      tableData = sortTableData(tableData, options.sortBy, logger, options.sortOrder);
      logger.table(tableData);
      logResultCount(logger, result.items.length, 'process instance(s)', criteria.length > 0);
    } else {
      logNoResults(logger, 'process instances', criteria.length > 0, options._unknownFlags);
    }

    return result as SearchResult;
  } catch (error) {
    logger.error('Failed to search process instances', error as Error);
    process.exit(1);
  }
}

/**
 * Search user tasks
 */
export async function searchUserTasks(options: {
  profile?: string;
  state?: string;
  assignee?: string;
  processInstanceKey?: string;
  processDefinitionKey?: string;
  elementId?: string;
  iAssignee?: string;
  sortBy?: string;
  sortOrder?: SortOrder;
  _unknownFlags?: string[];
  between?: string;
  dateField?: string;
}): Promise<SearchResult | undefined> {
  const logger = getLogger();
  const client = createClient(options.profile);
  const tenantId = resolveTenantId(options.profile);
  const hasCiFilter = !!options.iAssignee;

  // Build search criteria description for user feedback
  const criteria: string[] = [];
  if (options.state) {
    criteria.push(formatCriterion('state', options.state));
  }
  if (options.assignee) {
    criteria.push(formatCriterion('assignee', options.assignee));
  }
  if (options.processInstanceKey) {
    criteria.push(formatCriterion('Process Instance Key', options.processInstanceKey));
  }
  if (options.processDefinitionKey) {
    criteria.push(formatCriterion('Process Definition Key', options.processDefinitionKey));
  }
  if (options.elementId) {
    criteria.push(formatCriterion('Element ID', options.elementId));
  }
  if (options.iAssignee) {
    criteria.push(formatCriterion('assignee', options.iAssignee, true));
  }
  if (options.between) {
    const field = options.dateField ?? 'creationDate';
    criteria.push(`'${field}' between "${options.between}"`);
  }
  logSearchCriteria(logger, 'User Tasks', criteria);

  try {
    const filter: any = {
      filter: {
        tenantId,
      },
    };

    if (hasCiFilter) filter.page = { limit: CI_PAGE_SIZE };

    if (options.state) {
      filter.filter.state = options.state;
    }

    if (options.assignee) {
      filter.filter.assignee = toStringFilter(options.assignee);
    }

    if (options.processInstanceKey) {
      filter.filter.processInstanceKey = options.processInstanceKey;
    }

    if (options.processDefinitionKey) {
      filter.filter.processDefinitionKey = options.processDefinitionKey;
    }

    if (options.elementId) {
      filter.filter.elementId = options.elementId;
    }

    if (options.between) {
      const parsed = parseBetween(options.between);
      if (parsed) {
        const field = options.dateField ?? 'creationDate';
        filter.filter[field] = buildDateFilter(parsed.from, parsed.to);
      } else {
        logger.error('Invalid --between value. Expected format: <from>..<to> (e.g. 2024-01-01..2024-12-31 or ISO 8601 datetimes)');
        process.exit(1);
      }
    }

    const result = await client.searchUserTasks(filter, { consistency: { waitUpToMs: 0 } });

    if (hasCiFilter && result.items) {
      result.items = result.items.filter((task: any) => {
        if (options.iAssignee && !matchesCaseInsensitive(task.assignee, options.iAssignee)) return false;
        return true;
      });
    }
    
    if (result.items && result.items.length > 0) {
      let tableData = result.items.map((task: any) => ({
        Key: task.userTaskKey || task.key,
        Name: task.name || task.elementId,
        State: task.state,
        Assignee: task.assignee || '(unassigned)',
        'Process Instance': task.processInstanceKey,
        'Tenant ID': task.tenantId,
      }));
      tableData = sortTableData(tableData, options.sortBy, logger, options.sortOrder);
      logger.table(tableData);
      logResultCount(logger, result.items.length, 'user task(s)', criteria.length > 0);
    } else {
      logNoResults(logger, 'user tasks', criteria.length > 0, options._unknownFlags);
    }

    return result as SearchResult;
  } catch (error) {
    logger.error('Failed to search user tasks', error as Error);
    process.exit(1);
  }
}

/**
 * Search incidents
 */
export async function searchIncidents(options: {
  profile?: string;
  state?: string;
  processInstanceKey?: string;
  processDefinitionKey?: string;
  processDefinitionId?: string;
  errorType?: string;
  errorMessage?: string;
  iErrorMessage?: string;
  iProcessDefinitionId?: string;
  sortBy?: string;
  sortOrder?: SortOrder;
  _unknownFlags?: string[];
  between?: string;
}): Promise<SearchResult | undefined> {
  const logger = getLogger();
  const client = createClient(options.profile);
  const tenantId = resolveTenantId(options.profile);
  // The incident API does not support a $like filter for errorMessage; fall back to client-side filtering for wildcard patterns
  const errorMessageHasWildcard = !!(options.errorMessage && hasUnescapedWildcard(options.errorMessage));
  const hasCiFilter = !!(options.iErrorMessage || options.iProcessDefinitionId || errorMessageHasWildcard);

  // Build search criteria description for user feedback
  const criteria: string[] = [];
  if (options.state) {
    criteria.push(formatCriterion('state', options.state));
  }
  if (options.processInstanceKey) {
    criteria.push(formatCriterion('Process Instance Key', options.processInstanceKey));
  }
  if (options.processDefinitionKey) {
    criteria.push(formatCriterion('Process Definition Key', options.processDefinitionKey));
  }
  if (options.errorType) {
    criteria.push(formatCriterion('Error Type', options.errorType));
  }
  if (options.errorMessage) {
    criteria.push(formatCriterion('Error Message', options.errorMessage));
  }
  if (options.processDefinitionId) {
    criteria.push(formatCriterion('Process Definition ID', options.processDefinitionId));
  }
  if (options.iErrorMessage) {
    criteria.push(formatCriterion('Error Message', options.iErrorMessage, true));
  }
  if (options.iProcessDefinitionId) {
    criteria.push(formatCriterion('Process Definition ID', options.iProcessDefinitionId, true));
  }
  if (options.between) {
    criteria.push(`'creationTime' between "${options.between}"`);
  }
  logSearchCriteria(logger, 'Incidents', criteria);

  try {
    const filter: any = {
      filter: {
        tenantId,
      },
    };

    if (hasCiFilter) filter.page = { limit: CI_PAGE_SIZE };

    if (options.state) {
      filter.filter.state = options.state;
    }

    if (options.processInstanceKey) {
      filter.filter.processInstanceKey = options.processInstanceKey;
    }

    if (options.processDefinitionKey) {
      filter.filter.processDefinitionKey = options.processDefinitionKey;
    }

    if (options.errorType) {
      filter.filter.errorType = options.errorType;
    }

    if (options.errorMessage && !errorMessageHasWildcard) {
      filter.filter.errorMessage = options.errorMessage;
    }

    if (options.processDefinitionId) {
      filter.filter.processDefinitionId = toStringFilter(options.processDefinitionId);
    }

    if (options.between) {
      const parsed = parseBetween(options.between);
      if (parsed) {
        filter.filter.creationTime = buildDateFilter(parsed.from, parsed.to);
      } else {
        logger.error('Invalid --between value. Expected format: <from>..<to> (e.g. 2024-01-01..2024-12-31 or ISO 8601 datetimes)');
        process.exit(1);
      }
    }

    const result = await client.searchIncidents(filter, { consistency: { waitUpToMs: 0 } });

    if (hasCiFilter && result.items) {
      result.items = result.items.filter((incident: any) => {
        if (options.iErrorMessage && !matchesCaseInsensitive(incident.errorMessage, options.iErrorMessage)) return false;
        if (options.iProcessDefinitionId && !matchesCaseInsensitive(incident.processDefinitionId, options.iProcessDefinitionId)) return false;
        if (errorMessageHasWildcard && options.errorMessage && !matchesCaseSensitive(incident.errorMessage, options.errorMessage)) return false;
        return true;
      });
    }
    
    if (result.items && result.items.length > 0) {
      let tableData = result.items.map((incident: any) => ({
        Key: incident.incidentKey || incident.key,
        Type: incident.errorType,
        Message: incident.errorMessage?.substring(0, 50) || '',
        State: incident.state,
        'Process Instance': incident.processInstanceKey,
        'Tenant ID': incident.tenantId,
      }));
      tableData = sortTableData(tableData, options.sortBy, logger, options.sortOrder);
      logger.table(tableData);
      logResultCount(logger, result.items.length, 'incident(s)', criteria.length > 0);
    } else {
      logNoResults(logger, 'incidents', criteria.length > 0, options._unknownFlags);
    }

    return result as SearchResult;
  } catch (error) {
    logger.error('Failed to search incidents', error as Error);
    process.exit(1);
  }
}

/**
 * Search jobs
 */
export async function searchJobs(options: {
  profile?: string;
  state?: string;
  type?: string;
  processInstanceKey?: string;
  processDefinitionKey?: string;
  iType?: string;
  sortBy?: string;
  sortOrder?: SortOrder;
  _unknownFlags?: string[];
  between?: string;
  dateField?: string;
}): Promise<SearchResult | undefined> {
  const logger = getLogger();
  const client = createClient(options.profile);
  const tenantId = resolveTenantId(options.profile);
  const hasCiFilter = !!options.iType;

  // Build search criteria description for user feedback
  const criteria: string[] = [];
  if (options.state) {
    criteria.push(formatCriterion('state', options.state));
  }
  if (options.type) {
    criteria.push(formatCriterion('type', options.type));
  }
  if (options.processInstanceKey) {
    criteria.push(formatCriterion('Process Instance Key', options.processInstanceKey));
  }
  if (options.processDefinitionKey) {
    criteria.push(formatCriterion('Process Definition Key', options.processDefinitionKey));
  }
  if (options.iType) {
    criteria.push(formatCriterion('type', options.iType, true));
  }
  if (options.between) {
    const field = options.dateField ?? 'creationTime';
    criteria.push(`'${field}' between "${options.between}"`);
  }
  logSearchCriteria(logger, 'Jobs', criteria);

  try {
    const filter: any = {
      filter: {
        tenantId,
      },
    };

    if (hasCiFilter) filter.page = { limit: CI_PAGE_SIZE };

    if (options.state) {
      filter.filter.state = options.state;
    }

    if (options.type) {
      filter.filter.type = toStringFilter(options.type);
    }

    if (options.processInstanceKey) {
      filter.filter.processInstanceKey = options.processInstanceKey;
    }

    if (options.processDefinitionKey) {
      filter.filter.processDefinitionKey = options.processDefinitionKey;
    }

    if (options.between) {
      const parsed = parseBetween(options.between);
      if (parsed) {
        const field = options.dateField ?? 'creationTime';
        filter.filter[field] = buildDateFilter(parsed.from, parsed.to);
      } else {
        logger.error('Invalid --between value. Expected format: <from>..<to> (e.g. 2024-01-01..2024-12-31 or ISO 8601 datetimes)');
        process.exit(1);
      }
    }

    const result = await client.searchJobs(filter, { consistency: { waitUpToMs: 0 } });

    if (hasCiFilter && result.items) {
      result.items = result.items.filter((job: any) => {
        if (options.iType && !matchesCaseInsensitive(job.type, options.iType)) return false;
        return true;
      });
    }
    
    if (result.items && result.items.length > 0) {
      let tableData = result.items.map((job: any) => ({
        Key: job.jobKey || job.key,
        Type: job.type,
        State: job.state,
        Retries: job.retries,
        'Process Instance': job.processInstanceKey,
        'Tenant ID': job.tenantId,
      }));
      tableData = sortTableData(tableData, options.sortBy, logger, options.sortOrder);
      logger.table(tableData);
      logResultCount(logger, result.items.length, 'job(s)', criteria.length > 0);
    } else {
      logNoResults(logger, 'jobs', criteria.length > 0, options._unknownFlags);
    }

    return result as SearchResult;
  } catch (error) {
    logger.error('Failed to search jobs', error as Error);
    process.exit(1);
  }
}

/**
 * Search variables
 */
export async function searchVariables(options: {
  profile?: string;
  name?: string;
  value?: string;
  processInstanceKey?: string;
  scopeKey?: string;
  fullValue?: boolean;
  iName?: string;
  iValue?: string;
  sortBy?: string;
  sortOrder?: SortOrder;
  limit?: number;
  _unknownFlags?: string[];
}): Promise<SearchResult | undefined> {
  const logger = getLogger();
  const client = createClient(options.profile);
  const tenantId = resolveTenantId(options.profile);
  const hasCiFilter = !!(options.iName || options.iValue);

  // Build search criteria description for user feedback
  const criteria: string[] = [];
  if (options.name) {
    criteria.push(formatCriterion('name', options.name));
  }
  if (options.value) {
    criteria.push(formatCriterion('value', options.value));
  }
  if (options.processInstanceKey) {
    criteria.push(formatCriterion('Process Instance Key', options.processInstanceKey));
  }
  if (options.scopeKey) {
    criteria.push(formatCriterion('Scope Key', options.scopeKey));
  }
  if (options.iName) {
    criteria.push(formatCriterion('name', options.iName, true));
  }
  if (options.iValue) {
    criteria.push(formatCriterion('value', options.iValue, true));
  }
  if (options.fullValue) {
    criteria.push(formatCriterion('fullValue', true));
  }
  logSearchCriteria(logger, 'Variables', criteria);

  try {
    const filter: any = {
      filter: {
        tenantId,
      },
    };

    if (hasCiFilter) filter.page = { limit: CI_PAGE_SIZE };

    if (options.name) {
      filter.filter.name = toStringFilter(options.name);
    }

    if (options.value) {
      filter.filter.value = toStringFilter(options.value);
    }

    if (options.processInstanceKey) {
      filter.filter.processInstanceKey = options.processInstanceKey;
    }

    if (options.scopeKey) {
      filter.filter.scopeKey = options.scopeKey;
    }

    // By default, truncate values unless --fullValue is specified
    const truncateValues = !options.fullValue;

    const allItems = hasCiFilter
      ? await fetchAllPages(
          (f, opts) => client.searchVariables({ ...f, truncateValues }, opts),
          filter,
          CI_PAGE_SIZE,
          options.limit,
        )
      : (await client.searchVariables(
          { ...filter, truncateValues },
          { consistency: { waitUpToMs: 0 } },
        )).items || [];

    let result = { items: allItems } as any;

    if (hasCiFilter && result.items) {
      result.items = result.items.filter((variable: any) => {
        if (options.iName && !matchesCaseInsensitive(variable.name, options.iName)) return false;
        if (options.iValue) {
          // Variable values come JSON-encoded from the API (e.g., '"PendingReview"').
          // Unwrap the JSON string for comparison so users can match the actual value.
          let rawValue = variable.value;
          try {
            const parsed = JSON.parse(rawValue);
            if (typeof parsed === 'string') rawValue = parsed;
          } catch { /* keep original value */ }
          if (!matchesCaseInsensitive(rawValue, options.iValue)) return false;
        }
        return true;
      });
    }
    
    if (result.items && result.items.length > 0) {
      let tableData = result.items.map((variable: any) => {
        const row: any = {
          Name: variable.name,
          Value: variable.value || '',
          'Process Instance': variable.processInstanceKey,
          'Scope Key': variable.scopeKey,
          'Tenant ID': variable.tenantId,
        };
        
        if (variable.isTruncated) {
          row['Truncated'] = '✓';
        }
        
        return row;
      });
      tableData = sortTableData(tableData, options.sortBy, logger, options.sortOrder);
      logger.table(tableData);
      logResultCount(logger, result.items.length, 'variable(s)', criteria.length > 0);
      
      if (!options.fullValue && result.items.some((v: any) => v.isTruncated)) {
        logger.info('Some values are truncated. Use --fullValue to see full values.');
      }
    } else {
      logNoResults(logger, 'variables', criteria.length > 0, options._unknownFlags);
    }

    return result as SearchResult;
  } catch (error) {
    logger.error('Failed to search variables', error as Error);
    process.exit(1);
  }
}
