/**
 * Process instance commands
 */
import { getLogger } from "../logger.js";
import { createClient } from "../client.js";
import { resolveTenantId } from "../config.js";
/**
 * List process instances
 */
export async function listProcessInstances(options) {
    const logger = getLogger();
    const client = createClient(options.profile);
    const tenantId = resolveTenantId(options.profile);
    try {
        const filter = {
            filter: {
                tenantId,
            },
        };
        if (options.processDefinitionId) {
            filter.filter.processDefinitionId = options.processDefinitionId;
        }
        if (options.state) {
            filter.filter.state = options.state;
        }
        else if (!options.all) {
            // By default, exclude COMPLETED instances unless --all is specified
            filter.filter.state = 'ACTIVE';
        }
        const result = await client.searchProcessInstances(filter, { consistency: { waitUpToMs: 0 } });
        if (result.items && result.items.length > 0) {
            const tableData = result.items.map((pi) => ({
                Key: pi.processInstanceKey || pi.key,
                'Process ID': pi.processDefinitionId,
                State: pi.state,
                Version: pi.processDefinitionVersion || pi.version,
                'Tenant ID': pi.tenantId,
            }));
            logger.table(tableData);
        }
        else {
            logger.info('No process instances found');
        }
    }
    catch (error) {
        logger.error('Failed to list process instances', error);
        process.exit(1);
    }
}
/**
 * Get process instance by key
 */
export async function getProcessInstance(key, options) {
    const logger = getLogger();
    const client = createClient(options.profile);
    try {
        const result = await client.getProcessInstance({ processInstanceKey: key }, { consistency: { waitUpToMs: 0 } });
        logger.json(result);
    }
    catch (error) {
        logger.error(`Failed to get process instance ${key}`, error);
        process.exit(1);
    }
}
/**
 * Create process instance
 */
export async function createProcessInstance(options) {
    const logger = getLogger();
    const client = createClient(options.profile);
    const tenantId = resolveTenantId(options.profile);
    if (!options.processDefinitionId) {
        logger.error('processDefinitionId is required. Use --processDefinitionId flag');
        process.exit(1);
    }
    try {
        const request = {
            processDefinitionId: options.processDefinitionId,
            tenantId,
        };
        if (options.version !== undefined) {
            request.processDefinitionVersion = options.version;
        }
        if (options.variables) {
            try {
                request.variables = JSON.parse(options.variables);
            }
            catch (error) {
                logger.error('Invalid JSON for variables', error);
                process.exit(1);
            }
        }
        const result = await client.createProcessInstance(request);
        logger.success('Process instance created', result.processInstanceKey);
    }
    catch (error) {
        logger.error('Failed to create process instance', error);
        process.exit(1);
    }
}
/**
 * Cancel process instance
 */
export async function cancelProcessInstance(key, options) {
    const logger = getLogger();
    const client = createClient(options.profile);
    try {
        await client.cancelProcessInstance({ processInstanceKey: key });
        logger.success(`Process instance ${key} cancelled`);
    }
    catch (error) {
        logger.error(`Failed to cancel process instance ${key}`, error);
        process.exit(1);
    }
}
//# sourceMappingURL=process-instances.js.map