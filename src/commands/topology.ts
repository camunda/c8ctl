/**
 * Topology commands
 */

import { getLogger } from '../logger.ts';
import { createClient } from '../client.ts';
import { handleCommandError } from '../errors.ts';

/**
 * Get cluster topology
 */
export async function getTopology(options: {
  profile?: string;
}): Promise<void> {
  const logger = getLogger();
  const client = createClient(options.profile);

  try {
    const result = await client.getTopology();
    logger.json(result);
  } catch (error) {
    handleCommandError(logger, 'Failed to get topology', error);
  }
}
