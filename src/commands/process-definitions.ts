/**
 * Process definition commands
 */

import { getLogger } from '../logger.ts';
import { sortTableData, type SortOrder } from '../logger.ts';
import { createClient, fetchAllPages } from '../client.ts';
import { resolveTenantId } from '../config.ts';
import { handleCommandError } from '../errors.ts';
import { ProcessDefinitionKey } from '@camunda8/orchestration-cluster-api';

/**
 * List process definitions
 */
export async function listProcessDefinitions(options: {
  profile?: string;
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

    const allItems = await fetchAllPages(
      (f, opts) => client.searchProcessDefinitions(f, opts),
      filter,
      undefined,
      options.limit,
    );
    
    if (allItems.length > 0) {
      let tableData = allItems.map((pd: any) => ({
        Key: pd.processDefinitionKey || pd.key,
        'Process ID': pd.processDefinitionId,
        Name: pd.name || '-',
        Version: pd.version,
        'Tenant ID': pd.tenantId,
      }));
      tableData = sortTableData(tableData, options.sortBy, logger, options.sortOrder);
      logger.table(tableData);
    } else {
      logger.info('No process definitions found');
    }
  } catch (error) {
    handleCommandError(logger, 'Failed to list process definitions', error);
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
        { processDefinitionKey: ProcessDefinitionKey.assumeExists(key) },
        { consistency: { waitUpToMs: 0 } }
      );
      logger.output(result);
    } else {
      const result = await client.getProcessDefinition(
        { processDefinitionKey: ProcessDefinitionKey.assumeExists(key) },
        { consistency: { waitUpToMs: 0 } }
      );
      logger.json(result);
    }
  } catch (error) {
    handleCommandError(logger, `Failed to get process definition ${key}`, error);
  }
}
