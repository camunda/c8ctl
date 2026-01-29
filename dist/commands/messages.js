/**
 * Message commands
 */
import { getLogger } from "../logger.js";
import { createClient } from "../client.js";
import { resolveTenantId } from "../config.js";
/**
 * Publish message
 */
export async function publishMessage(name, options) {
    const logger = getLogger();
    const client = createClient(options.profile);
    const tenantId = resolveTenantId(options.profile);
    try {
        const request = {
            name,
            tenantId,
            correlationKey: options.correlationKey || '',
        };
        if (options.variables) {
            try {
                request.variables = JSON.parse(options.variables);
            }
            catch (error) {
                logger.error('Invalid JSON for variables', error);
                process.exit(1);
            }
        }
        if (options.timeToLive !== undefined) {
            request.timeToLive = options.timeToLive;
        }
        await client.publishMessage(request);
        logger.success(`Message '${name}' published`);
    }
    catch (error) {
        logger.error(`Failed to publish message '${name}'`, error);
        process.exit(1);
    }
}
/**
 * Correlate message (same as publish in most cases)
 */
export async function correlateMessage(name, options) {
    // For now, correlate is the same as publish
    // In the SDK, both use the same underlying method
    await publishMessage(name, options);
}
//# sourceMappingURL=messages.js.map