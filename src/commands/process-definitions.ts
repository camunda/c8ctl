/**
 * Process definition commands
 */

import { getLogger } from '../logger.ts';
import { sortTableData } from '../logger.ts';
import { createClient } from '../client.ts';
import { resolveTenantId } from '../config.ts';

/**
 * List process definitions
 */
export async function listProcessDefinitions(options: {
  profile?: string;
  sortBy?: string;
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

    const result = await client.searchProcessDefinitions(filter, { consistency: { waitUpToMs: 0 } });
    
    if (result.items && result.items.length > 0) {
      let tableData = result.items.map((pd: any) => ({
        Key: pd.processDefinitionKey || pd.key,
        'Process ID': pd.processDefinitionId,
        Name: pd.name || '-',
        Version: pd.version,
        'Tenant ID': pd.tenantId,
      }));
      tableData = sortTableData(tableData, options.sortBy, logger);
      logger.table(tableData);
    } else {
      logger.info('No process definitions found');
    }
  } catch (error) {
    logger.error('Failed to list process definitions', error as Error);
    process.exit(1);
  }
}

/**
 * Get process definition by key
 */
export async function getProcessDefinition(key: string, options: {
  profile?: string;
  xml?: boolean;
}): Promise<void> {
  const logger = getLogger();
  const client = createClient(options.profile);

  try {
    if (options.xml) {
      const result = await client.getProcessDefinitionXml(
        { processDefinitionKey: key as any },
        { consistency: { waitUpToMs: 0 } }
      );
      logger.info(result);
    } else {
      const result = await client.getProcessDefinition(
        { processDefinitionKey: key as any },
        { consistency: { waitUpToMs: 0 } }
      );
      logger.json(result);
    }
  } catch (error) {
    logger.error(`Failed to get process definition ${key}`, error as Error);
    process.exit(1);
  }
}
