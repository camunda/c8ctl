/**
 * Process definition commands — CLI bindings of the process definition
 * services.
 */

import {
	clusterInputOf,
	defineCommand,
	defineServiceCommand,
} from "../framework/index.ts";
import {
	getProcessDefinition,
	getProcessDefinitionRequest,
	getProcessDefinitionXml,
	getProcessDefinitionXmlRequest,
	listProcessDefinitions,
	listProcessDefinitionsRequest,
} from "../services/index.ts";

// ─── get pd ──────────────────────────────────────────────────────────────────

/**
 * Get a process definition, or its BPMN XML with `--xml`. Two services
 * behind one command, so it stays a plain handler.
 */
export const getProcessDefinitionCommand = defineCommand(
	"get",
	"process-definition",
	async (ctx, flags, args) => {
		const input = { processDefinitionKey: args.key };

		if (flags.xml) {
			const dr = ctx.dryRun({
				command: "get process-definition xml",
				profile: ctx.profile,
				...getProcessDefinitionXmlRequest(input),
			});
			if (dr) return dr;

			const xml = await getProcessDefinitionXml(
				{ ...input, ...clusterInputOf(ctx) },
				{},
			);
			return { kind: "raw", content: xml };
		}

		const dr = ctx.dryRun({
			command: "get process-definition",
			profile: ctx.profile,
			...getProcessDefinitionRequest(input),
		});
		if (dr) return dr;

		const result = await getProcessDefinition(
			{ ...input, ...clusterInputOf(ctx) },
			{},
		);
		return { kind: "get", data: result };
	},
);

/**
 * List process definitions
 */
export const listProcessDefinitionsCommand = defineServiceCommand(
	"list",
	"process-definition",
	{
		toInput: (_flags, _args, scope) => ({ limit: scope.limit }),
		dryRun: {
			command: "list process-definitions",
			request: listProcessDefinitionsRequest,
		},
		service: listProcessDefinitions,
		render: ({ items }) => ({
			kind: "list",
			items: items.map((pd) => ({
				Key: pd.processDefinitionKey,
				"Process ID": pd.processDefinitionId,
				Name: pd.name || "-",
				Version: pd.version,
				"Tenant ID": pd.tenantId,
			})),
			emptyMessage: "No process definitions found",
		}),
	},
);
