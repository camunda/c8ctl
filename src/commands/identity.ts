/**
 * Identity shared helpers and assignment dispatcher
 */

import { TenantId, Username } from "@camunda8/orchestration-cluster-api";
import { createClient } from "../client.ts";
import { resolveClusterConfig } from "../config.ts";
import { handleCommandError } from "../errors.ts";
import { getLogger } from "../logger.ts";
import { c8ctl } from "../runtime.ts";

export {
	createIdentityAuthorization,
	deleteIdentityAuthorization,
	getIdentityAuthorization,
	listAuthorizations,
	searchIdentityAuthorizations,
} from "./identity-authorizations.ts";
export {
	createIdentityGroup,
	deleteIdentityGroup,
	getIdentityGroup,
	listGroups,
	searchIdentityGroups,
} from "./identity-groups.ts";
export {
	createIdentityMappingRule,
	deleteIdentityMappingRule,
	getIdentityMappingRule,
	listMappingRules,
	searchIdentityMappingRules,
} from "./identity-mapping-rules.ts";
export {
	createIdentityRole,
	deleteIdentityRole,
	getIdentityRole,
	listRoles,
	searchIdentityRoles,
} from "./identity-roles.ts";
export {
	createIdentityTenant,
	deleteIdentityTenant,
	getIdentityTenant,
	listTenants,
	searchIdentityTenants,
} from "./identity-tenants.ts";
// Re-exports
export {
	createIdentityUser,
	deleteIdentityUser,
	getIdentityUser,
	listUsers,
	searchIdentityUsers,
} from "./identity-users.ts";

type AssignTargetFlag =
	| "to-user"
	| "to-group"
	| "to-tenant"
	| "to-mapping-rule";
type UnassignSourceFlag =
	| "from-user"
	| "from-group"
	| "from-tenant"
	| "from-mapping-rule";

const ASSIGN_TARGET_FLAGS: readonly AssignTargetFlag[] = [
	"to-user",
	"to-group",
	"to-tenant",
	"to-mapping-rule",
];
const UNASSIGN_SOURCE_FLAGS: readonly UnassignSourceFlag[] = [
	"from-user",
	"from-group",
	"from-tenant",
	"from-mapping-rule",
];

/** Allowed --to-* flags per resource for assign */
const ALLOWED_ASSIGN_TARGETS: Record<string, readonly AssignTargetFlag[]> = {
	role: ["to-user", "to-group", "to-tenant", "to-mapping-rule"],
	user: ["to-group", "to-tenant"],
	group: ["to-tenant"],
	"mapping-rule": ["to-group", "to-tenant"],
};

/** Allowed --from-* flags per resource for unassign */
const ALLOWED_UNASSIGN_SOURCES: Record<string, readonly UnassignSourceFlag[]> =
	{
		role: ["from-user", "from-group", "from-tenant", "from-mapping-rule"],
		user: ["from-group", "from-tenant"],
		group: ["from-tenant"],
		"mapping-rule": ["from-group", "from-tenant"],
	};

/** Plural path segment for each resource */
const RESOURCE_PATHS: Record<string, string> = {
	user: "users",
	role: "roles",
	group: "groups",
	tenant: "tenants",
	authorization: "authorizations",
	"mapping-rule": "mapping-rules",
};

function formatFlags(flags: readonly string[]): string {
	return flags.map((f) => `--${f}`).join(", ");
}

/**
 * Handle assign command: c8 assign <resource> <id> --to-<target>=<targetId>
 */
