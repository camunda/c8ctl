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
