/**
 * Message commands
 */

import { TenantId } from "@camunda8/orchestration-cluster-api";
import { defineCommand, dryRun } from "../command-framework.ts";
import { resolveTenantId } from "../config.ts";

/**
 * Publish message
 */
export const publishMessageCommand = defineCommand(
	"publish",
	"message",
	async (ctx, flags, args) => {
		const { client, profile } = ctx;
		const name = args.name;
		const tenantId = resolveTenantId(profile);

		const body: Record<string, unknown> = {
			name,
			tenantId,
			correlationKey: flags.correlationKey || "",
		};
		let variables: Record<string, unknown> | undefined;
		if (flags.variables) {
			variables = JSON.parse(flags.variables);
			body.variables = variables;
		}
		const timeToLive = flags.timeToLive
			? parseInt(flags.timeToLive, 10)
			: undefined;
		if (timeToLive !== undefined) {
			if (Number.isNaN(timeToLive) || timeToLive < 0) {
				ctx.logger.error(
					"--timeToLive must be a non-negative integer (milliseconds)",
				);
				process.exit(1);
			}
			body.timeToLive = timeToLive;
		}

		const dr = dryRun({
			command: "publish message",
			method: "POST",
			endpoint: "/messages/publication",
			profile,
			body,
		});
		if (dr) return dr;

		await client.publishMessage({
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
			variables = JSON.parse(flags.variables);
			body.variables = variables;
		}
		const timeToLive = flags.timeToLive
			? parseInt(flags.timeToLive, 10)
			: undefined;
		if (timeToLive !== undefined) {
			if (Number.isNaN(timeToLive) || timeToLive < 0) {
				ctx.logger.error(
					"--timeToLive must be a non-negative integer (milliseconds)",
				);
				process.exit(1);
			}
			body.timeToLive = timeToLive;
		}

		const dr = dryRun({
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
