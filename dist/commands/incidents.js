/**
 * Incident commands
 */
import { getLogger } from "../logger.js";
import { createClient } from "../client.js";
import { resolveTenantId } from "../config.js";
/**
 * List incidents
 */
export async function listIncidents(options) {
    const logger = getLogger();
    const client = createClient(options.profile);
    const tenantId = resolveTenantId(options.profile);
    try {
        const filter = {
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
        const result = await client.searchIncidents(filter, { consistency: { waitUpToMs: 0 } });
        if (result.items && result.items.length > 0) {
            const tableData = result.items.map((incident) => ({
                Key: incident.incidentKey || incident.key,
                Type: incident.errorType,
                Message: incident.errorMessage?.substring(0, 50) || '',
                State: incident.state,
                'Process Instance': incident.processInstanceKey,
                'Tenant ID': incident.tenantId,
            }));
            logger.table(tableData);
        }
        else {
            logger.info('No incidents found');
        }
    }
    catch (error) {
        logger.error('Failed to list incidents', error);
        process.exit(1);
    }
}
/**
 * Resolve incident
 */
export async function resolveIncident(key, options) {
    const logger = getLogger();
    const client = createClient(options.profile);
    try {
        await client.resolveIncident({ incidentKey: key });
        logger.success(`Incident ${key} resolved`);
    }
    catch (error) {
        logger.error(`Failed to resolve incident ${key}`, error);
        process.exit(1);
    }
}
//# sourceMappingURL=incidents.js.map