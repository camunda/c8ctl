/**
 * Identity authorization commands
 */

import {
	AuthorizationKey,
	type OwnerTypeEnum,
	OwnerTypeEnum as OwnerTypeValues,
	type PermissionTypeEnum,
	PermissionTypeEnum as PermissionTypeValues,
	type ResourceTypeEnum,
	ResourceTypeEnum as ResourceTypeValues,
} from "@camunda8/orchestration-cluster-api";
import { createClient, fetchAllPages } from "../client.ts";
import {
	requireCsvEnum,
	requireEnum,
	requireOption,
} from "../command-validation.ts";
import { resolveClusterConfig } from "../config.ts";
import { handleCommandError } from "../errors.ts";
import { getLogger, type SortOrder, sortTableData } from "../logger.ts";
import { c8ctl } from "../runtime.ts";

/**
 * List all authorizations
 */
export async function listAuthorizations(options: {
	profile?: string;
	sortBy?: string;
	sortOrder?: SortOrder;
	limit?: number;
}): Promise<void> {
	const logger = getLogger();
	const client = createClient(options.profile);

	try {
		const items = await fetchAllPages(
			(filter, opts) => client.searchAuthorizations(filter, opts),
			{},
			undefined,
			options.limit,
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
		tableData = sortTableData(
			tableData,
			options.sortBy,
			logger,
			options.sortOrder,
		);
		logger.table(tableData);
	} catch (error) {
		handleCommandError(logger, "Failed to list authorizations", error);
	}
}

/**
 * Search authorizations with filters
 */
export async function searchIdentityAuthorizations(options: {
	profile?: string;
	ownerId?: string;
	ownerType?: string;
	resourceType?: string;
	resourceId?: string;
	sortBy?: string;
	sortOrder?: SortOrder;
	limit?: number;
}): Promise<void> {
	const logger = getLogger();
	const client = createClient(options.profile);

	try {
		const filter: Record<string, unknown> = {};
		if (options.ownerId) filter.ownerId = options.ownerId;
		if (options.ownerType) filter.ownerType = options.ownerType;
		if (options.resourceType) filter.resourceType = options.resourceType;
		if (options.resourceId) filter.resourceIds = [options.resourceId];

		const searchFilter = Object.keys(filter).length > 0 ? { filter } : {};

		const items = await fetchAllPages(
			(f, opts) => client.searchAuthorizations(f, opts),
			searchFilter,
			undefined,
			options.limit,
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
		tableData = sortTableData(
			tableData,
			options.sortBy,
			logger,
			options.sortOrder,
		);
		logger.table(tableData);
	} catch (error) {
		handleCommandError(logger, "Failed to search authorizations", error);
	}
}

/**
 * Get a single authorization by key
 */
export async function getIdentityAuthorization(
	authorizationKey: string,
	options: {
		profile?: string;
	},
): Promise<void> {
	const logger = getLogger();
	const client = createClient(options.profile);

	try {
		const result = await client.getAuthorization(
			{ authorizationKey: AuthorizationKey.assumeExists(authorizationKey) },
			{ consistency: { waitUpToMs: 0 } },
		);
		logger.json(result);
	} catch (error) {
		handleCommandError(
			logger,
			`Failed to get authorization '${authorizationKey}'`,
			error,
		);
	}
}

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
export async function createIdentityAuthorization(
	options: CreateAuthorizationInput,
): Promise<void> {
	const logger = getLogger();

	const body = {
		ownerId: options.ownerId,
		ownerType: options.ownerType,
		resourceType: options.resourceType,
		resourceId: options.resourceId,
		permissionTypes: options.permissionTypes,
	};

	if (c8ctl.dryRun) {
		const config = resolveClusterConfig(options.profile);
		logger.json({
			dryRun: true,
			command: "create authorization",
			method: "POST",
			url: `${config.baseUrl}/authorizations`,
			body,
		});
		return;
	}

	const client = createClient(options.profile);

	try {
		await client.createAuthorization(body);
		logger.success("Authorization created");
	} catch (error) {
		handleCommandError(logger, "Failed to create authorization", error);
	}
}

/**
 * Delete an authorization by key
 */
export async function deleteIdentityAuthorization(
	authorizationKey: string,
	options: {
		profile?: string;
	},
): Promise<void> {
	const logger = getLogger();

	if (c8ctl.dryRun) {
		const config = resolveClusterConfig(options.profile);
		logger.json({
			dryRun: true,
			command: "delete authorization",
			method: "DELETE",
			url: `${config.baseUrl}/authorizations/${encodeURIComponent(String(authorizationKey))}`,
			body: null,
		});
		return;
	}

	const client = createClient(options.profile);

	try {
		await client.deleteAuthorization({
			authorizationKey: AuthorizationKey.assumeExists(authorizationKey),
		});
		logger.success(`Authorization '${authorizationKey}' deleted`);
	} catch (error) {
		handleCommandError(
			logger,
			`Failed to delete authorization '${authorizationKey}'`,
			error,
		);
	}
}
