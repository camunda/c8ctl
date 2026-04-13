/**
 * Topology commands
 */

import { createClient, emitDryRun } from "../client.ts";
import { handleCommandError } from "../errors.ts";
import { getLogger } from "../logger.ts";

/**
 * Get cluster topology
 */
export async function getTopology(options: {
	profile?: string;
}): Promise<void> {
	if (emitDryRun({ command: "get topology", method: "GET", endpoint: "/topology", profile: options.profile })) return;
	const logger = getLogger();
	const client = createClient(options.profile);

	try {
		const result = await client.getTopology();
		logger.json(result);
	} catch (error) {
		handleCommandError(logger, "Failed to get topology", error);
	}
}
