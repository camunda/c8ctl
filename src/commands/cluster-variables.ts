/**
 * Cluster variable commands (global and tenant scope)
 */

import {
	ClusterVariableKindEnum,
	ClusterVariableScopeEnum,
	type ClusterVariableSearchQueryFilterRequest,
	type ClusterVariableSearchResult,
} from "@camunda8/orchestration-cluster-api";
import { fetchAllPages } from "../core/index.ts";
import { defineCommand, requireEnum } from "../framework/index.ts";
import { parseJsonObjectFlag, toStringFilter } from "../utils/index.ts";

const enc = encodeURIComponent;

// Scope comes from an explicit --tenantId only, never the session tenant.
const endpoint = ({
	tenantId,
	name,
}: {
	tenantId?: string;
	name?: string;
}): string => {
	const base = tenantId
		? `/cluster-variables/tenants/${enc(tenantId)}`
		: "/cluster-variables/global";
	return name === undefined ? base : `${base}/${enc(name)}`;
};

const scopeLabel = (tenantId?: string): string =>
	tenantId ? `tenant '${tenantId}'` : "global";

const parseValue = (raw: string): Record<string, unknown> =>
	parseJsonObjectFlag({
		raw,
		flag: { name: "value", exampleFile: "value.json" },
	});

const parseMetadata = (raw: string): Record<string, string | number> => {
	const parsed = parseJsonObjectFlag({
		raw,
		flag: { name: "metadata", exampleFile: "metadata.json" },
	});
	const metadata: Record<string, string | number> = {};
	for (const [key, v] of Object.entries(parsed)) {
		if (
			typeof v === "string" ||
			(typeof v === "number" && Number.isFinite(v))
		) {
			metadata[key] = v;
		} else {
			throw new Error(
				`--metadata value for key '${key}' must be a string or number`,
			);
		}
	}
	return metadata;
};

const toKind = (v: string | undefined) =>
	v === undefined ? undefined : requireEnum(v, ClusterVariableKindEnum, "kind");

const toScope = (v: string | undefined) =>
	v === undefined
		? undefined
		: requireEnum(v, ClusterVariableScopeEnum, "scope");

const toRow = (v: ClusterVariableSearchResult) => ({
	Name: v.name,
	Scope: v.scope,
	"Tenant ID": v.tenantId ?? "",
	Kind: v.kind,
	Value: v.value,
	Truncated: v.isTruncated,
});

const EMPTY_MESSAGE = "No cluster variables found";

export const createClusterVariableCommand = defineCommand(
	"create",
	"cluster-variable",
	async (ctx, flags, args) => {
		const { client, profile } = ctx;
		const { name } = args;
		const value = parseValue(flags.value);
		const metadata =
			flags.metadata !== undefined ? parseMetadata(flags.metadata) : undefined;
		const kind = toKind(flags.kind);

		const body = {
			name,
			value,
			...(metadata && { metadata }),
			...(kind && { kind }),
		};

		const dr = ctx.dryRun({
			command: "create cluster-variable",
			method: "POST",
			endpoint: endpoint({ tenantId: flags.tenantId }),
			profile,
			body,
		});
		if (dr) return dr;

		if (flags.tenantId) {
			await client.createTenantClusterVariable({
				tenantId: flags.tenantId,
				...body,
			});
		} else {
			await client.createGlobalClusterVariable(body);
		}
		return {
			kind: "success",
			message: `Cluster variable '${name}' created (${scopeLabel(flags.tenantId)})`,
		};
	},
);

export const getClusterVariableCommand = defineCommand(
	"get",
	"cluster-variable",
	async (ctx, flags, args) => {
		const { client, profile } = ctx;
		const { name } = args;

		const dr = ctx.dryRun({
			command: "get cluster-variable",
			method: "GET",
			endpoint: endpoint({ tenantId: flags.tenantId, name }),
			profile,
		});
		if (dr) return dr;

		const consistency = { consistency: { waitUpToMs: 0 } };
		const result = flags.tenantId
			? await client.getTenantClusterVariable(
					{ tenantId: flags.tenantId, name },
					consistency,
				)
			: await client.getGlobalClusterVariable({ name }, consistency);
		return { kind: "get", data: result };
	},
);

