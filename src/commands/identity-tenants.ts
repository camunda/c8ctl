/**
 * Identity tenant commands
 */

import { fetchAllPages } from "../client.ts";
import { defineCommand, dryRun } from "../command-framework.ts";
import { sortTableData } from "../logger.ts";

/**
 * List all tenants
 */
export const listTenantsCommand = defineCommand(
	"list",
	"tenant",
	async (ctx) => {
		const { client, profile, limit } = ctx;

		const dr = dryRun({
			command: "list tenants",
			method: "POST",
			endpoint: "/tenants/search",
			profile,
			body: {},
		});
		if (dr) return dr;

		const items = await fetchAllPages(
			(filter, opts) => client.searchTenants(filter, opts),
			{},
			undefined,
			limit,
		);

		return {
			kind: "list",
			items: items.map((t) => ({
				"Tenant ID": t.tenantId ?? "",
				Name: t.name ?? "",
				Description: t.description ?? "",
			})),
			emptyMessage: "No tenants found",
		};
	},
);
/**
 * Search tenants with filters
 */
export const searchIdentityTenantsCommand = defineCommand(
	"search",
	"tenant",
	async (ctx, flags, _args) => {
		const { client, logger, profile, limit, sortBy, sortOrder } = ctx;

		const filter: Record<string, unknown> = {};
		if (flags.tenantId) filter.tenantId = flags.tenantId;
		if (flags.name) filter.name = flags.name;

		const searchFilter = Object.keys(filter).length > 0 ? { filter } : {};

		const dr = dryRun({
			command: "search tenants",
			method: "POST",
			endpoint: "/tenants/search",
			profile,
			body: searchFilter,
		});
		if (dr) return dr;

		const items = await fetchAllPages(
			(f, opts) => client.searchTenants(f, opts),
			searchFilter,
			undefined,
			limit,
		);

		if (items.length === 0) {
			logger.info("No tenants found");
			return;
		}

		let tableData = items.map((t) => ({
			"Tenant ID": t.tenantId ?? "",
			Name: t.name ?? "",
			Description: t.description ?? "",
		}));
		tableData = sortTableData(tableData, sortBy, logger, sortOrder);
		logger.table(tableData);
	},
);

/**
 * Get a single tenant by tenantId
 */
export const getIdentityTenantCommand = defineCommand(
	"get",
	"tenant",
	async (ctx, _flags, args) => {
		const { client, profile } = ctx;
		const tenantId = args.tenantId;

		const dr = dryRun({
			command: "get tenant",
			method: "GET",
			endpoint: `/tenants/${tenantId}`,
			profile,
		});
		if (dr) return dr;

		const result = await client.getTenant(
			{ tenantId },
			{ consistency: { waitUpToMs: 0 } },
		);
		return { kind: "get", data: result };
	},
);

/**
 * Create a new tenant
 */
export const createIdentityTenantCommand = defineCommand(
	"create",
	"tenant",
	async (ctx, flags, _args) => {
		const { client, profile } = ctx;

		if (!flags.tenantId) {
			throw new Error("--tenantId is required");
		}
		if (!flags.name) {
			throw new Error("--name is required");
		}

		const body = {
			tenantId: flags.tenantId,
			name: flags.name,
		};

		const dr = dryRun({
			command: "create tenant",
			method: "POST",
			endpoint: "/tenants",
			profile,
			body,
		});
		if (dr) return dr;

		await client.createTenant(body);
		return { kind: "success", message: `Tenant '${flags.tenantId}' created` };
	},
);

/**
 * Delete a tenant by tenantId
 */
export const deleteIdentityTenantCommand = defineCommand(
	"delete",
	"tenant",
	async (ctx, _flags, args) => {
		const { client, profile } = ctx;
		const tenantId = args.tenantId;

		const dr = dryRun({
			command: "delete tenant",
			method: "DELETE",
			endpoint: `/tenants/${encodeURIComponent(String(tenantId))}`,
			profile,
			body: null,
		});
		if (dr) return dr;

		await client.deleteTenant({ tenantId });
		return { kind: "success", message: `Tenant '${tenantId}' deleted` };
	},
);
