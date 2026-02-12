/**
 * Search commands
 */

import { getLogger } from '../logger.ts';
import { createClient } from '../client.ts';
import { resolveTenantId } from '../config.ts';

export type SearchResult = { items: Array<Record<string, unknown>>; total?: number };

/**
 * Search process definitions
 */
export async function searchProcessDefinitions(options: {
  profile?: string;
  processDefinitionId?: string;
  name?: string;
  version?: number;
  key?: string;
}): Promise<SearchResult | undefined> {
  const logger = getLogger();
  const client = createClient(options.profile);
  const tenantId = resolveTenantId(options.profile);

  try {
    const filter: any = {
      filter: {
        tenantId,
      },
    };

    if (options.processDefinitionId) {
      filter.filter.processDefinitionId = options.processDefinitionId;
    }

    if (options.name) {
      filter.filter.name = options.name;
    }

    if (options.version !== undefined) {
      filter.filter.version = options.version;
    }

    if (options.key) {
      filter.filter.processDefinitionKey = options.key;
    }

    const result = await client.searchProcessDefinitions(filter, { consistency: { waitUpToMs: 0 } });
    
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
}): Promise<SearchResult | undefined> {
  const logger = getLogger();
  const client = createClient(options.profile);
  const tenantId = resolveTenantId(options.profile);

  try {
    const filter: any = {
      filter: {
        tenantId,
      },
    };

    if (options.processDefinitionId) {
      filter.filter.processDefinitionId = options.processDefinitionId;
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
}): Promise<SearchResult | undefined> {
  const logger = getLogger();
  const client = createClient(options.profile);
  const tenantId = resolveTenantId(options.profile);

  try {
    const filter: any = {
      filter: {
        tenantId,
      },
    };

    if (options.state) {
      filter.filter.state = options.state;
    }

    if (options.assignee) {
      filter.filter.assignee = options.assignee;
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
  errorType?: string;
}): Promise<SearchResult | undefined> {
  const logger = getLogger();
  const client = createClient(options.profile);
  const tenantId = resolveTenantId(options.profile);

  try {
    const filter: any = {
      filter: {
        tenantId,
      },
    };

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

    const result = await client.searchIncidents(filter, { consistency: { waitUpToMs: 0 } });
    
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
}): Promise<SearchResult | undefined> {
  const logger = getLogger();
  const client = createClient(options.profile);
  const tenantId = resolveTenantId(options.profile);

  try {
    const filter: any = {
      filter: {
        tenantId,
      },
    };

    if (options.state) {
      filter.filter.state = options.state;
    }

    if (options.type) {
      filter.filter.type = options.type;
    }

    if (options.processInstanceKey) {
      filter.filter.processInstanceKey = options.processInstanceKey;
    }

    if (options.processDefinitionKey) {
      filter.filter.processDefinitionKey = options.processDefinitionKey;
    }

    const result = await client.searchJobs(filter, { consistency: { waitUpToMs: 0 } });
    
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
}): Promise<SearchResult | undefined> {
  const logger = getLogger();
  const client = createClient(options.profile);
  const tenantId = resolveTenantId(options.profile);

  try {
    const filter: any = {
      filter: {
        tenantId,
      },
    };

    if (options.name) {
      filter.filter.name = options.name;
    }

    if (options.value) {
      filter.filter.value = options.value;
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
