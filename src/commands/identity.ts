/**
 * Identity shared helpers and assignment dispatcher
 */

import { TenantId, Username } from "@camunda8/orchestration-cluster-api";
import { createClient } from "../client.ts";
import { defineCommand } from "../command-framework.ts";
import { resolveClusterConfig } from "../config.ts";
import { getLogger } from "../logger.ts";
import { c8ctl } from "../runtime.ts";

export {
	createIdentityAuthorizationCommand,
	deleteIdentityAuthorizationCommand,
	getIdentityAuthorizationCommand,
	listAuthorizationsCommand,
	searchIdentityAuthorizationsCommand,
	validateCreateAuthorizationOptions,
} from "./identity-authorizations.ts";
export {
	createIdentityGroupCommand,
	deleteIdentityGroupCommand,
	getIdentityGroupCommand,
	listGroupsCommand,
	searchIdentityGroupsCommand,
} from "./identity-groups.ts";
export {
	createIdentityMappingRuleCommand,
	deleteIdentityMappingRuleCommand,
	getIdentityMappingRuleCommand,
	listMappingRulesCommand,
	searchIdentityMappingRulesCommand,
} from "./identity-mapping-rules.ts";
export {
	createIdentityRoleCommand,
	deleteIdentityRoleCommand,
	getIdentityRoleCommand,
	listRolesCommand,
	searchIdentityRolesCommand,
} from "./identity-roles.ts";
export {
	createIdentityTenantCommand,
	deleteIdentityTenantCommand,
	getIdentityTenantCommand,
	listTenantsCommand,
	searchIdentityTenantsCommand,
} from "./identity-tenants.ts";
export {
	createIdentityUserCommand,
	deleteIdentityUserCommand,
	getIdentityUserCommand,
	listUsersCommand,
	searchIdentityUsersCommand,
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
 * Core assign implementation.
 *
 * Called from per-resource `defineCommand` wrappers below and exercised
 * directly by `tests/unit/identity.test.ts`. All validation errors are
 * raised via `throw` so the framework wrapper can route them through
 * `handleCommandError` and add the `Failed to assign <resource>` prefix.
 * Do NOT reintroduce `process.exit` — the architectural guard in
 * `tests/unit/no-process-exit-in-handlers.test.ts` will reject it.
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
		throw new Error(
			`Cannot assign resource type: ${resource}. Supported: ${Object.keys(ALLOWED_ASSIGN_TARGETS).join(", ")}.`,
		);
	}

	// Validate exactly one --to-* flag is provided
	const provided = ASSIGN_TARGET_FLAGS.filter((f) => values[f]);
	if (provided.length > 1) {
		throw new Error(
			`Exactly one target flag is required. Conflicting flags: ${formatFlags(provided)}`,
		);
	}
	if (provided.length === 0) {
		throw new Error(`Target required. Use ${formatFlags(allowedTargets)}.`);
	}

	const targetFlag = provided[0];
	if (!allowedTargets.includes(targetFlag)) {
		throw new Error(
			`Unsupported target flag --${targetFlag} for resource '${resource}'. Use ${formatFlags(allowedTargets)}.`,
		);
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

	switch (resource) {
		case "role": {
			if (values["to-user"]) {
				await client.assignRoleToUser({
					roleId: id,
					username: Username.assumeExists(String(values["to-user"])),
				});
				logger.success(`Role '${id}' assigned to user '${values["to-user"]}'`);
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
				throw new Error(
					"Target required. Use --to-user, --to-group, --to-tenant, or --to-mapping-rule.",
				);
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
				throw new Error("Target required. Use --to-group or --to-tenant.");
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
				throw new Error("Target required. Use --to-tenant.");
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
				throw new Error("Target required. Use --to-group or --to-tenant.");
			}
			break;
		}
		default:
			throw new Error(
				`Cannot assign resource type: ${resource}. Supported: role, user, group, mapping-rule.`,
			);
	}
}

