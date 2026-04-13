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

function isOwnerType(value: string): value is OwnerTypeEnum {
	const values: readonly string[] = Object.values(OwnerTypeValues);
	return values.includes(value);
}

function isResourceType(value: string): value is ResourceTypeEnum {
	const values: readonly string[] = Object.values(ResourceTypeValues);
	return values.includes(value);
}

function isPermissionType(value: string): value is PermissionTypeEnum {
	const values: readonly string[] = Object.values(PermissionTypeValues);
	return values.includes(value);
}

import { createClient, fetchAllPages } from "../client.ts";
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
 * Create a new authorization
 */
export async function createIdentityAuthorization(options: {
	profile?: string;
	ownerId?: string;
	ownerType?: string;
	resourceType?: string;
	resourceId?: string;
	permissions?: string;
}): Promise<void> {
	const logger = getLogger();

	if (!options.ownerId) {
		logger.error("--ownerId is required");
		process.exit(1);
	}
	if (!options.ownerType) {
		logger.error("--ownerType is required");
		process.exit(1);
	}
	const ownerTypeValues: readonly string[] = Object.values(OwnerTypeValues);
	if (!isOwnerType(options.ownerType)) {
		logger.error(
			`Invalid --ownerType "${options.ownerType}". Valid values: ${ownerTypeValues.join(", ")}`,
		);
		process.exit(1);
	}

	if (!options.resourceType) {
		logger.error("--resourceType is required");
		process.exit(1);
	}
	const resourceTypeValues: readonly string[] =
		Object.values(ResourceTypeValues);
	if (!isResourceType(options.resourceType)) {
		logger.error(
			`Invalid --resourceType "${options.resourceType}". Valid values: ${resourceTypeValues.join(", ")}`,
		);
		process.exit(1);
	}

	if (!options.resourceId) {
		logger.error("--resourceId is required");
		process.exit(1);
	}
	if (!options.permissions) {
		logger.error("--permissions is required");
		process.exit(1);
	}

	const permissionTypeValues: readonly string[] =
		Object.values(PermissionTypeValues);
	const rawPermissions = options.permissions
		.split(",")
		.map((p) => p.trim())
		.filter((p) => p.length > 0);
	const invalidPermissions = rawPermissions.filter((p) => !isPermissionType(p));
	if (invalidPermissions.length > 0) {
		logger.error(
			`Invalid --permissions: ${invalidPermissions.join(", ")}. Valid values: ${permissionTypeValues.join(", ")}`,
		);
		process.exit(1);
	}
	const permissionTypes = rawPermissions.filter(isPermissionType);

	const body = {
		ownerId: options.ownerId,
		ownerType: options.ownerType,
		resourceType: options.resourceType,
		resourceId: options.resourceId,
		permissionTypes,
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
