/**
 * Message commands
 */

import { getLogger } from '../logger.ts';
import { createClient } from '../client.ts';
import { resolveTenantId } from '../config.ts';

/**
 * Publish message
 */
export async function publishMessage(name: string, options: {
  profile?: string;
  correlationKey?: string;
  variables?: string;
  timeToLive?: number;
}): Promise<void> {
  const logger = getLogger();
  const client = createClient(options.profile);
  const tenantId = resolveTenantId(options.profile);

  try {
    const request: any = {
      name,
      tenantId,
      correlationKey: options.correlationKey || '',
    };

    if (options.variables) {
      try {
        request.variables = JSON.parse(options.variables);
      } catch (error) {
        logger.error('Invalid JSON for variables', error as Error);
        process.exit(1);
      }
    }

    if (options.timeToLive !== undefined) {
      request.timeToLive = options.timeToLive;
    }

    await client.publishMessage(request);
    logger.success(`Message '${name}' published`);
  } catch (error) {
    logger.error(`Failed to publish message '${name}'`, error as Error);
    process.exit(1);
  }
}

/**
 * Correlate message (same as publish in most cases)
 */
export async function correlateMessage(name: string, options: {
  profile?: string;
  correlationKey?: string;
  variables?: string;
  timeToLive?: number;
}): Promise<void> {
  // For now, correlate is the same as publish
  // In the SDK, both use the same underlying method
  await publishMessage(name, options);
}