/**
 * Core unassign implementation. See `handleAssign` docstring for the
 * error-handling contract (throw, do not `process.exit`).
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
		throw new Error(
			`Cannot unassign resource type: ${resource}. Supported: ${Object.keys(ALLOWED_UNASSIGN_SOURCES).join(", ")}.`,
		);
	}

	// Validate exactly one --from-* flag is provided
	const provided = UNASSIGN_SOURCE_FLAGS.filter((f) => values[f]);
	if (provided.length > 1) {
		throw new Error(
			`Exactly one source flag is required. Conflicting flags: ${formatFlags(provided)}`,
		);
	}
	if (provided.length === 0) {
		throw new Error(`Source required. Use ${formatFlags(allowedSources)}.`);
	}

	const sourceFlag = provided[0];
	if (!allowedSources.includes(sourceFlag)) {
		throw new Error(
			`Unsupported source flag --${sourceFlag} for resource '${resource}'. Use ${formatFlags(allowedSources)}.`,
		);
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
				throw new Error(
					"Source required. Use --from-user, --from-group, --from-tenant, or --from-mapping-rule.",
				);
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
				throw new Error("Source required. Use --from-group or --from-tenant.");
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
				throw new Error("Source required. Use --from-tenant.");
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
				throw new Error("Source required. Use --from-group or --from-tenant.");
			}
			break;
		}
		default:
			throw new Error(
				`Cannot unassign resource type: ${resource}. Supported: role, user, group, mapping-rule.`,
			);
	}
}

// ─── Per-resource defineCommand wrappers ─────────────────────────────────

/** Require a positional id; throw with a registry-aligned usage hint. */
function requireId(
	verb: "assign" | "unassign",
	resource: string,
	args: readonly string[],
): string {
	const id = args[0];
	if (!id) {
		const targetFlag = verb === "assign" ? "--to-" : "--from-";
		throw new Error(
			`ID required. Usage: c8 ${verb} ${resource} <id> ${targetFlag}<target>=<targetId>`,
		);
	}
	return id;
}

function makeAssignCommand<
	R extends "role" | "user" | "group" | "mapping-rule",
>(resource: R) {
	return defineCommand("assign", resource, async (ctx, flags) => {
		const id = requireId("assign", resource, ctx.positionals);
		await handleAssign(
			resource,
			id,
			{ ...flags },
			{
				profile: ctx.profile,
			},
		);
		return undefined;
	});
}

function makeUnassignCommand<
	R extends "role" | "user" | "group" | "mapping-rule",
>(resource: R) {
	return defineCommand("unassign", resource, async (ctx, flags) => {
		const id = requireId("unassign", resource, ctx.positionals);
		await handleUnassign(
			resource,
			id,
			{ ...flags },
			{
				profile: ctx.profile,
			},
		);
		return undefined;
	});
}

export const assignRoleCommand = makeAssignCommand("role");
export const assignUserCommand = makeAssignCommand("user");
export const assignGroupCommand = makeAssignCommand("group");
export const assignMappingRuleCommand = makeAssignCommand("mapping-rule");
export const unassignRoleCommand = makeUnassignCommand("role");
export const unassignUserCommand = makeUnassignCommand("user");
export const unassignGroupCommand = makeUnassignCommand("group");
export const unassignMappingRuleCommand = makeUnassignCommand("mapping-rule");

/**
 * Fallback handlers for unknown resource names (`c8 assign foo ...`).
 *
 * The registry-driven dispatch in `src/index.ts` looks up `assign:<resource>`
 * first and then falls back to `assign:`. Without these fallbacks the CLI
 * would print a generic "Unknown command" error for unknown resources and
 * skip the `handleAssign`-level validation that produces the canonical
 * "Cannot assign resource type: <resource>" message.
 */
export const assignFallbackCommand = defineCommand(
	"assign",
	"",
	async (ctx, flags) => {
		const id = requireId(
			"assign",
			ctx.resource || "<resource>",
			ctx.positionals,
		);
		await handleAssign(
			ctx.resource,
			id,
			{ ...flags },
			{
				profile: ctx.profile,
			},
		);
		return undefined;
	},
);

export const unassignFallbackCommand = defineCommand(
	"unassign",
	"",
	async (ctx, flags) => {
		const id = requireId(
			"unassign",
			ctx.resource || "<resource>",
			ctx.positionals,
		);
		await handleUnassign(
			ctx.resource,
			id,
			{ ...flags },
			{
				profile: ctx.profile,
			},
		);
		return undefined;
	},
);
