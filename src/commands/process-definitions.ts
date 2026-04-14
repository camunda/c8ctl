/**
 * Process definition commands
 */

import { ProcessDefinitionKey } from "@camunda8/orchestration-cluster-api";
import { createClient, emitDryRun, fetchAllPages } from "../client.ts";
import { defineCommand } from "../command-framework.ts";
import type { FlagDef } from "../command-registry.ts";
import { resolveTenantId } from "../config.ts";
import { handleCommandError } from "../errors.ts";
import { getLogger, type SortOrder, sortTableData } from "../logger.ts";

// ─── get pd ──────────────────────────────────────────────────────────────────

const GET_PD_FLAGS = {
	xml: {
		type: "boolean",
		description: "Get BPMN XML (process definitions)",
	},
} as const satisfies Record<string, FlagDef>;

export const getProcessDefinitionCommand = defineCommand({
	verb: "get",
	resources: ["pd", "process-definition"],
	flags: GET_PD_FLAGS,
	handler: async (ctx, flags) => {
		const { client, logger, positionals, profile } = ctx;
		const key = positionals[0];

		if (!key) {
			logger.error("Process definition key required. Usage: c8 get pd <key>");
			process.exit(1);
		}

		if (flags.xml) {
			if (
				emitDryRun({
					command: "get process-definition xml",
					method: "GET",
					endpoint: `/process-definitions/${key}/xml`,
					profile,
				})
			)
				return;
		} else {
			if (
				emitDryRun({
					command: "get process-definition",
					method: "GET",
					endpoint: `/process-definitions/${key}`,
					profile,
				})
			)
				return;
		}

		try {
			if (flags.xml) {
				const result = await client.getProcessDefinitionXml(
					{ processDefinitionKey: ProcessDefinitionKey.assumeExists(key) },
					{ consistency: { waitUpToMs: 0 } },
				);
				logger.output(result);
			} else {
				const result = await client.getProcessDefinition(
					{ processDefinitionKey: ProcessDefinitionKey.assumeExists(key) },
					{ consistency: { waitUpToMs: 0 } },
				);
				logger.json(result);
			}
		} catch (error) {
			handleCommandError(
				logger,
				`Failed to get process definition ${key}`,
				error,
			);
		}
	},
});

/**
 * List process definitions
 */
export async function listProcessDefinitions(options: {
	profile?: string;
	sortBy?: string;
	sortOrder?: SortOrder;
	limit?: number;
}): Promise<void> {
	const logger = getLogger();
	const client = createClient(options.profile);
	const tenantId = resolveTenantId(options.profile);

	try {
		const filter: Record<string, unknown> = {
			filter: {
				tenantId,
			},
		};

		if (
			emitDryRun({
				command: "list process-definitions",
				method: "POST",
				endpoint: "/process-definitions/search",
				profile: options.profile,
				body: filter,
			})
		)
			return;

		const allItems = await fetchAllPages(
			(f, opts) => client.searchProcessDefinitions(f, opts),
			filter,
			undefined,
			options.limit,
		);

		if (allItems.length > 0) {
			let tableData = allItems.map((pd) => ({
				Key: pd.processDefinitionKey,
				"Process ID": pd.processDefinitionId,
				Name: pd.name || "-",
				Version: pd.version,
				"Tenant ID": pd.tenantId,
			}));
			tableData = sortTableData(
				tableData,
				options.sortBy,
				logger,
				options.sortOrder,
			);
			logger.table(tableData);
		} else {
			logger.info("No process definitions found");
		}
	} catch (error) {
		handleCommandError(logger, "Failed to list process definitions", error);
	}
}
