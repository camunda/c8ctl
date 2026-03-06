/**
 * Message commands
 */

import { getLogger } from '../logger.ts';
import { createClient } from '../client.ts';
import { resolveTenantId, resolveClusterConfig } from '../config.ts';
import { c8ctl } from '../runtime.ts';

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

  // Dry-run: emit the would-be API request without executing
  if (c8ctl.dryRun) {
    const config = resolveClusterConfig(options.profile);
    const tenantId = resolveTenantId(options.profile);
    const body: Record<string, unknown> = {
      name,
      tenantId,
      correlationKey: options.correlationKey || '',
    };
    if (options.variables) body.variables = JSON.parse(options.variables);
    if (options.timeToLive !== undefined) body.timeToLive = options.timeToLive;
    logger.json({
      dryRun: true,
      command: 'publish message',
      method: 'POST',
      url: `${config.baseUrl}/messages/publication`,
      body,
    });
    return;
  }

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
 * Correlate message
 */
export async function correlateMessage(name: string, options: {
  profile?: string;
  correlationKey?: string;
  variables?: string;
  timeToLive?: number;
}): Promise<void> {
  const logger = getLogger();

  // Dry-run: emit the would-be API request without executing (uses correlation endpoint)
  if (c8ctl.dryRun) {
    const config = resolveClusterConfig(options.profile);
    const tenantId = resolveTenantId(options.profile);
    const body: Record<string, unknown> = {
      name,
      tenantId,
      correlationKey: options.correlationKey || '',
    };
    if (options.variables) body.variables = JSON.parse(options.variables);
    if (options.timeToLive !== undefined) body.timeToLive = options.timeToLive;
    logger.json({
      dryRun: true,
      command: 'correlate message',
      method: 'POST',
      url: `${config.baseUrl}/messages/correlation`,
      body,
      note: 'SDK limitation: actual execution currently uses /messages/publication endpoint',
    });
    return;
  }

  // For now, correlate is the same as publish in most cases
  // In the SDK, both use the same underlying method
  await publishMessage(name, options);
}