export const updateClusterVariableCommand = defineCommand(
	"update",
	"cluster-variable",
	async (ctx, flags, args) => {
		const { client, profile } = ctx;
		const { name } = args;
		const value = parseValue(flags.value);
		const metadata =
			flags.metadata !== undefined ? parseMetadata(flags.metadata) : undefined;

		const body = { value, ...(metadata && { metadata }) };

		const dr = ctx.dryRun({
			command: "update cluster-variable",
			method: "PUT",
			endpoint: endpoint({ tenantId: flags.tenantId, name }),
			profile,
			body,
		});
		if (dr) return dr;

		if (flags.tenantId) {
			await client.updateTenantClusterVariable({
				tenantId: flags.tenantId,
				name,
				...body,
			});
		} else {
			await client.updateGlobalClusterVariable({ name, ...body });
		}
		return {
			kind: "success",
			message: `Cluster variable '${name}' updated (${scopeLabel(flags.tenantId)})`,
		};
	},
);

export const deleteClusterVariableCommand = defineCommand(
	"delete",
	"cluster-variable",
	async (ctx, flags, args) => {
		const { client, profile } = ctx;
		const { name } = args;

		const dr = ctx.dryRun({
			command: "delete cluster-variable",
			method: "DELETE",
			endpoint: endpoint({ tenantId: flags.tenantId, name }),
			profile,
			body: null,
		});
		if (dr) return dr;

		if (flags.tenantId) {
			await client.deleteTenantClusterVariable({
				tenantId: flags.tenantId,
				name,
			});
		} else {
			await client.deleteGlobalClusterVariable({ name });
		}
		return {
			kind: "success",
			message: `Cluster variable '${name}' deleted (${scopeLabel(flags.tenantId)})`,
		};
	},
);

export const listClusterVariablesCommand = defineCommand(
	"list",
	"cluster-variable",
	async (ctx) => {
		const { client, profile, limit } = ctx;

		const dr = ctx.dryRun({
			command: "list cluster-variables",
			method: "POST",
			endpoint: "/cluster-variables/search",
			profile,
			body: {},
		});
		if (dr) return dr;

		const items = await fetchAllPages(
			(f, opts) => client.searchClusterVariables(f, opts),
			{},
			undefined,
			limit,
		);
		return {
			kind: "list",
			items: items.map(toRow),
			emptyMessage: EMPTY_MESSAGE,
		};
	},
);

export const searchClusterVariablesCommand = defineCommand(
	"search",
	"cluster-variable",
	async (ctx, flags) => {
		const { client, profile, limit } = ctx;

		const filter: ClusterVariableSearchQueryFilterRequest = {};
		if (flags.name) filter.name = toStringFilter(flags.name);
		if (flags.value) filter.value = toStringFilter(flags.value);
		const scope = toScope(flags.scope);
		if (scope) filter.scope = scope;
		if (flags.tenantId) filter.tenantId = flags.tenantId;
		const kind = toKind(flags.kind);
		if (kind) filter.kind = kind;
		if (flags.isTruncated) filter.isTruncated = true;

		const truncateValues = !flags.fullValue;
		const searchFilter = Object.keys(filter).length > 0 ? { filter } : {};

		const dr = ctx.dryRun({
			command: "search cluster-variables",
			method: "POST",
			endpoint: `/cluster-variables/search?truncateValues=${truncateValues}`,
			profile,
			body: searchFilter,
		});
		if (dr) return dr;

		const items = await fetchAllPages(
			(f, opts) =>
				client.searchClusterVariables({ ...f, truncateValues }, opts),
			searchFilter,
			undefined,
			limit,
		);
		return {
			kind: "list",
			items: items.map(toRow),
			emptyMessage: EMPTY_MESSAGE,
		};
	},
);
