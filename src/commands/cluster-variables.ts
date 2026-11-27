/**
 * Cluster variable commands — CLI bindings of the cluster variable services.
 *
 * The scope is global unless `--tenantId` is given; the session tenant is
 * never used.
 */

import {
	ClusterVariableKindEnum,
	ClusterVariableScopeEnum,
} from "@camunda8/orchestration-cluster-api";
import { defineServiceCommand, requireEnum } from "../framework/index.ts";
import {
	assertClusterVariableMetadata,
	createClusterVariable,
	createClusterVariableRequest,
	deleteClusterVariable,
	deleteClusterVariableRequest,
	getClusterVariable,
	getClusterVariableRequest,
	listClusterVariables,
	listClusterVariablesRequest,
	searchClusterVariables,
	searchClusterVariablesRequest,
	updateClusterVariable,
	updateClusterVariableRequest,
} from "../services/index.ts";
import { parseJsonObjectFlag } from "../utils/index.ts";

const EMPTY_MESSAGE = "No cluster variables found";

function parseValue(raw: string) {
	return parseJsonObjectFlag({
		raw,
		flag: { name: "value", exampleFile: "value.json" },
	});
}

function parseMetadata(raw: string | undefined) {
	if (raw === undefined) return undefined;
	const metadata = parseJsonObjectFlag({
		raw,
		flag: { name: "metadata", exampleFile: "metadata.json" },
	});
	assertClusterVariableMetadata(metadata);
	return metadata;
}

function scopeLabel(tenant: string | undefined) {
	return tenant ? `tenant '${tenant}'` : "global";
}

/** Table row of a cluster variable. */
function row(v: {
	name: string;
	scope: string;
	tenantId?: string | null;
	kind?: string | null;
	value: string;
	isTruncated?: boolean | null;
}) {
	return {
		Name: v.name,
		Scope: v.scope,
		"Tenant ID": v.tenantId ?? "",
		Kind: v.kind ?? "",
		Value: v.value,
		Truncated: v.isTruncated ? "✓" : "",
	};
}

/**
 * List all cluster variables
 */
export const listClusterVariablesCommand = defineServiceCommand(
	"list",
	"cluster-variable",
	{
		toInput: (_flags, _args, scope) => ({ limit: scope.limit }),
		dryRun: {
			command: "list cluster-variables",
			request: listClusterVariablesRequest,
		},
		service: listClusterVariables,
		render: ({ items }) => ({
			kind: "list",
			items: items.map(row),
			emptyMessage: EMPTY_MESSAGE,
		}),
	},
);

/**
 * Search cluster variables with filters
 */
export const searchClusterVariablesCommand = defineServiceCommand(
	"search",
	"cluster-variable",
	{
		toInput: (flags, _args, scope) => ({
			name: flags.name,
			value: flags.value,
			scope:
				flags.scope === undefined
					? undefined
					: requireEnum(flags.scope, ClusterVariableScopeEnum, "scope"),
			tenant: flags.tenantId,
			kind:
				flags.kind === undefined
					? undefined
					: requireEnum(flags.kind, ClusterVariableKindEnum, "kind"),
			fullValue: flags.fullValue,
			limit: scope.limit,
		}),
		dryRun: {
			command: "search cluster-variables",
			request: searchClusterVariablesRequest,
		},
		service: searchClusterVariables,
		render: ({ items }) => ({
			kind: "list",
			items: items.map(row),
			emptyMessage: EMPTY_MESSAGE,
		}),
	},
);

/**
 * Get a cluster variable with its full value
 */
export const getClusterVariableCommand = defineServiceCommand(
	"get",
	"cluster-variable",
	{
		toInput: (flags, args) => ({ name: args.name, tenant: flags.tenantId }),
		dryRun: {
			command: "get cluster-variable",
			request: getClusterVariableRequest,
		},
		service: getClusterVariable,
		render: (variable) => ({ kind: "get", data: variable }),
	},
);

/**
 * Create a cluster variable
 */
export const createClusterVariableCommand = defineServiceCommand(
	"create",
	"cluster-variable",
	{
		toInput: (flags, args) => ({
			name: args.name,
			tenant: flags.tenantId,
			value: parseValue(flags.value),
			metadata: parseMetadata(flags.metadata),
			kind:
				flags.kind === undefined
					? undefined
					: requireEnum(flags.kind, ClusterVariableKindEnum, "kind"),
		}),
		dryRun: {
			command: "create cluster-variable",
			request: createClusterVariableRequest,
		},
		service: createClusterVariable,
		render: ({ name, tenant }) => ({
			kind: "success",
			message: `Cluster variable '${name}' created (${scopeLabel(tenant)})`,
		}),
	},
);

/**
 * Update the value and metadata of a cluster variable
 */
export const updateClusterVariableCommand = defineServiceCommand(
	"update",
	"cluster-variable",
	{
		toInput: (flags, args) => ({
			name: args.name,
			tenant: flags.tenantId,
			value: parseValue(flags.value),
			metadata: parseMetadata(flags.metadata),
		}),
		dryRun: {
			command: "update cluster-variable",
			request: updateClusterVariableRequest,
		},
		service: updateClusterVariable,
		render: ({ name, tenant }) => ({
			kind: "success",
			message: `Cluster variable '${name}' updated (${scopeLabel(tenant)})`,
		}),
	},
);

/**
 * Delete a cluster variable
 */
export const deleteClusterVariableCommand = defineServiceCommand(
	"delete",
	"cluster-variable",
	{
		toInput: (flags, args) => ({ name: args.name, tenant: flags.tenantId }),
		dryRun: {
			command: "delete cluster-variable",
			request: deleteClusterVariableRequest,
		},
		service: deleteClusterVariable,
		render: ({ name, tenant }) => ({
			kind: "success",
			message: `Cluster variable '${name}' deleted (${scopeLabel(tenant)})`,
		}),
	},
);
