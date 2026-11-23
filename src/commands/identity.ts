/**
 * Identity shared helpers and assignment dispatcher
 */

import {
	type C8ctlContext,
	C8ctlError,
	type ClusterInput,
} from "../core/index.ts";
import {
	type CommandContext,
	type CommandResult,
	clusterInputOf,
	type DryRunRequest,
	defineCommand,
} from "../framework/index.ts";
import {
	assignGroup,
	assignGroupRequest,
	assignMappingRule,
	assignMappingRuleRequest,
	assignRole,
	assignRoleRequest,
	assignUser,
	assignUserRequest,
	unassignGroup,
	unassignGroupRequest,
	unassignMappingRule,
	unassignMappingRuleRequest,
	unassignRole,
	unassignRoleRequest,
	unassignUser,
	unassignUserRequest,
} from "../services/index.ts";

export {
	createIdentityAuthorizationCommand,
	deleteIdentityAuthorizationCommand,
	getIdentityAuthorizationCommand,
	listAuthorizationsCommand,
	searchIdentityAuthorizationsCommand,
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

function formatFlags(flags: readonly string[]): string {
	return flags.map((f) => `--${f}`).join(", ");
}

type Member = "user" | "group" | "tenant" | "mappingRule";

/** The service input field of each --to-* / --from-* flag. */
const FLAG_MEMBERS: Record<AssignTargetFlag | UnassignSourceFlag, Member> = {
	"to-user": "user",
	"to-group": "group",
	"to-tenant": "tenant",
	"to-mapping-rule": "mappingRule",
	"from-user": "user",
	"from-group": "group",
	"from-tenant": "tenant",
	"from-mapping-rule": "mappingRule",
};

const RESOURCE_LABELS: Record<string, string> = {
	role: "Role",
	user: "User",
	group: "Group",
	"mapping-rule": "Mapping rule",
};

const MEMBER_LABELS: Record<Member, string> = {
	user: "user",
	group: "group",
	tenant: "tenant",
	mappingRule: "mapping rule",
};

function invalidInput(message: string, field: string): C8ctlError {
	return new C8ctlError("invalid-input", message, { field });
}

/**
 * Run the assign or unassign call of a resource: `--dry-run` shows
 * the request, otherwise the service runs. Returns the dry-run result,
 * or null when the service ran.
 */
async function runAssignment(
	ctx: CommandContext,
	verb: "assign" | "unassign",
	resource: string,
	id: string,
	member: Member,
	memberId: string,
): Promise<CommandResult | null> {
	const members: Partial<Record<Member, string>> = { [member]: memberId };
	async function run<I extends object>(
		input: I,
		request: (input: I) => DryRunRequest,
		service: (input: I & ClusterInput, ctx: C8ctlContext) => Promise<unknown>,
	): Promise<CommandResult | null> {
		const dr = ctx.dryRun({
			command: verb,
			profile: ctx.profile,
			...request(input),
		});
		if (dr) return dr;
		await service({ ...input, ...clusterInputOf(ctx) }, {});
		return null;
	}
	const assign = verb === "assign";
	switch (resource) {
		case "role": {
			const input = { roleId: id, ...members };
			return assign
				? run(input, assignRoleRequest, assignRole)
				: run(input, unassignRoleRequest, unassignRole);
		}
		case "user": {
			const input = { username: id, ...members };
			return assign
				? run(input, assignUserRequest, assignUser)
				: run(input, unassignUserRequest, unassignUser);
		}
		case "group": {
			const input = { groupId: id, ...members };
			return assign
				? run(input, assignGroupRequest, assignGroup)
				: run(input, unassignGroupRequest, unassignGroup);
		}
		default: {
			const input = { mappingRuleId: id, ...members };
			return assign
				? run(input, assignMappingRuleRequest, assignMappingRule)
				: run(input, unassignMappingRuleRequest, unassignMappingRule);
		}
	}
}

/**
 * Core assign implementation.
 *
 * Called from per-resource `defineCommand` wrappers below. All validation
 * errors are raised via `throw` so the framework wrapper can route them
 * through `handleCommandError` and add the `Failed to assign <resource>`
 * prefix. Do NOT reintroduce `process.exit` — the architectural guard in
 * `tests/unit/no-process-exit-in-handlers.test.ts` will reject it.
 */
async function handleAssign(
	ctx: CommandContext,
	resource: string,
	id: string,
	values: Record<string, unknown>,
): Promise<CommandResult> {
	const allowedTargets = ALLOWED_ASSIGN_TARGETS[resource];
	if (!allowedTargets) {
		throw invalidInput(
			`Cannot assign resource type: ${resource}. Supported: ${Object.keys(ALLOWED_ASSIGN_TARGETS).join(", ")}.`,
			"resource",
		);
	}

	// Validate exactly one --to-* flag is provided
	const provided = ASSIGN_TARGET_FLAGS.filter((f) => values[f]);
	if (provided.length > 1) {
		throw invalidInput(
			`Exactly one target flag is required. Conflicting flags: ${formatFlags(provided)}`,
			provided[0],
		);
	}
	if (provided.length === 0) {
		throw invalidInput(
			`Target required. Use ${formatFlags(allowedTargets)}.`,
			allowedTargets[0],
		);
	}

	const targetFlag = provided[0];
	if (!allowedTargets.includes(targetFlag)) {
		throw invalidInput(
			`Unsupported target flag --${targetFlag} for resource '${resource}'. Use ${formatFlags(allowedTargets)}.`,
			targetFlag,
		);
	}

	const member = FLAG_MEMBERS[targetFlag];
	const targetValue = String(values[targetFlag]);
	const dr = await runAssignment(
		ctx,
		"assign",
		resource,
		id,
		member,
		targetValue,
	);
	if (dr) return dr;
	return {
		kind: "success",
		message: `${RESOURCE_LABELS[resource]} '${id}' assigned to ${MEMBER_LABELS[member]} '${targetValue}'`,
	};
}

/**
 * Core unassign implementation. See `handleAssign` docstring for the
 * error-handling contract (throw, do not `process.exit`).
 */
async function handleUnassign(
	ctx: CommandContext,
	resource: string,
	id: string,
	values: Record<string, unknown>,
): Promise<CommandResult> {
	const allowedSources = ALLOWED_UNASSIGN_SOURCES[resource];
	if (!allowedSources) {
		throw invalidInput(
			`Cannot unassign resource type: ${resource}. Supported: ${Object.keys(ALLOWED_UNASSIGN_SOURCES).join(", ")}.`,
			"resource",
		);
	}

	// Validate exactly one --from-* flag is provided
	const provided = UNASSIGN_SOURCE_FLAGS.filter((f) => values[f]);
	if (provided.length > 1) {
		throw invalidInput(
			`Exactly one source flag is required. Conflicting flags: ${formatFlags(provided)}`,
			provided[0],
		);
	}
	if (provided.length === 0) {
		throw invalidInput(
			`Source required. Use ${formatFlags(allowedSources)}.`,
			allowedSources[0],
		);
	}

	const sourceFlag = provided[0];
	if (!allowedSources.includes(sourceFlag)) {
		throw invalidInput(
			`Unsupported source flag --${sourceFlag} for resource '${resource}'. Use ${formatFlags(allowedSources)}.`,
			sourceFlag,
		);
	}

	const member = FLAG_MEMBERS[sourceFlag];
	const sourceValue = String(values[sourceFlag]);
	const dr = await runAssignment(
		ctx,
		"unassign",
		resource,
		id,
		member,
		sourceValue,
	);
	if (dr) return dr;
	return {
		kind: "success",
		message: `${RESOURCE_LABELS[resource]} '${id}' unassigned from ${MEMBER_LABELS[member]} '${sourceValue}'`,
	};
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
		throw invalidInput(
			`ID required. Usage: c8 ${verb} ${resource} <id> ${targetFlag}<target>=<targetId>`,
			"id",
		);
	}
	return id;
}

function makeAssignCommand<
	R extends "role" | "user" | "group" | "mapping-rule",
>(resource: R) {
	return defineCommand("assign", resource, async (ctx, flags) => {
		const id = requireId("assign", resource, ctx.positionals);
		return handleAssign(ctx, resource, id, { ...flags });
	});
}

function makeUnassignCommand<
	R extends "role" | "user" | "group" | "mapping-rule",
>(resource: R) {
	return defineCommand("unassign", resource, async (ctx, flags) => {
		const id = requireId("unassign", resource, ctx.positionals);
		return handleUnassign(ctx, resource, id, { ...flags });
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
		return handleAssign(ctx, ctx.resource, id, { ...flags });
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
		return handleUnassign(ctx, ctx.resource, id, { ...flags });
	},
);
