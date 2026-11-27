/**
 * Topology services: get.
 */

import type { CamundaClient } from "@camunda8/orchestration-cluster-api";
import type { C8ctlContext, ClusterInput } from "../core/index.ts";
import { callCluster, connect } from "../core/index.ts";

type Topology = Awaited<ReturnType<CamundaClient["getTopology"]>>;

export function getTopologyRequest() {
	return { method: "GET", endpoint: "/topology" };
}

export async function getTopology(
	input: ClusterInput,
	ctx: C8ctlContext = {},
): Promise<Topology> {
	const { client } = connect(input.target, ctx);
	return callCluster(() => client.getTopology(), ctx);
}
