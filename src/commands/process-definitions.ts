/**
 * Process definition commands
 */

import type {
	ProcessDefinitionId,
	ProcessDefinitionKey,
	suspendProcessDefinitionsInput,
	TenantId,
} from "@camunda8/orchestration-cluster-api";
import { fetchAllPages } from "../core/index.ts";
import { defineCommand } from "../framework/index.ts";

// ─── get pd ──────────────────────────────────────────────────────────────────

export const getProcessDefinitionCommand = defineCommand(
	"get",
	"process-definition",
	async (ctx, flags, args) => {
		const { client, profile } = ctx;
		const key = args.key;

		if (flags.xml) {
			const dr = ctx.dryRun({
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

		const dr = ctx.dryRun({
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

		const dr = ctx.dryRun({
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

// ─── suspend / resume pd ─────────────────────────────────────────────────────

const SUSPEND_RESUME_USAGE =
	"Usage: c8 suspend|resume pd <key> [--includeProcessInstances], or c8 suspend|resume pd --processDefinitionId <id> [--version <n>] [--tenantId <id>] [--includeProcessInstances]";

/**
 * Validate the mutually exclusive selectors (key, or ID with optional version
 * and tenant) and build the request body shared by suspension and resumption.
 */
function buildSelector({
	key,
	processDefinitionId,
	version,
	tenantId,
	includeProcessInstances,
}: {
	key: ProcessDefinitionKey | undefined;
	processDefinitionId: ProcessDefinitionId | undefined;
	version: string | undefined;
	tenantId: TenantId | undefined;
	includeProcessInstances: boolean | undefined;
}): suspendProcessDefinitionsInput {
	if (key && processDefinitionId) {
		throw new Error(
			"Pass either a process definition key or --processDefinitionId, not both",
		);
	}
	if (!key && !processDefinitionId) {
		throw new Error(
			`Process definition key or --processDefinitionId required. ${SUSPEND_RESUME_USAGE}`,
		);
	}
	if (version !== undefined && !/^[1-9]\d*$/.test(version)) {
		throw new Error(
			`Invalid --version: "${version}" is not a positive integer`,
		);
	}
	const instances = includeProcessInstances ? { includeProcessInstances } : {};
	if (key) {
		if (version !== undefined || tenantId) {
			throw new Error(
				"--version and --tenantId only apply with --processDefinitionId, not with a process definition key",
			);
		}
		return { processDefinitionKey: key, ...instances };
	}
	if (!processDefinitionId) {
		throw new Error(SUSPEND_RESUME_USAGE);
	}
	return {
		processDefinitionId,
		...(version !== undefined && { processDefinitionVersion: Number(version) }),
		...(tenantId && { tenantId }),
		...instances,
	};
}

function suspensionRows(result: {
	processDefinitions: Array<{
		processDefinitionKey: string;
		processDefinitionVersion: number;
		outcome: string;
	}>;
	batchOperationKey: string | null;
}) {
	return result.processDefinitions.map((pd) => ({
		processDefinitionKey: pd.processDefinitionKey,
		version: pd.processDefinitionVersion,
		outcome: pd.outcome,
		batchOperationKey: result.batchOperationKey ?? "-",
	}));
}

export const suspendProcessDefinitionCommand = defineCommand(
	"suspend",
	"process-definition",
	async (ctx, flags, args) => {
		const { client, profile } = ctx;
		const body = buildSelector({
			key: args.key,
			processDefinitionId: flags.processDefinitionId,
			version: flags.version,
			tenantId: flags.tenantId,
			includeProcessInstances: flags.includeProcessInstances,
		});

		const dr = ctx.dryRun({
			command: "suspend process-definition",
			method: "POST",
			endpoint: "/process-definitions/suspension",
			profile,
			body,
		});
		if (dr) return dr;

		const result = await client.suspendProcessDefinitions(body);
		return {
			kind: "list",
			items: suspensionRows(result),
			emptyMessage: "No process definition versions were affected",
		};
	},
);

export const resumeProcessDefinitionCommand = defineCommand(
	"resume",
	"process-definition",
	async (ctx, flags, args) => {
		const { client, profile } = ctx;
		const body = buildSelector({
			key: args.key,
			processDefinitionId: flags.processDefinitionId,
			version: flags.version,
			tenantId: flags.tenantId,
			includeProcessInstances: flags.includeProcessInstances,
		});

		const dr = ctx.dryRun({
			command: "resume process-definition",
			method: "POST",
			endpoint: "/process-definitions/resumption",
			profile,
			body,
		});
		if (dr) return dr;

		const result = await client.resumeProcessDefinitions(body);
		return {
			kind: "list",
			items: suspensionRows(result),
			emptyMessage: "No process definition versions were affected",
		};
	},
);
