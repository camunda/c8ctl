/**
 * Search commands
 */

import { getLogger } from '../logger.ts';
import { createClient } from '../client.ts';
import { resolveTenantId } from '../config.ts';
import { c8ctl } from '../runtime.ts';

export type SearchResult = { items: Array<Record<string, unknown>>; total?: number };

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
export const wildcardToRegex = (pattern: string): RegExp => {
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
  return new RegExp(`^${regex}$`, 'i');
};

/**
 * Test if a value matches a wildcard pattern case-insensitively.
 * Without wildcards, performs exact case-insensitive match.
 */
export const matchesCaseInsensitive = (value: string | undefined | null, pattern: string): boolean => {
  if (value == null) return false;
  return wildcardToRegex(pattern).test(value);
};

/** Max page size for case-insensitive search (client-side filtering needs broader result set) */
const CI_PAGE_SIZE = 1000;

/**
 * Build a human-readable description of a filter criterion.
 * 
 * NOTE: This function outputs to console.log (not the logger class) because
 * these messages provide UX feedback about the search criteria and are not
 * part of the structured text/JSON output.
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
 * Log search criteria to console for better developer experience.
 * 
 * NOTE: Uses console.log directly (not the logger class) because these messages
 * are UX feedback about the search. In JSON mode, outputs proper JSON for Unix pipe compatibility.
 * 
 * @param resourceName - Human-readable name of the resource type being searched
 * @param criteria - Array of criterion strings describing the filters
 */
