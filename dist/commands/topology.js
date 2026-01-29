/**
 * Topology commands
 */
import { getLogger } from "../logger.js";
import { createClient } from "../client.js";
/**
 * Get cluster topology
 */
export async function getTopology(options) {
    const logger = getLogger();
    const client = createClient(options.profile);
    try {
        const result = await client.getTopology();
        logger.json(result);
    }
    catch (error) {
        logger.error('Failed to get topology', error);
        process.exit(1);
    }
}
//# sourceMappingURL=topology.js.map