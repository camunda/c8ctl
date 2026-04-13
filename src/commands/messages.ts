/**
 * Message commands
 */

import { TenantId } from "@camunda8/orchestration-cluster-api";
import { createClient } from "../client.ts";
import { resolveClusterConfig, resolveTenantId } from "../config.ts";
import { handleCommandError } from "../errors.ts";
import { getLogger } from "../logger.ts";
import { c8ctl } from "../runtime.ts";

/**
 * Publish message
 */
export async function publishMessage(
	name: string,
	options: {
		profile?: string;
		correlationKey?: string;
		variables?: string;
		timeToLive?: number;
	},
): Promise<void> {
	const logger = getLogger();

	// Dry-run: emit the would-be API request without executing
	if (c8ctl.dryRun) {
		const config = resolveClusterConfig(options.profile);
		const tenantId = resolveTenantId(options.profile);
		const body: Record<string, unknown> = {
			name,
			tenantId,
			correlationKey: options.correlationKey || "",
		};
		if (options.variables) body.variables = JSON.parse(options.variables);
		if (options.timeToLive !== undefined) body.timeToLive = options.timeToLive;
		logger.json({
			dryRun: true,
			command: "publish message",
			method: "POST",
			url: `${config.baseUrl}/messages/publication`,
			body,
		});
		return;
	}

	const client = createClient(options.profile);
	const tenantId = resolveTenantId(options.profile);

	try {
		let variables: Record<string, unknown> | undefined;
		if (options.variables) {
			try {
				variables = JSON.parse(options.variables);
			} catch (error) {
				handleCommandError(logger, "Invalid JSON for variables", error);
			}
		}

		await client.publishMessage({
			name,
			tenantId: TenantId.assumeExists(tenantId),
			correlationKey: options.correlationKey || "",
			...(variables !== undefined && { variables }),
			...(options.timeToLive !== undefined && {
				timeToLive: options.timeToLive,
			}),
		});
		logger.success(`Message '${name}' published`);
	} catch (error) {
		handleCommandError(logger, `Failed to publish message '${name}'`, error);
	}
}

/**
 * Correlate message
 */
export async function correlateMessage(
	name: string,
	options: {
		profile?: string;
		correlationKey?: string;
		variables?: string;
		timeToLive?: number;
	},
): Promise<void> {
	const logger = getLogger();

	// Dry-run: emit the would-be API request without executing (uses correlation endpoint)
	if (c8ctl.dryRun) {
		const config = resolveClusterConfig(options.profile);
		const tenantId = resolveTenantId(options.profile);
		const body: Record<string, unknown> = {
			name,
			tenantId,
			correlationKey: options.correlationKey || "",
		};
		if (options.variables) body.variables = JSON.parse(options.variables);
		if (options.timeToLive !== undefined) body.timeToLive = options.timeToLive;
		logger.json({
			dryRun: true,
			command: "correlate message",
			method: "POST",
			url: `${config.baseUrl}/messages/correlation`,
			body,
			note: "SDK limitation: actual execution currently uses /messages/publication endpoint",
		});
		return;
	}

	// For now, correlate is the same as publish in most cases
	// In the SDK, both use the same underlying method
	await publishMessage(name, options);
}
