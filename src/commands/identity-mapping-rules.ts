/**
 * Identity mapping rule commands
 */

import { fetchAllPages } from "../client.ts";
import { defineCommand, dryRun } from "../command-framework.ts";
import { getLogger, sortTableData } from "../logger.ts";

/**
 * List all mapping rules
 */
export const listMappingRulesCommand = defineCommand(
	"list",
	"mapping-rule",
	async (ctx) => {
		const { client, profile, limit } = ctx;

		const dr = dryRun({
			command: "list mapping-rules",
			method: "POST",
			endpoint: "/mapping-rules/search",
			profile,
			body: {},
		});
		if (dr) return dr;

		const items = await fetchAllPages(
			(filter, opts) => client.searchMappingRule(filter, opts),
			{},
			undefined,
			limit,
		);

		return {
			kind: "list",
			items: items.map((m) => ({
				"Mapping Rule ID": m.mappingRuleId ?? "",
				Name: m.name ?? "",
				"Claim Name": m.claimName ?? "",
				"Claim Value": m.claimValue ?? "",
			})),
			emptyMessage: "No mapping rules found",
		};
	},
);
/**
 * Search mapping rules with filters
 */
export const searchIdentityMappingRulesCommand = defineCommand(
	"search",
	"mapping-rule",
	async (ctx, flags, _args) => {
		const { client, logger, profile, limit, sortBy, sortOrder } = ctx;

		const filter: Record<string, unknown> = {};
		if (flags.mappingRuleId) filter.mappingRuleId = flags.mappingRuleId;
		if (flags.name) filter.name = flags.name;
		if (flags.claimName) filter.claimName = flags.claimName;
		if (flags.claimValue) filter.claimValue = flags.claimValue;

		const searchFilter = Object.keys(filter).length > 0 ? { filter } : {};

		const dr = dryRun({
			command: "search mapping-rules",
			method: "POST",
			endpoint: "/mapping-rules/search",
			profile,
			body: searchFilter,
		});
		if (dr) return dr;

		const items = await fetchAllPages(
			(f, opts) => client.searchMappingRule(f, opts),
			searchFilter,
			undefined,
			limit,
		);

		if (items.length === 0) {
			logger.info("No mapping rules found");
			return;
		}

		let tableData = items.map((m) => ({
			"Mapping Rule ID": m.mappingRuleId ?? "",
			Name: m.name ?? "",
			"Claim Name": m.claimName ?? "",
			"Claim Value": m.claimValue ?? "",
		}));
		tableData = sortTableData(tableData, sortBy, logger, sortOrder);
		logger.table(tableData);
	},
);

/**
 * Get a single mapping rule by mappingRuleId
 */
export const getIdentityMappingRuleCommand = defineCommand(
	"get",
	"mapping-rule",
	async (ctx, _flags, args) => {
		const { client, profile } = ctx;
		const mappingRuleId = args.mappingRuleId;

		const dr = dryRun({
			command: "get mapping-rule",
			method: "GET",
			endpoint: `/mapping-rules/${mappingRuleId}`,
			profile,
		});
		if (dr) return dr;

		const result = await client.getMappingRule(
			{ mappingRuleId },
			{ consistency: { waitUpToMs: 0 } },
		);
		return { kind: "get", data: result };
	},
);

/**
 * Create a new mapping rule
 */
export const createIdentityMappingRuleCommand = defineCommand(
	"create",
	"mapping-rule",
	async (ctx, flags, _args) => {
		const { client, profile } = ctx;

		if (!flags.mappingRuleId) {
			getLogger().error("--mappingRuleId is required");
			process.exit(1);
		}
		if (!flags.name) {
			getLogger().error("--name is required");
			process.exit(1);
		}
		if (!flags.claimName) {
			getLogger().error("--claimName is required");
			process.exit(1);
		}
		if (!flags.claimValue) {
			getLogger().error("--claimValue is required");
			process.exit(1);
		}

		const body = {
			mappingRuleId: flags.mappingRuleId,
			name: flags.name,
			claimName: flags.claimName,
			claimValue: flags.claimValue,
		};

		const dr = dryRun({
			command: "create mapping-rule",
			method: "POST",
			endpoint: "/mapping-rules",
			profile,
			body,
		});
		if (dr) return dr;

		await client.createMappingRule(body);
		return { kind: "success", message: `Mapping rule '${flags.name}' created` };
	},
);

/**
 * Delete a mapping rule by mappingRuleId
 */
export const deleteIdentityMappingRuleCommand = defineCommand(
	"delete",
	"mapping-rule",
	async (ctx, _flags, args) => {
		const { client, profile } = ctx;
		const mappingRuleId = args.mappingRuleId;

		const dr = dryRun({
			command: "delete mapping-rule",
			method: "DELETE",
			endpoint: `/mapping-rules/${encodeURIComponent(mappingRuleId)}`,
			profile,
			body: null,
		});
		if (dr) return dr;

		await client.deleteMappingRule({ mappingRuleId });
		return {
			kind: "success",
			message: `Mapping rule '${mappingRuleId}' deleted`,
		};
	},
);