export async function handleAssign(
	resource: string,
	id: string,
	values: Record<string, unknown>,
	options: { profile?: string },
): Promise<void> {
	const logger = getLogger();

	const allowedTargets = ALLOWED_ASSIGN_TARGETS[resource];
	if (!allowedTargets) {
		logger.error(
			`Cannot assign resource type: ${resource}. Supported: ${Object.keys(ALLOWED_ASSIGN_TARGETS).join(", ")}.`,
		);
		process.exit(1);
	}

	// Validate exactly one --to-* flag is provided
	const provided = ASSIGN_TARGET_FLAGS.filter((f) => values[f]);
	if (provided.length > 1) {
		logger.error(
			`Exactly one target flag is required. Conflicting flags: ${formatFlags(provided)}`,
		);
		process.exit(1);
	}
	if (provided.length === 0) {
		logger.error(`Target required. Use ${formatFlags(allowedTargets)}.`);
		process.exit(1);
	}

	const targetFlag = provided[0];
	if (!allowedTargets.includes(targetFlag)) {
		logger.error(
			`Unsupported target flag --${targetFlag} for resource '${resource}'. Use ${formatFlags(allowedTargets)}.`,
		);
		process.exit(1);
	}

	const targetValue = values[targetFlag];
	const resourcePath = RESOURCE_PATHS[resource];
	const targetPath = `${targetFlag.replace(/^to-/, "")}s`;

	if (c8ctl.dryRun) {
		const config = resolveClusterConfig(options.profile);
		logger.json({
			dryRun: true,
			command: "assign",
			method: "POST",
			url: `${config.baseUrl}/${resourcePath}/${encodeURIComponent(String(id))}/${targetPath}/${encodeURIComponent(String(targetValue))}`,
			body: null,
		});
		return;
	}

	const client = createClient(options.profile);

	try {
		switch (resource) {
			case "role": {
				if (values["to-user"]) {
					await client.assignRoleToUser({
						roleId: id,
						username: Username.assumeExists(String(values["to-user"])),
					});
					logger.success(
						`Role '${id}' assigned to user '${values["to-user"]}'`,
					);
				} else if (values["to-group"]) {
					await client.assignRoleToGroup({
						roleId: id,
						groupId: String(values["to-group"]),
					});
					logger.success(
						`Role '${id}' assigned to group '${values["to-group"]}'`,
					);
				} else if (values["to-tenant"]) {
					await client.assignRoleToTenant({
						tenantId: TenantId.assumeExists(String(values["to-tenant"])),
						roleId: id,
					});
					logger.success(
						`Role '${id}' assigned to tenant '${values["to-tenant"]}'`,
					);
				} else if (values["to-mapping-rule"]) {
					await client.assignRoleToMappingRule({
						roleId: id,
						mappingRuleId: String(values["to-mapping-rule"]),
					});
					logger.success(
						`Role '${id}' assigned to mapping rule '${values["to-mapping-rule"]}'`,
					);
				} else {
					logger.error(
						"Target required. Use --to-user, --to-group, --to-tenant, or --to-mapping-rule.",
					);
					process.exit(1);
				}
				break;
			}
			case "user": {
				if (values["to-group"]) {
					await client.assignUserToGroup({
						groupId: String(values["to-group"]),
						username: Username.assumeExists(id),
					});
					logger.success(
						`User '${id}' assigned to group '${values["to-group"]}'`,
					);
				} else if (values["to-tenant"]) {
					await client.assignUserToTenant({
						tenantId: TenantId.assumeExists(String(values["to-tenant"])),
						username: Username.assumeExists(id),
					});
					logger.success(
						`User '${id}' assigned to tenant '${values["to-tenant"]}'`,
					);
				} else {
					logger.error("Target required. Use --to-group or --to-tenant.");
					process.exit(1);
				}
				break;
			}
			case "group": {
				if (values["to-tenant"]) {
					await client.assignGroupToTenant({
						tenantId: TenantId.assumeExists(String(values["to-tenant"])),
						groupId: id,
					});
					logger.success(
						`Group '${id}' assigned to tenant '${values["to-tenant"]}'`,
					);
				} else {
					logger.error("Target required. Use --to-tenant.");
					process.exit(1);
				}
				break;
			}
			case "mapping-rule": {
				if (values["to-group"]) {
					await client.assignMappingRuleToGroup({
						groupId: String(values["to-group"]),
						mappingRuleId: id,
					});
					logger.success(
						`Mapping rule '${id}' assigned to group '${values["to-group"]}'`,
					);
				} else if (values["to-tenant"]) {
					await client.assignMappingRuleToTenant({
						tenantId: TenantId.assumeExists(String(values["to-tenant"])),
						mappingRuleId: id,
					});
					logger.success(
						`Mapping rule '${id}' assigned to tenant '${values["to-tenant"]}'`,
					);
				} else {
					logger.error("Target required. Use --to-group or --to-tenant.");
					process.exit(1);
				}
				break;
			}
			default:
				logger.error(
					`Cannot assign resource type: ${resource}. Supported: role, user, group, mapping-rule.`,
				);
				process.exit(1);
		}
	} catch (error) {
		handleCommandError(logger, `Failed to assign ${resource}`, error);
	}
}

/**
 * Handle unassign command: c8 unassign <resource> <id> --from-<target>=<targetId>
 */
