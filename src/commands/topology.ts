/**
 * Topology commands — CLI bindings of the topology services.
 */

import { defineServiceCommand } from "../framework/index.ts";
import { getTopology, getTopologyRequest } from "../services/index.ts";

/**
 * Get cluster topology
 */
export const getTopologyCommand = defineServiceCommand("get", "topology", {
	toInput: () => ({}),
	dryRun: { command: "get topology", request: getTopologyRequest },
	service: getTopology,
	render: (topology) => ({ kind: "get", data: topology }),
});
