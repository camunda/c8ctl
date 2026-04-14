/**
 * Process definition commands
 */

import { fetchAllPages } from "../client.ts";
import { defineCommand, dryRun } from "../command-framework.ts";

// ─── get pd ──────────────────────────────────────────────────────────────────

export const getProcessDefinitionCommand = defineCommand(
	"get",
	"process-definition",
	async (ctx, flags, args) => {
		const { client, profile } = ctx;
		const key = args.key;

		if (flags.xml) {
			const dr = dryRun({
				command: "get process-definition xml",
				method: "GET",
				endpoint: `/process-definitions/${key}/xml`,
				profile,
			});
			if (dr) return dr;

			const result = await client.getProcessDefinitionXml(
				{ processDefinitionKey: key },
				{ consistency: { waitUpToMs: 0 } },
			);
			return { kind: "raw", content: result };
		}

		const dr = dryRun({
			command: "get process-definition",
			method: "GET",
			endpoint: `/process-definitions/${key}`,
			profile,
		});
		if (dr) return dr;

		const result = await client.getProcessDefinition(
			{ processDefinitionKey: key },
			{ consistency: { waitUpToMs: 0 } },
		);
		return { kind: "get", data: result };
	},
);

/**
 * List process definitions
 */
export const listProcessDefinitionsCommand = defineCommand(
	"list",
	"process-definition",
	async (ctx) => {
		const { client, tenantId, profile, limit } = ctx;

		const filter: Record<string, unknown> = {
			filter: {
				tenantId,
			},
		};

		const dr = dryRun({
			command: "list process-definitions",
			method: "POST",
			endpoint: "/process-definitions/search",
			profile,
			body: filter,
		});
		if (dr) return dr;

		const allItems = await fetchAllPages(
			(f, opts) => client.searchProcessDefinitions(f, opts),
			filter,
			undefined,
			limit,
		);

		return {
			kind: "list",
			items: allItems.map((pd) => ({
				Key: pd.processDefinitionKey,
				"Process ID": pd.processDefinitionId,
				Name: pd.name || "-",
				Version: pd.version,
				"Tenant ID": pd.tenantId,
			})),
			emptyMessage: "No process definitions found",
		};
	},
);
