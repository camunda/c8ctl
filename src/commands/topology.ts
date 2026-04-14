/**
 * Topology commands
 */

import { defineCommand, dryRun } from "../command-framework.ts";

/**
 * Get cluster topology
 */
export const getTopologyCommand = defineCommand(
	"get",
	"topology",
	async (ctx) => {
		const { client, profile } = ctx;

		const dr = dryRun({
			command: "get topology",
			method: "GET",
			endpoint: "/topology",
			profile,
		});
		if (dr) return dr;

		const result = await client.getTopology();
		return { kind: "get", data: result };
	},
);
