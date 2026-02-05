/**
 * Process instance commands
 */

import { getLogger } from '../logger.ts';
import { createClient } from '../client.ts';
import { resolveTenantId } from '../config.ts';
import type { ProcessInstanceCreationInstructionById } from '@camunda8/orchestration-cluster-api';

/**
 * List process instances
 */
export async function listProcessInstances(options: {
  profile?: string;
  processDefinitionId?: string;
  state?: string;
  all?: boolean;
}): Promise<{ items: Array<Record<string, unknown>>; total?: number } | undefined> {
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

    if (options.state) {
      filter.filter.state = options.state;
    } else if (!options.all) {
      // By default, exclude COMPLETED instances unless --all is specified
      filter.filter.state = 'ACTIVE';
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
    } else {
      logger.info('No process instances found');
    }
    
    return result as { items: Array<Record<string, unknown>>; total?: number };
  } catch (error) {
    logger.error('Failed to list process instances', error as Error);
    process.exit(1);
  }
}

/**
 * Get process instance by key
 */
export async function getProcessInstance(key: string, options: {
  profile?: string;
  variables?: boolean;
}): Promise<void> {
  const logger = getLogger();
  const client = createClient(options.profile);
  const consistencyOptions = { consistency: { waitUpToMs: 0 } };

  try {
    const result = await client.getProcessInstance({ processInstanceKey: key as any }, consistencyOptions);
    
    // Fetch variables if requested
    if (options.variables) {
      try {
        const variablesResult = await client.searchVariables(
          {
            filter: {
              processInstanceKey: key as any,
            },
            truncateValues: false,  // Get full variable values
          },
          consistencyOptions
        );
        
        // Add variables to the result
        const resultWithVariables = {
          ...result,
          variables: variablesResult.items || [],
        };
        logger.json(resultWithVariables);
      } catch (varError) {
        logger.error(`Failed to fetch variables for process instance ${key}. The process instance was found, but variables could not be retrieved.`, varError as Error);
        process.exit(1);
      }
    } else {
      logger.json(result);
    }
  } catch (error) {
    logger.error(`Failed to get process instance ${key}`, error as Error);
    process.exit(1);
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
}): Promise<{
  processInstanceKey: string | number;
  variables?: Record<string, unknown>;
  [key: string]: unknown;
} | undefined> {
  const logger = getLogger();
  const client = createClient(options.profile);
  const tenantId = resolveTenantId(options.profile);

  if (!options.processDefinitionId) {
    logger.error('processDefinitionId is required. Use --processDefinitionId or --bpmnProcessId or --id flag');
    process.exit(1);
  }

  // Validate: fetchVariables requires awaitCompletion
  if (options.fetchVariables && !options.awaitCompletion) {
    logger.error('--fetchVariables can only be used with --awaitCompletion');
    process.exit(1);
  }

  // Note: fetchVariables parameter is reserved for future API enhancement
  // The orchestration-cluster-api currently does not support filtering variables
  // The API returns all variables by default when awaitCompletion is true
  if (options.fetchVariables) {
    logger.info('Note: --fetchVariables is not yet supported by the API. All variables will be returned.');
  }

  try {
    // Build the request matching ProcessInstanceCreationInstructionById type
    const request: {
      processDefinitionId: string;
      tenantId: string;
      processDefinitionVersion?: number;
      variables?: Record<string, unknown>;
      awaitCompletion?: boolean;
    } = {
      processDefinitionId: options.processDefinitionId,
      tenantId,
    };

    if (options.version !== undefined) {
      request.processDefinitionVersion = options.version;
    }

    if (options.variables) {
      try {
        request.variables = JSON.parse(options.variables);
      } catch (error) {
        logger.error('Invalid JSON for variables', error as Error);
        process.exit(1);
      }
    }

    // Use the API's built-in awaitCompletion parameter
    if (options.awaitCompletion) {
      request.awaitCompletion = true;
      logger.info('Waiting for process instance to complete...');
    }

    const result = await client.createProcessInstance(request as unknown as ProcessInstanceCreationInstructionById);
    
    if (options.awaitCompletion) {
      // When awaitCompletion is true, the API returns the completed process instance with variables
      logger.success('Process instance completed', result.processInstanceKey);
      logger.json(result);
    } else {
      // When awaitCompletion is false, just show the process instance key
      logger.success('Process instance created', result.processInstanceKey);
    }
    
    return result as {
      processInstanceKey: string | number;
      variables?: Record<string, unknown>;
      [key: string]: unknown;
    };
  } catch (error) {
    logger.error('Failed to create process instance', error as Error);
    process.exit(1);
  }
}

/**
 * Cancel process instance
 */
export async function cancelProcessInstance(key: string, options: {
  profile?: string;
}): Promise<void> {
  const logger = getLogger();
  const client = createClient(options.profile);

  try {
    await client.cancelProcessInstance({ processInstanceKey: key as any });
    logger.success(`Process instance ${key} cancelled`);
  } catch (error) {
    logger.error(`Failed to cancel process instance ${key}`, error as Error);
    process.exit(1);
  }
}
