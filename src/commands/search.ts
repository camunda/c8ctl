/**
 * Search commands
 */

import { getLogger } from '../logger.ts';
import { createClient } from '../client.ts';
import { resolveTenantId } from '../config.ts';

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
