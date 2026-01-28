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
  bpmnProcessId?: string;
  state?: string;
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

    if (options.bpmnProcessId) {
      filter.filter.bpmnProcessId = options.bpmnProcessId;
    }

    if (options.state) {
      filter.filter.state = options.state;
    }

    const result = await client.processInstances.search(filter);
    
    if (result.items && result.items.length > 0) {
      const tableData = result.items.map((pi: any) => ({
        Key: pi.processInstanceKey || pi.key,
        'Process ID': pi.bpmnProcessId,
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
    const result = await client.processInstances.getByKey(key);
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
  bpmnProcessId?: string;
  version?: number;
  variables?: string;
}): Promise<void> {
  const logger = getLogger();
  const client = createClient(options.profile);
  const tenantId = resolveTenantId(options.profile);

  if (!options.bpmnProcessId) {
    logger.error('bpmnProcessId is required. Use --bpmnProcessId flag');
    process.exit(1);
  }

  try {
    const request: any = {
      bpmnProcessId: options.bpmnProcessId,
      tenantId,
    };

    if (options.version !== undefined) {
      request.version = options.version;
    }

    if (options.variables) {
      try {
        request.variables = JSON.parse(options.variables);
      } catch (error) {
        logger.error('Invalid JSON for variables', error as Error);
        process.exit(1);
      }
    }

    const result = await client.processInstances.create(request);
    logger.success('Process instance created', result.processInstanceKey);
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
    await client.processInstances.cancel(key);
    logger.success(`Process instance ${key} cancelled`);
  } catch (error) {
    logger.error(`Failed to cancel process instance ${key}`, error as Error);
    process.exit(1);
  }
}
