/**
 * Identity mapping rule commands — CLI bindings of the mapping rule
 * services.
 */

import { defineServiceCommand } from "../framework/index.ts";
import {
	createMappingRule,
	createMappingRuleRequest,
	deleteMappingRule,
	deleteMappingRuleRequest,
	getMappingRule,
	getMappingRuleRequest,
	listMappingRules,
	listMappingRulesRequest,
	searchMappingRules,
	searchMappingRulesRequest,
} from "../services/index.ts";

/** Table row of a mapping rule. */
function row(m: {
	mappingRuleId?: string | null;
	name?: string | null;
	claimName?: string | null;
	claimValue?: string | null;
}) {
	return {
		"Mapping Rule ID": m.mappingRuleId ?? "",
		Name: m.name ?? "",
		"Claim Name": m.claimName ?? "",
		"Claim Value": m.claimValue ?? "",
	};
}

/**
 * List all mapping rules
 */
export const listMappingRulesCommand = defineServiceCommand(
	"list",
	"mapping-rule",
	{
		toInput: (_flags, _args, scope) => ({ limit: scope.limit }),
		dryRun: {
			command: "list mapping-rules",
			request: listMappingRulesRequest,
		},
		service: listMappingRules,
		render: ({ items }) => ({
			kind: "list",
			items: items.map(row),
			emptyMessage: "No mapping rules found",
		}),
	},
);

/**
 * Search mapping rules with filters
 */
export const searchIdentityMappingRulesCommand = defineServiceCommand(
	"search",
	"mapping-rule",
	{
		toInput: (flags, _args, scope) => ({
			mappingRuleId: flags.mappingRuleId,
			name: flags.name,
			claimName: flags.claimName,
			claimValue: flags.claimValue,
			limit: scope.limit,
		}),
		dryRun: {
			command: "search mapping-rules",
			request: searchMappingRulesRequest,
		},
		service: searchMappingRules,
		render: ({ items }) => ({
			kind: "list",
			items: items.map(row),
			emptyMessage: "No mapping rules found",
		}),
	},
);

/**
 * Get a single mapping rule by mappingRuleId
 */
export const getIdentityMappingRuleCommand = defineServiceCommand(
	"get",
	"mapping-rule",
	{
		toInput: (_flags, args) => ({ mappingRuleId: args.mappingRuleId }),
		dryRun: { command: "get mapping-rule", request: getMappingRuleRequest },
		service: getMappingRule,
		render: (mappingRule) => ({ kind: "get", data: mappingRule }),
	},
);

/**
 * Create a new mapping rule
 */
export const createIdentityMappingRuleCommand = defineServiceCommand(
	"create",
	"mapping-rule",
	{
		toInput: (flags) => ({
			mappingRuleId: flags.mappingRuleId ?? "",
			name: flags.name ?? "",
			claimName: flags.claimName ?? "",
			claimValue: flags.claimValue ?? "",
		}),
		dryRun: {
			command: "create mapping-rule",
			request: createMappingRuleRequest,
		},
		service: createMappingRule,
		render: (_result, input) => ({
			kind: "success",
			message: `Mapping rule '${input.name}' created`,
		}),
	},
);

/**
 * Delete a mapping rule by mappingRuleId
 */
export const deleteIdentityMappingRuleCommand = defineServiceCommand(
	"delete",
	"mapping-rule",
	{
		toInput: (_flags, args) => ({ mappingRuleId: args.mappingRuleId }),
		dryRun: {
			command: "delete mapping-rule",
			request: deleteMappingRuleRequest,
		},
		service: deleteMappingRule,
		render: ({ mappingRuleId }) => ({
			kind: "success",
			message: `Mapping rule '${mappingRuleId}' deleted`,
		}),
	},
);
