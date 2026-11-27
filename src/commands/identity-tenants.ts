/**
 * Identity tenant commands — CLI bindings of the tenant services.
 */

import { defineServiceCommand } from "../framework/index.ts";
import {
	createTenant,
	createTenantRequest,
	deleteTenant,
	deleteTenantRequest,
	getTenant,
	getTenantRequest,
	listTenants,
	listTenantsRequest,
	searchTenants,
	searchTenantsRequest,
} from "../services/index.ts";

/** Table row of a tenant. */
function row(t: {
	tenantId?: string | null;
	name?: string | null;
	description?: string | null;
}) {
	return {
		"Tenant ID": t.tenantId ?? "",
		Name: t.name ?? "",
		Description: t.description ?? "",
	};
}

/**
 * List all tenants
 */
export const listTenantsCommand = defineServiceCommand("list", "tenant", {
	toInput: (_flags, _args, scope) => ({ limit: scope.limit }),
	dryRun: { command: "list tenants", request: listTenantsRequest },
	service: listTenants,
	render: ({ items }) => ({
		kind: "list",
		items: items.map(row),
		emptyMessage: "No tenants found",
	}),
});

/**
 * Search tenants with filters
 */
export const searchIdentityTenantsCommand = defineServiceCommand(
	"search",
	"tenant",
	{
		toInput: (flags, _args, scope) => ({
			tenant: flags.tenantId,
			name: flags.name,
			limit: scope.limit,
		}),
		dryRun: { command: "search tenants", request: searchTenantsRequest },
		service: searchTenants,
		render: ({ items }) => ({
			kind: "list",
			items: items.map(row),
			emptyMessage: "No tenants found",
		}),
	},
);

/**
 * Get a single tenant by tenantId
 */
export const getIdentityTenantCommand = defineServiceCommand("get", "tenant", {
	toInput: (_flags, args) => ({ tenant: args.tenantId }),
	dryRun: { command: "get tenant", request: getTenantRequest },
	service: getTenant,
	render: (tenant) => ({ kind: "get", data: tenant }),
});

/**
 * Create a new tenant
 */
export const createIdentityTenantCommand = defineServiceCommand(
	"create",
	"tenant",
	{
		toInput: (flags) => ({
			tenant: flags.tenantId ?? "",
			name: flags.name ?? "",
		}),
		dryRun: { command: "create tenant", request: createTenantRequest },
		service: createTenant,
		render: (_result, input) => ({
			kind: "success",
			message: `Tenant '${input.tenant}' created`,
		}),
	},
);

/**
 * Delete a tenant by tenantId
 */
export const deleteIdentityTenantCommand = defineServiceCommand(
	"delete",
	"tenant",
	{
		toInput: (_flags, args) => ({ tenant: args.tenantId }),
		dryRun: { command: "delete tenant", request: deleteTenantRequest },
		service: deleteTenant,
		render: (_result, input) => ({
			kind: "success",
			message: `Tenant '${input.tenant}' deleted`,
		}),
	},
);
