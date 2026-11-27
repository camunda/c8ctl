/**
 * Identity authorization commands — CLI bindings of the authorization
 * services.
 */

import {
	OwnerTypeEnum as OwnerTypeValues,
	PermissionTypeEnum as PermissionTypeValues,
	ResourceTypeEnum as ResourceTypeValues,
} from "@camunda8/orchestration-cluster-api";
import {
	defineServiceCommand,
	requireCsvEnum,
	requireEnum,
	requireOption,
} from "../framework/index.ts";
import {
	type CreateAuthorizationInput,
	createAuthorization,
	createAuthorizationRequest,
	deleteAuthorization,
	deleteAuthorizationRequest,
	getAuthorization,
	getAuthorizationRequest,
	listAuthorizations,
	listAuthorizationsRequest,
	searchAuthorizations,
	searchAuthorizationsRequest,
} from "../services/index.ts";

/** Table row of an authorization. */
function row(a: {
	authorizationKey?: string | null;
	ownerId?: string | null;
	ownerType?: string | null;
	resourceType?: string | null;
	resourceId?: string | null;
	permissionTypes?: readonly string[] | null;
}) {
	return {
		Key: a.authorizationKey ?? "",
		"Owner ID": a.ownerId ?? "",
		"Owner Type": a.ownerType ?? "",
		"Resource Type": a.resourceType ?? "",
		"Resource ID": a.resourceId ?? "",
		Permissions: Array.isArray(a.permissionTypes)
			? a.permissionTypes.join(", ")
			: "",
	};
}

/**
 * List all authorizations
 */
export const listAuthorizationsCommand = defineServiceCommand(
	"list",
	"authorization",
	{
		toInput: (_flags, _args, scope) => ({ limit: scope.limit }),
		dryRun: {
			command: "list authorizations",
			request: listAuthorizationsRequest,
		},
		service: listAuthorizations,
		render: ({ items }) => ({
			kind: "list",
			items: items.map(row),
			emptyMessage: "No authorizations found",
		}),
	},
);

/**
 * Search authorizations with filters
 */
export const searchIdentityAuthorizationsCommand = defineServiceCommand(
	"search",
	"authorization",
	{
		toInput: (flags, _args, scope) => ({
			ownerId: flags.ownerId,
			ownerType: flags.ownerType,
			resourceType: flags.resourceType,
			resourceId: flags.resourceId,
			own: flags.own,
			limit: scope.limit,
		}),
		dryRun: {
			command: "search authorizations",
			request: searchAuthorizationsRequest,
		},
		service: searchAuthorizations,
		render: ({ items, authorizationsEnabled }) => ({
			kind: "list",
			items: items.map(row),
			emptyMessage:
				authorizationsEnabled === false
					? "Authorizations are disabled on this cluster: every request is allowed"
					: "No authorizations found",
		}),
	},
);

/**
 * Get a single authorization by key
 */
export const getIdentityAuthorizationCommand = defineServiceCommand(
	"get",
	"authorization",
	{
		toInput: (_flags, args) => ({ authorizationKey: args.authorizationKey }),
		dryRun: {
			command: "get authorization",
			request: getAuthorizationRequest,
		},
		service: getAuthorization,
		render: (authorization) => ({ kind: "get", data: authorization }),
	},
);

/**
 * Validate raw CLI options for the create authorization command.
 * Returns a fully validated and type-narrowed input object.
 * Exits with code 1 on invalid input.
 */
function validateCreateAuthorizationOptions(options: {
	ownerId?: string;
	ownerType?: string;
	resourceType?: string;
	resourceId?: string;
	permissions?: string;
}): CreateAuthorizationInput {
	return {
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
export const createIdentityAuthorizationCommand = defineServiceCommand(
	"create",
	"authorization",
	{
		toInput: (flags) =>
			validateCreateAuthorizationOptions({
				ownerId: flags.ownerId,
				ownerType: flags.ownerType,
				resourceType: flags.resourceType,
				resourceId: flags.resourceId,
				permissions: flags.permissions,
			}),
		dryRun: {
			command: "create authorization",
			request: createAuthorizationRequest,
		},
		service: createAuthorization,
		render: () => ({ kind: "success", message: "Authorization created" }),
	},
);

/**
 * Delete an authorization by key
 */
export const deleteIdentityAuthorizationCommand = defineServiceCommand(
	"delete",
	"authorization",
	{
		toInput: (_flags, args) => ({ authorizationKey: args.authorizationKey }),
		dryRun: {
			command: "delete authorization",
			request: deleteAuthorizationRequest,
		},
		service: deleteAuthorization,
		render: ({ authorizationKey }) => ({
			kind: "success",
			message: `Authorization '${authorizationKey}' deleted`,
		}),
	},
);
