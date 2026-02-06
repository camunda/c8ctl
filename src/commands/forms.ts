/**
 * Form commands
 */

import { getLogger } from '../logger.ts';
import { createClient } from '../client.ts';

/**
 * Get form for a user task
 */
export async function getUserTaskForm(userTaskKey: string, options: {
  profile?: string;
}): Promise<void> {
  const logger = getLogger();
  const client = createClient(options.profile);

  try {
    const result = await client.getUserTaskForm(
      { userTaskKey: userTaskKey as any },
      { consistency: { waitUpToMs: 0 } }
    );
    logger.json(result);
  } catch (error: any) {
    // Handle 204 No Content (user task exists but has no form)
    if (error.statusCode === 204 || error.status === 204) {
      logger.info('User task found but has no associated form');
      return;
    }
    logger.error(`Failed to get form for user task ${userTaskKey}`, error as Error);
    process.exit(1);
  }
}

/**
 * Get start form for a process definition
 */
export async function getStartForm(processDefinitionKey: string, options: {
  profile?: string;
}): Promise<void> {
  const logger = getLogger();
  const client = createClient(options.profile);

  try {
    const result = await client.getStartProcessForm(
      { processDefinitionKey: processDefinitionKey as any },
      { consistency: { waitUpToMs: 0 } }
    );
    logger.json(result);
  } catch (error: any) {
    // Handle 204 No Content (process definition exists but has no form)
    if (error.statusCode === 204 || error.status === 204) {
      logger.info('Process definition found but has no associated start form');
      return;
    }
    logger.error(`Failed to get start form for process definition ${processDefinitionKey}`, error as Error);
    process.exit(1);
  }
}

/**
 * Get form by trying both user task and process definition APIs
 */
export async function getForm(key: string, options: {
  profile?: string;
}): Promise<void> {
  const logger = getLogger();
  const client = createClient(options.profile);

  const results: { type: string; form: any }[] = [];
  const errors: { type: string; error: any }[] = [];

  // Try user task form
  try {
    const result = await client.getUserTaskForm(
      { userTaskKey: key as any },
      { consistency: { waitUpToMs: 0 } }
    );
    results.push({ type: 'user task', form: result });
  } catch (error: any) {
    // 204 means resource exists but no form - not an error
    if (error.statusCode !== 204 && error.status !== 204) {
      errors.push({ type: 'user task', error });
    }
  }

  // Try process definition form
  try {
    const result = await client.getStartProcessForm(
      { processDefinitionKey: key as any },
      { consistency: { waitUpToMs: 0 } }
    );
    results.push({ type: 'process definition', form: result });
  } catch (error: any) {
    // 204 means resource exists but no form - not an error
    if (error.statusCode !== 204 && error.status !== 204) {
      errors.push({ type: 'process definition', error });
    }
  }

  // Report results
  if (results.length === 0) {
    if (errors.length === 0) {
      logger.info('No form found for user task or process definition');
    } else if (errors.length === 1) {
      logger.error(`Failed to get form: not found as ${errors[0].type}`, errors[0].error as Error);
      process.exit(1);
    } else {
      logger.error(`Failed to get form: not found as user task or process definition`);
      process.exit(1);
    }
  } else if (results.length === 1) {
    logger.info(`Form found for ${results[0].type}:`);
    logger.json(results[0].form);
  } else {
    logger.info('Form found in both user task and process definition:');
    logger.json({
      userTask: results.find(r => r.type === 'user task')?.form,
      processDefinition: results.find(r => r.type === 'process definition')?.form,
    });
  }
}
