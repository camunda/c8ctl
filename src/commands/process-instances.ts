/**
 * Process instance commands
 */

import { getLogger } from '../logger.ts';
import { createClient } from '../client.ts';
import { resolveTenantId } from '../config.ts';

/**
 * List process instances
 */
export async function listProcessInstances(options: {
  profile?: string;
  processDefinitionId?: string;
  state?: string;
  all?: boolean;
}): Promise<void> {
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
}): Promise<void> {
  const logger = getLogger();
  const client = createClient(options.profile);

  try {
    const result = await client.getProcessInstance({ processInstanceKey: key as any }, { consistency: { waitUpToMs: 0 } });
    logger.json(result);
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
  fetchVariables?: string;
}): Promise<void> {
  const logger = getLogger();
  const client = createClient(options.profile);
  const tenantId = resolveTenantId(options.profile);

  if (!options.processDefinitionId) {
    logger.error('processDefinitionId is required. Use --processDefinitionId flag');
    process.exit(1);
  }

  // Validate: fetchVariables requires awaitCompletion
  if (options.fetchVariables && !options.awaitCompletion) {
    logger.error('--fetchVariables can only be used with --awaitCompletion');
    process.exit(1);
  }

  try {
    const request: any = {
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

    const result = await client.createProcessInstance(request);
    logger.success('Process instance created', result.processInstanceKey);
    
    // If awaitCompletion is enabled, wait for the process to complete
    if (options.awaitCompletion) {
      await awaitProcessInstance(result.processInstanceKey.toString(), {
        profile: options.profile,
        fetchVariables: options.fetchVariables,
      });
    }
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

/**
 * Poll until condition is met with timeout
 * @param checkCondition - Function that returns true when condition is met, or throws error to fail
 * @param maxDuration - Maximum time to poll in milliseconds
 * @param interval - Polling interval in milliseconds
 * @returns Promise that resolves when condition is met, rejects on timeout
 */
async function pollUntilCondition(
  checkCondition: () => Promise<boolean>,
  maxDuration: number,
  interval: number
): Promise<void> {
  const startTime = Date.now();
  const maxAttempts = Math.ceil(maxDuration / interval);
  
  const attemptPoll = async (attemptNumber: number): Promise<void> => {
    const elapsedTime = Date.now() - startTime;
    
    // Check timeout
    if (attemptNumber >= maxAttempts || elapsedTime >= maxDuration) {
      throw new Error(`Timeout after ${elapsedTime}ms`);
    }
    
    try {
      // Check if condition is met
      const conditionMet = await checkCondition();
      if (conditionMet) {
        return; // Success!
      }
    } catch (error) {
      // If checkCondition throws, propagate the error
      throw error;
    }
    
    // Wait before next attempt
    await new Promise(resolve => setTimeout(resolve, interval));
    return attemptPoll(attemptNumber + 1);
  };
  
  return attemptPoll(0);
}

/**
 * Await process instance completion
 * Polls the process instance until it reaches a terminal state (COMPLETED, CANCELED, or has an incident)
 */
export async function awaitProcessInstance(key: string, options: {
  profile?: string;
  fetchVariables?: string;  // Reserved for future use - API currently returns all variables
  timeout?: number;
  pollInterval?: number;
}): Promise<void> {
  const logger = getLogger();
  const client = createClient(options.profile);
  
  // Default timeout: 5 minutes
  const timeout = options.timeout ?? 300000;
  // Default poll interval: 500ms
  const pollInterval = options.pollInterval ?? 500;
  
  // Note: fetchVariables parameter is reserved for future API enhancement
  // The orchestration-cluster-api currently does not support filtering variables
  // The API returns all variables by default when fetching a process instance
  if (options.fetchVariables) {
    logger.warn('--fetchVariables is not yet supported by the API. All variables will be returned.');
  }
  
  logger.info(`Waiting for process instance ${key} to complete...`);
  
  let finalResult: any = null;
  
  try {
    await pollUntilCondition(async () => {
      try {
        const result = await client.getProcessInstance(
          { processInstanceKey: key as any },
          { consistency: { waitUpToMs: 0 } }
        );
        
        // Check if process instance is in a terminal state
        const state = result.state;
        if (state === 'COMPLETED' || state === 'CANCELED') {
          finalResult = result;
          return true; // Condition met!
        }
        
        // Check if there's an incident (error state)
        if (result.hasIncident) {
          logger.error(`Process instance ${key} has an incident`);
          logger.json(result);
          process.exit(1);
        }
        
        return false; // Not yet complete, continue polling
      } catch (error: unknown) {
        // If instance not found, it might have been deleted
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (errorMessage?.includes('404') || errorMessage?.includes('not found')) {
          throw new Error(`Process instance ${key} not found`);
        }
        // Continue polling on other errors
        return false;
      }
    }, timeout, pollInterval);
    
    // Success - process completed
    if (finalResult) {
      logger.success(`Process instance ${key} ${finalResult.state.toLowerCase()}`);
      logger.json(finalResult);
    }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (errorMessage.includes('Timeout')) {
      logger.error(`Timeout waiting for process instance ${key} to complete after ${timeout}ms`);
    } else {
      logger.error(`Failed to await process instance ${key}: ${errorMessage}`);
    }
    process.exit(1);
  }
}
