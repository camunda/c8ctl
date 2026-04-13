/**
 * Identity mapping rule commands
 */

import { createClient, fetchAllPages } from "../client.ts";
import { resolveClusterConfig } from "../config.ts";
import { handleCommandError } from "../errors.ts";
import { getLogger, type SortOrder, sortTableData } from "../logger.ts";
import { c8ctl } from "../runtime.ts";

/**
 * List all mapping rules
 */
export async function listMappingRules(options: {
	profile?: string;
	sortBy?: string;
	sortOrder?: SortOrder;
	limit?: number;
}): Promise<void> {
	const logger = getLogger();
	const client = createClient(options.profile);

	try {
		const items = await fetchAllPages(
			(filter, opts) => client.searchMappingRule(filter, opts),
			{},
			undefined,
			options.limit,
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
		tableData = sortTableData(
			tableData,
			options.sortBy,
			logger,
			options.sortOrder,
		);
		logger.table(tableData);
	} catch (error) {
		handleCommandError(logger, "Failed to list mapping rules", error);
	}
}

/**
 * Search mapping rules with filters
 */
export async function searchIdentityMappingRules(options: {
	profile?: string;
	mappingRuleId?: string;
	name?: string;
	claimName?: string;
	claimValue?: string;
	sortBy?: string;
	sortOrder?: SortOrder;
	limit?: number;
}): Promise<void> {
	const logger = getLogger();
	const client = createClient(options.profile);

	try {
		const filter: Record<string, unknown> = {};
		if (options.mappingRuleId) filter.mappingRuleId = options.mappingRuleId;
		if (options.name) filter.name = options.name;
		if (options.claimName) filter.claimName = options.claimName;
		if (options.claimValue) filter.claimValue = options.claimValue;

		const searchFilter = Object.keys(filter).length > 0 ? { filter } : {};

		const items = await fetchAllPages(
			(f, opts) => client.searchMappingRule(f, opts),
			searchFilter,
			undefined,
			options.limit,
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
		tableData = sortTableData(
			tableData,
			options.sortBy,
			logger,
			options.sortOrder,
		);
		logger.table(tableData);
	} catch (error) {
		handleCommandError(logger, "Failed to search mapping rules", error);
	}
}

/**
 * Get a single mapping rule by mappingRuleId
 */
export async function getIdentityMappingRule(
	mappingRuleId: string,
	options: {
		profile?: string;
	},
): Promise<void> {
	const logger = getLogger();
	const client = createClient(options.profile);

	try {
		const result = await client.getMappingRule(
			{ mappingRuleId: mappingRuleId },
			{ consistency: { waitUpToMs: 0 } },
		);
		logger.json(result);
	} catch (error) {
		handleCommandError(
			logger,
			`Failed to get mapping rule '${mappingRuleId}'`,
			error,
		);
	}
}

/**
 * Create a new mapping rule
 */
export async function createIdentityMappingRule(options: {
	profile?: string;
	mappingRuleId?: string;
	name?: string;
	claimName?: string;
	claimValue?: string;
}): Promise<void> {
	const logger = getLogger();

	if (!options.mappingRuleId) {
		logger.error("--mappingRuleId is required");
		process.exit(1);
	}
	if (!options.name) {
		logger.error("--name is required");
		process.exit(1);
	}
	if (!options.claimName) {
		logger.error("--claimName is required");
		process.exit(1);
	}
	if (!options.claimValue) {
		logger.error("--claimValue is required");
		process.exit(1);
	}

	const body = {
		mappingRuleId: options.mappingRuleId,
		name: options.name,
		claimName: options.claimName,
		claimValue: options.claimValue,
	};

	if (c8ctl.dryRun) {
		const config = resolveClusterConfig(options.profile);
		logger.json({
			dryRun: true,
			command: "create mapping-rule",
			method: "POST",
			url: `${config.baseUrl}/mapping-rules`,
			body,
		});
		return;
	}

	const client = createClient(options.profile);

	try {
		await client.createMappingRule(body);
		logger.success(`Mapping rule '${options.name}' created`);
	} catch (error) {
		handleCommandError(logger, "Failed to create mapping rule", error);
	}
}

/**
 * Delete a mapping rule by mappingRuleId
 */
export async function deleteIdentityMappingRule(
	mappingRuleId: string,
	options: {
		profile?: string;
	},
): Promise<void> {
	const logger = getLogger();

	if (c8ctl.dryRun) {
		const config = resolveClusterConfig(options.profile);
		logger.json({
			dryRun: true,
			command: "delete mapping-rule",
			method: "DELETE",
			url: `${config.baseUrl}/mapping-rules/${encodeURIComponent(mappingRuleId)}`,
			body: null,
		});
		return;
	}

	const client = createClient(options.profile);

	try {
		await client.deleteMappingRule({ mappingRuleId: mappingRuleId });
		logger.success(`Mapping rule '${mappingRuleId}' deleted`);
	} catch (error) {
		handleCommandError(
			logger,
			`Failed to delete mapping rule '${mappingRuleId}'`,
			error,
		);
	}
}
