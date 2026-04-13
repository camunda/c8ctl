/**
 * Process definition commands
 */

import { ProcessDefinitionKey } from "@camunda8/orchestration-cluster-api";
import { createClient, emitDryRun, fetchAllPages } from "../client.ts";
import { resolveTenantId } from "../config.ts";
import { handleCommandError } from "../errors.ts";
import { getLogger, type SortOrder, sortTableData } from "../logger.ts";

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

		if (emitDryRun({ command: "list process-definitions", method: "POST", endpoint: "/process-definitions/search", profile: options.profile, body: filter })) return;

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

/**
 * Get process definition by key
 */
export async function getProcessDefinition(
	key: string,
	options: {
		profile?: string;
		xml?: boolean;
	},
): Promise<void> {
	const logger = getLogger();
	const client = createClient(options.profile);

	if (options.xml) {
		if (emitDryRun({ command: "get process-definition xml", method: "GET", endpoint: `/process-definitions/${key}/xml`, profile: options.profile })) return;
	} else {
		if (emitDryRun({ command: "get process-definition", method: "GET", endpoint: `/process-definitions/${key}`, profile: options.profile })) return;
	}

	try {
		if (options.xml) {
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
}
