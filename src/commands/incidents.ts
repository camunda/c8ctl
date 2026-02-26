/**
 * Incident commands
 */

import { getLogger } from '../logger.ts';
import { sortTableData, type SortOrder } from '../logger.ts';
import { createClient, fetchAllPages } from '../client.ts';
import { resolveTenantId } from '../config.ts';

/**
 * List incidents
 */
export async function listIncidents(options: {
  profile?: string;
  state?: string;
  processInstanceKey?: string;
  sortBy?: string;
  sortOrder?: SortOrder;
  limit?: number;
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

    const allItems = await fetchAllPages(
      (f, opts) => client.searchIncidents(f, opts),
      filter,
      undefined,
      options.limit,
    );
    
    if (allItems.length > 0) {
      let tableData = allItems.map((incident: any) => ({
        Key: incident.incidentKey || incident.key,
        Type: incident.errorType,
        Message: incident.errorMessage?.substring(0, 50) || '',
        State: incident.state,
        Created: incident.creationTime || '-',
        'Process Instance': incident.processInstanceKey,
        'Tenant ID': incident.tenantId,
      }));
      tableData = sortTableData(tableData, options.sortBy, logger, options.sortOrder);
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
 * Get incident by key
 */
export async function getIncident(key: string, options: {
  profile?: string;
}): Promise<void> {
  const logger = getLogger();
  const client = createClient(options.profile);

  try {
    const result = await client.getIncident({ incidentKey: key as any }, { consistency: { waitUpToMs: 0 } });
    logger.json(result);
  } catch (error) {
    logger.error(`Failed to get incident ${key}`, error as Error);
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
    await client.resolveIncident({ incidentKey: key as any });
    logger.success(`Incident ${key} resolved`);
  } catch (error) {
    logger.error(`Failed to resolve incident ${key}`, error as Error);
    process.exit(1);
  }
}
