/**
 * Variable services: set.
 */

import type { C8ctlContext, ClusterInput } from "../core/index.ts";
import { callCluster, connect } from "../core/index.ts";

export interface SetVariableInput {
	/** Key of the process instance or flow element instance. */
	elementInstanceKey: string;
	variables: Record<string, unknown>;
	/** Set the variables on the element itself, not propagated upwards. */
	local?: boolean;
}

/** The request `setVariable` sends. */
export function setVariableRequest(input: SetVariableInput) {
	return {
		method: "PUT",
		endpoint: `/element-instances/${input.elementInstanceKey}/variables`,
		body: {
			variables: input.variables,
			...(input.local === true && { local: true }),
		},
	};
}

export async function setVariable(
	input: SetVariableInput & ClusterInput,
	ctx: C8ctlContext = {},
): Promise<{ elementInstanceKey: string }> {
	const { client } = connect(input.target, ctx);
	const { body } = setVariableRequest(input);
	await callCluster(
		() =>
			client.createElementInstanceVariables({
				elementInstanceKey: input.elementInstanceKey,
				...body,
			}),
		ctx,
	);
	return { elementInstanceKey: input.elementInstanceKey };
}