export async function handleUnassign(
	resource: string,
	id: string,
	values: Record<string, unknown>,
	options: { profile?: string },
): Promise<void> {
	const logger = getLogger();

	const allowedSources = ALLOWED_UNASSIGN_SOURCES[resource];
	if (!allowedSources) {
		logger.error(
			`Cannot unassign resource type: ${resource}. Supported: ${Object.keys(ALLOWED_UNASSIGN_SOURCES).join(", ")}.`,
		);
		process.exit(1);
	}

	// Validate exactly one --from-* flag is provided
	const provided = UNASSIGN_SOURCE_FLAGS.filter((f) => values[f]);
	if (provided.length > 1) {
		logger.error(
			`Exactly one source flag is required. Conflicting flags: ${formatFlags(provided)}`,
		);
		process.exit(1);
	}
	if (provided.length === 0) {
		logger.error(`Source required. Use ${formatFlags(allowedSources)}.`);
		process.exit(1);
	}

	const sourceFlag = provided[0];
	if (!allowedSources.includes(sourceFlag)) {
		logger.error(
			`Unsupported source flag --${sourceFlag} for resource '${resource}'. Use ${formatFlags(allowedSources)}.`,
		);
		process.exit(1);
	}

	const sourceValue = values[sourceFlag];
	const resourcePath = RESOURCE_PATHS[resource];
	const sourcePath = `${sourceFlag.replace(/^from-/, "")}s`;

	if (c8ctl.dryRun) {
		const config = resolveClusterConfig(options.profile);
		logger.json({
			dryRun: true,
			command: "unassign",
			method: "DELETE",
			url: `${config.baseUrl}/${resourcePath}/${encodeURIComponent(String(id))}/${sourcePath}/${encodeURIComponent(String(sourceValue))}`,
			body: null,
		});
		return;
	}

	const client = createClient(options.profile);

	try {
		switch (resource) {
			case "role": {
				if (values["from-user"]) {
					await client.unassignRoleFromUser({
						roleId: id,
						username: Username.assumeExists(String(values["from-user"])),
					});
					logger.success(
						`Role '${id}' unassigned from user '${values["from-user"]}'`,
					);
				} else if (values["from-group"]) {
					await client.unassignRoleFromGroup({
						roleId: id,
						groupId: String(values["from-group"]),
					});
					logger.success(
						`Role '${id}' unassigned from group '${values["from-group"]}'`,
					);
				} else if (values["from-tenant"]) {
					await client.unassignRoleFromTenant({
						tenantId: TenantId.assumeExists(String(values["from-tenant"])),
						roleId: id,
					});
					logger.success(
						`Role '${id}' unassigned from tenant '${values["from-tenant"]}'`,
					);
				} else if (values["from-mapping-rule"]) {
					await client.unassignRoleFromMappingRule({
						roleId: id,
						mappingRuleId: String(values["from-mapping-rule"]),
					});
					logger.success(
						`Role '${id}' unassigned from mapping rule '${values["from-mapping-rule"]}'`,
					);
				} else {
					logger.error(
						"Source required. Use --from-user, --from-group, --from-tenant, or --from-mapping-rule.",
					);
					process.exit(1);
				}
				break;
			}
			case "user": {
				if (values["from-group"]) {
					await client.unassignUserFromGroup({
						groupId: String(values["from-group"]),
						username: Username.assumeExists(id),
					});
					logger.success(
						`User '${id}' unassigned from group '${values["from-group"]}'`,
					);
				} else if (values["from-tenant"]) {
					await client.unassignUserFromTenant({
						tenantId: TenantId.assumeExists(String(values["from-tenant"])),
						username: Username.assumeExists(id),
					});
					logger.success(
						`User '${id}' unassigned from tenant '${values["from-tenant"]}'`,
					);
				} else {
					logger.error("Source required. Use --from-group or --from-tenant.");
					process.exit(1);
				}
				break;
			}
			case "group": {
				if (values["from-tenant"]) {
					await client.unassignGroupFromTenant({
						tenantId: TenantId.assumeExists(String(values["from-tenant"])),
						groupId: id,
					});
					logger.success(
						`Group '${id}' unassigned from tenant '${values["from-tenant"]}'`,
					);
				} else {
					logger.error("Source required. Use --from-tenant.");
					process.exit(1);
				}
				break;
			}
			case "mapping-rule": {
				if (values["from-group"]) {
					await client.unassignMappingRuleFromGroup({
						groupId: String(values["from-group"]),
						mappingRuleId: id,
					});
					logger.success(
						`Mapping rule '${id}' unassigned from group '${values["from-group"]}'`,
					);
				} else if (values["from-tenant"]) {
					await client.unassignMappingRuleFromTenant({
						tenantId: TenantId.assumeExists(String(values["from-tenant"])),
						mappingRuleId: id,
					});
					logger.success(
						`Mapping rule '${id}' unassigned from tenant '${values["from-tenant"]}'`,
					);
				} else {
					logger.error("Source required. Use --from-group or --from-tenant.");
					process.exit(1);
				}
				break;
			}
			default:
				logger.error(
					`Cannot unassign resource type: ${resource}. Supported: role, user, group, mapping-rule.`,
				);
				process.exit(1);
		}
	} catch (error) {
		handleCommandError(logger, `Failed to unassign ${resource}`, error);
	}
}
