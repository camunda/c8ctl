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
 * Await process instance completion
 * Polls the process instance until it reaches a terminal state (COMPLETED, CANCELED, or has an incident)
 */
export async function awaitProcessInstance(key: string, options: {
  profile?: string;
  fetchVariables?: string;
  timeout?: number;
  pollInterval?: number;
}): Promise<void> {
  const logger = getLogger();
  const client = createClient(options.profile);
  
  // Default timeout: 5 minutes
  const timeout = options.timeout ?? 300000;
  // Default poll interval: 500ms
  const pollInterval = options.pollInterval ?? 500;
  
  const startTime = Date.now();
  
  logger.info(`Waiting for process instance ${key} to complete...`);
  
  try {
    while (true) {
      const elapsedTime = Date.now() - startTime;
      
      if (elapsedTime >= timeout) {
        logger.error(`Timeout waiting for process instance ${key} to complete after ${timeout}ms`);
        process.exit(1);
      }
      
      try {
        const result = await client.getProcessInstance(
          { processInstanceKey: key as any },
          { consistency: { waitUpToMs: 0 } }
        );
        
        // Check if process instance is in a terminal state
        const state = result.state;
        if (state === 'COMPLETED' || state === 'CANCELED') {
          logger.success(`Process instance ${key} ${state.toLowerCase()}`);
          
          // Always return full result with variables when awaiting
          logger.json(result);
          return;
        }
        
        // Check if there's an incident (error state)
        if (result.hasIncident) {
          logger.error(`Process instance ${key} has an incident`);
          logger.json(result);
          process.exit(1);
        }
      } catch (error: unknown) {
        // If instance not found, it might have been deleted
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (errorMessage?.includes('404') || errorMessage?.includes('not found')) {
          logger.error(`Process instance ${key} not found`);
          process.exit(1);
        }
        // Continue polling on other errors
      }
      
      // Wait before next poll
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }
  } catch (error) {
    logger.error(`Failed to await process instance ${key}`, error as Error);
    process.exit(1);
  }
}
