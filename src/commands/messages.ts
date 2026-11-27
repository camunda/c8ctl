/**
 * Message commands. `publish` is the CLI binding of the publishMessage
 * service.
 */

import { TenantId } from "@camunda8/orchestration-cluster-api";
import { resolveTenantId } from "../core/index.ts";
import { defineCommand, defineServiceCommand } from "../framework/index.ts";
import { publishMessage, publishMessageRequest } from "../services/index.ts";
import { parseVariablesFlag } from "../utils/index.ts";

/**
 * Publish message
 */
export const publishMessageCommand = defineServiceCommand(
	"publish",
	"message",
	{
		toInput: (flags, args) => ({
			name: args.name,
			correlationKey: flags.correlationKey,
			variables: flags.variables
				? parseVariablesFlag({ raw: flags.variables })
				: undefined,
			timeToLive: flags.timeToLive ? parseInt(flags.timeToLive, 10) : undefined,
		}),
		dryRun: { command: "publish message", request: publishMessageRequest },
		service: publishMessage,
		render: (_message, { name }) => ({
			kind: "success",
			message: `Message '${name}' published`,
		}),
	},
);

/**
 * Correlate message
 */
export const correlateMessageCommand = defineCommand(
	"correlate",
	"message",
	async (ctx, flags, args) => {
		const { profile } = ctx;
		const name = args.name;
		const tenantId = resolveTenantId(profile);

		const body: Record<string, unknown> = {
			name,
			tenantId,
			correlationKey: flags.correlationKey || "",
		};
		let variables: Record<string, unknown> | undefined;
		if (flags.variables) {
			variables = parseVariablesFlag({ raw: flags.variables });
			body.variables = variables;
		}
		const timeToLive = flags.timeToLive
			? parseInt(flags.timeToLive, 10)
			: undefined;
		if (timeToLive !== undefined) {
			if (Number.isNaN(timeToLive) || timeToLive < 0) {
				throw new Error(
					"--timeToLive must be a non-negative integer (milliseconds)",
				);
			}
			body.timeToLive = timeToLive;
		}

		const dr = ctx.dryRun({
			command: "correlate message",
			method: "POST",
			endpoint: "/messages/correlation",
			profile,
			body,
		});
		if (dr) return dr;

		// For now, correlate is the same as publish in the SDK
		await ctx.client.publishMessage({
			name,
			...(tenantId !== undefined && {
				tenantId: TenantId.assumeExists(tenantId),
			}),
			correlationKey: flags.correlationKey || "",
			...(variables !== undefined && { variables }),
			...(timeToLive !== undefined && { timeToLive }),
		});
		return { kind: "success", message: `Message '${name}' published` };
	},
);
