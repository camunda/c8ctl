/**
 * Topology commands
 */

import { getLogger } from '../logger.ts';
import { createClient } from '../client.ts';

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
    logger.error('Failed to get topology', error as Error);
    process.exit(1);
  }
}
