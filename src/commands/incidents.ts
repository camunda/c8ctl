/**
 * Incident commands
 */

import { getLogger } from '../logger.ts';
import { createClient } from '../client.ts';
import { resolveTenantId } from '../config.ts';

/**
 * List incidents
 */
export async function listIncidents(options: {
  profile?: string;
  state?: string;
  processInstanceKey?: string;
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

    if (options.state) {
      filter.filter.state = options.state;
    }

    if (options.processInstanceKey) {
      filter.filter.processInstanceKey = options.processInstanceKey;
    }

    const result = await client.searchIncidents(filter);
    
    if (result.items && result.items.length > 0) {
      const tableData = result.items.map((incident: any) => ({
        Key: incident.incidentKey || incident.key,
        Type: incident.errorType,
        Message: incident.errorMessage?.substring(0, 50) || '',
        State: incident.state,
        'Process Instance': incident.processInstanceKey,
        'Tenant ID': incident.tenantId,
      }));
      logger.table(tableData);
    } else {
      logger.info('No incidents found');
    }
  } catch (error) {
    logger.error('Failed to list incidents', error as Error);
    process.exit(1);
  }
}

/**
 * Resolve incident
 */
export async function resolveIncident(key: string, options: {
  profile?: string;
}): Promise<void> {
  const logger = getLogger();
  const client = createClient(options.profile);

  try {
    await client.resolveIncident(key);
    logger.success(`Incident ${key} resolved`);
  } catch (error) {
    logger.error(`Failed to resolve incident ${key}`, error as Error);
    process.exit(1);
  }
}