function logSearchCriteria(resourceName: string, criteria: string[]): void {
  const mode = c8ctl.outputMode;
  
  if (mode === 'json') {
    // Output JSON for pipe-ability to tools like jq
    const output = {
      action: 'search',
      resource: resourceName,
      criteria: criteria.length > 0 ? criteria : undefined
    };
    console.log(JSON.stringify(output));
  } else {
    // Text mode output for human readability
    if (criteria.length === 0) {
      console.log(`Searching ${resourceName}`);
    } else if (criteria.length === 1) {
      console.log(`Searching ${resourceName} where ${criteria[0]}`);
    } else {
      console.log(`Searching ${resourceName} where ${criteria.join(' AND ')}`);
    }
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
  logSearchCriteria('Process Definitions', criteria);

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

    // Client-side case-insensitive post-filtering
    if (hasCiFilter && result.items) {
      result.items = result.items.filter((pd: any) => {
        if (options.iProcessDefinitionId && !matchesCaseInsensitive(pd.processDefinitionId, options.iProcessDefinitionId)) return false;
        if (options.iName && !matchesCaseInsensitive(pd.name, options.iName)) return false;
        return true;
      });
    }
    
    if (result.items && result.items.length > 0) {
      const tableData = result.items.map((pd: any) => ({
        Key: pd.processDefinitionKey || pd.key,
        'Process ID': pd.processDefinitionId,
        Name: pd.name || '-',
        Version: pd.version,
        'Tenant ID': pd.tenantId,
      }));
      logger.table(tableData);
      logger.info(`Found ${result.items.length} process definition(s)`);
    } else {
      logger.info('No process definitions found matching the criteria');
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
  logSearchCriteria('Process Instances', criteria);

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

    const result = await client.searchProcessInstances(filter, { consistency: { waitUpToMs: 0 } });

    if (hasCiFilter && result.items) {
      result.items = result.items.filter((pi: any) => {
        if (options.iProcessDefinitionId && !matchesCaseInsensitive(pi.processDefinitionId, options.iProcessDefinitionId)) return false;
        return true;
      });
    }
    
    if (result.items && result.items.length > 0) {
      const tableData = result.items.map((pi: any) => ({
        Key: pi.processInstanceKey || pi.key,
        'Process ID': pi.processDefinitionId,
        State: pi.state,
        Version: pi.processDefinitionVersion || pi.version,
        'Tenant ID': pi.tenantId,
      }));
      logger.table(tableData);
      logger.info(`Found ${result.items.length} process instance(s)`);
    } else {
      logger.info('No process instances found matching the criteria');
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
  logSearchCriteria('User Tasks', criteria);

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

    const result = await client.searchUserTasks(filter, { consistency: { waitUpToMs: 0 } });

    if (hasCiFilter && result.items) {
      result.items = result.items.filter((task: any) => {
        if (options.iAssignee && !matchesCaseInsensitive(task.assignee, options.iAssignee)) return false;
        return true;
      });
    }
    
    if (result.items && result.items.length > 0) {
      const tableData = result.items.map((task: any) => ({
        Key: task.userTaskKey || task.key,
        Name: task.name || task.elementId,
        State: task.state,
        Assignee: task.assignee || '(unassigned)',
        'Process Instance': task.processInstanceKey,
        'Tenant ID': task.tenantId,
      }));
      logger.table(tableData);
      logger.info(`Found ${result.items.length} user task(s)`);
    } else {
      logger.info('No user tasks found matching the criteria');
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
}): Promise<SearchResult | undefined> {
  const logger = getLogger();
  const client = createClient(options.profile);
  const tenantId = resolveTenantId(options.profile);
  const hasCiFilter = !!(options.iErrorMessage || options.iProcessDefinitionId);

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
  logSearchCriteria('Incidents', criteria);

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

    if (options.errorMessage) {
      filter.filter.errorMessage = toStringFilter(options.errorMessage);
    }

    if (options.processDefinitionId) {
      filter.filter.processDefinitionId = toStringFilter(options.processDefinitionId);
    }

    const result = await client.searchIncidents(filter, { consistency: { waitUpToMs: 0 } });

    if (hasCiFilter && result.items) {
      result.items = result.items.filter((incident: any) => {
        if (options.iErrorMessage && !matchesCaseInsensitive(incident.errorMessage, options.iErrorMessage)) return false;
        if (options.iProcessDefinitionId && !matchesCaseInsensitive(incident.processDefinitionId, options.iProcessDefinitionId)) return false;
        return true;
      });
    }
    
    if (result.items && result.items.length > 0) {
      const tableData = result.items.map((incident: any) => ({
        Key: incident.incidentKey || incident.key,
        Type: incident.errorType,
        Message: incident.errorMessage?.substring(0, 50) || '',
        State: incident.state,
        'Process Instance': incident.processInstanceKey,
        'Tenant ID': incident.tenantId,
      }));
      logger.table(tableData);
      logger.info(`Found ${result.items.length} incident(s)`);
    } else {
      logger.info('No incidents found matching the criteria');
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
  logSearchCriteria('Jobs', criteria);

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

    const result = await client.searchJobs(filter, { consistency: { waitUpToMs: 0 } });

    if (hasCiFilter && result.items) {
      result.items = result.items.filter((job: any) => {
        if (options.iType && !matchesCaseInsensitive(job.type, options.iType)) return false;
        return true;
      });
    }
    
    if (result.items && result.items.length > 0) {
      const tableData = result.items.map((job: any) => ({
        Key: job.jobKey || job.key,
        Type: job.type,
        State: job.state,
        Retries: job.retries,
        'Process Instance': job.processInstanceKey,
        'Tenant ID': job.tenantId,
      }));
      logger.table(tableData);
      logger.info(`Found ${result.items.length} job(s)`);
    } else {
      logger.info('No jobs found matching the criteria');
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
  logSearchCriteria('Variables', criteria);

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

    const result = await client.searchVariables(
      { ...filter, truncateValues }, 
      { consistency: { waitUpToMs: 0 } }
    );

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
      const tableData = result.items.map((variable: any) => {
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
      logger.table(tableData);
      logger.info(`Found ${result.items.length} variable(s)`);
      
      if (!options.fullValue && result.items.some((v: any) => v.isTruncated)) {
        logger.info('Some values are truncated. Use --fullValue to see full values.');
      }
    } else {
      logger.info('No variables found matching the criteria');
    }

    return result as SearchResult;
  } catch (error) {
    logger.error('Failed to search variables', error as Error);
    process.exit(1);
  }
}
