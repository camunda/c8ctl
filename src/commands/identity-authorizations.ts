/**
 * Identity authorization commands
 */

import {
	type OwnerTypeEnum,
	OwnerTypeEnum as OwnerTypeValues,
	type PermissionTypeEnum,
	PermissionTypeEnum as PermissionTypeValues,
	type ResourceTypeEnum,
	ResourceTypeEnum as ResourceTypeValues,
} from "@camunda8/orchestration-cluster-api";
import { fetchAllPages } from "../client.ts";
import { defineCommand, dryRun } from "../command-framework.ts";
import {
	requireCsvEnum,
	requireEnum,
	requireOption,
} from "../command-validation.ts";
import { sortTableData } from "../logger.ts";

/**
 * List all authorizations
 */
export const listAuthorizationsCommand = defineCommand(
	"list",
	"authorization",
	async (ctx) => {
		const { client, profile, limit } = ctx;

		const dr = dryRun({
			command: "list authorizations",
			method: "POST",
			endpoint: "/authorizations/search",
			profile,
			body: {},
		});
		if (dr) return dr;

		const items = await fetchAllPages(
			(filter, opts) => client.searchAuthorizations(filter, opts),
			{},
			undefined,
			limit,
		);

		return {
			kind: "list",
			items: items.map((a) => ({
				Key: a.authorizationKey ?? "",
				"Owner ID": a.ownerId ?? "",
				"Owner Type": a.ownerType ?? "",
				"Resource Type": a.resourceType ?? "",
				"Resource ID": a.resourceId ?? "",
				Permissions: Array.isArray(a.permissionTypes)
					? a.permissionTypes.join(", ")
					: "",
			})),
			emptyMessage: "No authorizations found",
		};
	},
);
/**
 * Search authorizations with filters
 */
export const searchIdentityAuthorizationsCommand = defineCommand(
	"search",
	"authorization",
	async (ctx, flags, _args) => {
		const { client, logger, profile, limit, sortBy, sortOrder } = ctx;

		const filter: Record<string, unknown> = {};
		if (flags.ownerId) filter.ownerId = flags.ownerId;
		if (flags.ownerType) filter.ownerType = flags.ownerType;
		if (flags.resourceType) filter.resourceType = flags.resourceType;
		if (flags.resourceId) filter.resourceIds = [flags.resourceId];

		const searchFilter = Object.keys(filter).length > 0 ? { filter } : {};

		const dr = dryRun({
			command: "search authorizations",
			method: "POST",
			endpoint: "/authorizations/search",
			profile,
			body: searchFilter,
		});
		if (dr) return dr;

		const items = await fetchAllPages(
			(f, opts) => client.searchAuthorizations(f, opts),
			searchFilter,
			undefined,
			limit,
		);

		if (items.length === 0) {
			logger.info("No authorizations found");
			return;
		}

		let tableData = items.map((a) => ({
			Key: a.authorizationKey ?? "",
			"Owner ID": a.ownerId ?? "",
			"Owner Type": a.ownerType ?? "",
			"Resource Type": a.resourceType ?? "",
			"Resource ID": a.resourceId ?? "",
			Permissions: Array.isArray(a.permissionTypes)
				? a.permissionTypes.join(", ")
				: "",
		}));
		tableData = sortTableData(tableData, sortBy, logger, sortOrder);
		logger.table(tableData);
	},
);

/**
 * Get a single authorization by key
 */
export const getIdentityAuthorizationCommand = defineCommand(
	"get",
	"authorization",
	async (ctx, _flags, args) => {
		const { client, profile } = ctx;
		const authorizationKey = args.authorizationKey;

		const dr = dryRun({
			command: "get authorization",
			method: "GET",
			endpoint: `/authorizations/${authorizationKey}`,
			profile,
		});
		if (dr) return dr;

		const result = await client.getAuthorization(
			{ authorizationKey },
			{ consistency: { waitUpToMs: 0 } },
		);
		return { kind: "get", data: result };
	},
);

/**
 * Validated inputs for creating an authorization.
 * All fields are guaranteed present and type-narrowed by
 * validateCreateAuthorizationOptions() before reaching the handler.
 */
export interface CreateAuthorizationInput {
	profile?: string;
	ownerId: string;
	ownerType: OwnerTypeEnum;
	resourceType: ResourceTypeEnum;
	resourceId: string;
	permissionTypes: PermissionTypeEnum[];
}

/**
 * Validate raw CLI options for the create authorization command.
 * Returns a fully validated and type-narrowed input object.
 * Exits with code 1 on invalid input.
 */
export function validateCreateAuthorizationOptions(options: {
	profile?: string;
	ownerId?: string;
	ownerType?: string;
	resourceType?: string;
	resourceId?: string;
	permissions?: string;
}): CreateAuthorizationInput {
	return {
		profile: options.profile,
		ownerId: requireOption(options.ownerId, "ownerId"),
		ownerType: requireEnum(
			requireOption(options.ownerType, "ownerType"),
			OwnerTypeValues,
			"ownerType",
		),
		resourceType: requireEnum(
			requireOption(options.resourceType, "resourceType"),
			ResourceTypeValues,
			"resourceType",
		),
		resourceId: requireOption(options.resourceId, "resourceId"),
		permissionTypes: requireCsvEnum(
			requireOption(options.permissions, "permissions"),
			PermissionTypeValues,
			"permissions",
		),
	};
}

/**
 * Create a new authorization
 */
export const createIdentityAuthorizationCommand = defineCommand(
	"create",
	"authorization",
	async (ctx, flags, _args) => {
		const { client, profile } = ctx;

		const validated = validateCreateAuthorizationOptions({
			profile,
			ownerId: flags.ownerId,
			ownerType: flags.ownerType,
			resourceType: flags.resourceType,
			resourceId: flags.resourceId,
			permissions: flags.permissions,
		});

		const body = {
			ownerId: validated.ownerId,
			ownerType: validated.ownerType,
			resourceType: validated.resourceType,
			resourceId: validated.resourceId,
			permissionTypes: validated.permissionTypes,
		};

		const dr = dryRun({
			command: "create authorization",
			method: "POST",
			endpoint: "/authorizations",
			profile,
			body,
		});
		if (dr) return dr;

		await client.createAuthorization(body);
		return { kind: "success", message: "Authorization created" };
	},
);

/**
 * Delete an authorization by key
 */
export const deleteIdentityAuthorizationCommand = defineCommand(
	"delete",
	"authorization",
	async (ctx, _flags, args) => {
		const { client, profile } = ctx;
		const authorizationKey = args.authorizationKey;

		const dr = dryRun({
			command: "delete authorization",
			method: "DELETE",
			endpoint: `/authorizations/${encodeURIComponent(String(authorizationKey))}`,
			profile,
			body: null,
		});
		if (dr) return dr;

		await client.deleteAuthorization({ authorizationKey });
		return {
			kind: "success",
			message: `Authorization '${authorizationKey}' deleted`,
		};
	},
);
