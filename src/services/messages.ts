/**
 * Message services: publish.
 */

import {
	type CamundaClient,
	TenantId,
} from "@camunda8/orchestration-cluster-api";
import type { C8ctlContext, ClusterInput } from "../core/index.ts";
import { brandInput, C8ctlError, callCluster, connect } from "../core/index.ts";

type PublishedMessage = Awaited<ReturnType<CamundaClient["publishMessage"]>>;

export interface PublishMessageInput {
	name: string;
	/** Default: an empty correlation key. */
	correlationKey?: string;
	variables?: Record<string, unknown>;
	/** Buffer time in milliseconds; a non-negative integer. */
	timeToLive?: number;
}

/** The request `publishMessage` sends. */
export function publishMessageRequest(
	input: PublishMessageInput,
	tenantId: string | undefined,
) {
	const body: Record<string, unknown> = {
		name: input.name,
		tenantId,
		correlationKey: input.correlationKey || "",
	};
	if (input.variables !== undefined) body.variables = input.variables;
	if (input.timeToLive !== undefined) {
		if (Number.isNaN(input.timeToLive) || input.timeToLive < 0) {
			throw new C8ctlError(
				"invalid-input",
				"--timeToLive must be a non-negative integer (milliseconds)",
				{ field: "timeToLive" },
			);
		}
		body.timeToLive = input.timeToLive;
	}
	return { method: "POST", endpoint: "/messages/publication", body };
}

export async function publishMessage(
	input: PublishMessageInput & ClusterInput,
	ctx: C8ctlContext = {},
): Promise<PublishedMessage> {
	const { client, defaultTenantId } = connect(input.target, ctx);
	const tenantId = input.tenantId ?? defaultTenantId;
	// Validates the input before anything is sent.
	publishMessageRequest(input, tenantId);
	return callCluster(
		() =>
			client.publishMessage({
				name: input.name,
				...(tenantId !== undefined && {
					tenantId: brandInput("tenantId", tenantId, TenantId.assumeExists),
				}),
				correlationKey: input.correlationKey || "",
				...(input.variables !== undefined && { variables: input.variables }),
				...(input.timeToLive !== undefined && {
					timeToLive: input.timeToLive,
				}),
			}),
		ctx,
	);
}
