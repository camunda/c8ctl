/**
 * Structural invariant tests for the command registry.
 *
 * These tests verify that the COMMAND_REGISTRY is complete and consistent
 * with the existing metadata sources (help.ts, completion.ts, index.ts,
 * search.ts). They catch drift between the registry and the rest of the
 * codebase.
 */

import { test, describe } from "node:test";
import assert from "node:assert";
import {
	COMMAND_REGISTRY,
	RESOURCE_ALIASES,
	GLOBAL_FLAGS,
	SEARCH_FLAGS,
	VERB_ALIASES,
	resolveAlias,
	getCommandDef,
	getAcceptedFlags,
	deriveParseArgsOptions,
	isValidCommand,
} from "../../src/command-registry.ts";

// ─── Registry completeness ──────────────────────────────────────────────────

describe("COMMAND_REGISTRY completeness", () => {
	const EXPECTED_VERBS = [
		"list",
		"search",
		"get",
		"create",
		"delete",
		"cancel",
		"await",
		"complete",
		"fail",
		"activate",
		"resolve",
		"publish",
		"correlate",
		"deploy",
		"run",
		"watch",
		"open",
		"add",
		"remove",
		"load",
		"unload",
		"upgrade",
		"downgrade",
		"sync",
		"init",
		"use",
		"output",
		"completion",
		"mcp-proxy",
		"feedback",
		"help",
		"assign",
		"unassign",
		"which",
	];

	test("every expected verb has a registry entry", () => {
		for (const verb of EXPECTED_VERBS) {
			assert.ok(
				COMMAND_REGISTRY[verb],
				`Missing registry entry for verb "${verb}"`,
			);
		}
	});

	test("registry contains no unexpected verbs", () => {
		const registryVerbs = Object.keys(COMMAND_REGISTRY);
		for (const verb of registryVerbs) {
			assert.ok(
				EXPECTED_VERBS.includes(verb),
				`Unexpected verb "${verb}" in registry`,
			);
		}
	});

	test("every command has required metadata fields", () => {
		for (const [verb, def] of Object.entries(COMMAND_REGISTRY)) {
			assert.ok(
				typeof def.description === "string" && def.description.length > 0,
				`${verb}: missing description`,
			);
			assert.ok(
				typeof def.mutating === "boolean",
				`${verb}: missing mutating`,
			);
			assert.ok(
				typeof def.requiresResource === "boolean",
				`${verb}: missing requiresResource`,
			);
			assert.ok(
				Array.isArray(def.resources),
				`${verb}: missing resources array`,
			);
			assert.ok(
				typeof def.flags === "object" && def.flags !== null,
				`${verb}: missing flags object`,
			);
		}
	});

	test("commands requiring a resource have at least one resource (unless free-form)", () => {
		// Some verbs require a positional arg but accept free-form input (e.g. file path)
		// rather than a fixed set of resource names.
		const FREE_FORM_POSITIONAL = new Set(["run"]);
		for (const [verb, def] of Object.entries(COMMAND_REGISTRY)) {
			if (def.requiresResource && !FREE_FORM_POSITIONAL.has(verb)) {
				assert.ok(
					def.resources.length > 0,
					`${verb}: requiresResource=true but resources array is empty`,
				);
			}
		}
	});

	test("verb aliases point to existing registry entries", () => {
		for (const [verb, def] of Object.entries(COMMAND_REGISTRY)) {
			for (const alias of def.aliases ?? []) {
				assert.ok(
					typeof alias === "string" && alias.length > 0,
					`${verb}: alias must be a non-empty string`,
				);
				assert.ok(
					!COMMAND_REGISTRY[alias],
					`${verb}: alias "${alias}" conflicts with an existing verb entry`,
				);
			}
		}
	});

	test("VERB_ALIASES is consistent with registry aliases fields", () => {
		// Every alias in VERB_ALIASES should trace back to a registry entry
		for (const [alias, targets] of Object.entries(VERB_ALIASES)) {
			for (const target of targets) {
				assert.ok(
					COMMAND_REGISTRY[target],
					`VERB_ALIASES["${alias}"] points to "${target}" which is not in COMMAND_REGISTRY`,
				);
				assert.ok(
					COMMAND_REGISTRY[target].aliases?.includes(alias),
					`VERB_ALIASES["${alias}"] → "${target}" but ${target}.aliases does not include "${alias}"`,
				);
			}
		}
	});
});

// ─── Resource aliases ────────────────────────────────────────────────────────

describe("RESOURCE_ALIASES consistency", () => {
	test("all known short aliases resolve correctly", () => {
		const expected: Record<string, string> = {
			pi: "process-instance",
			pd: "process-definition",
			ut: "user-task",
			inc: "incident",
			msg: "message",
			vars: "variable",
			auth: "authorization",
			mr: "mapping-rule",
		};

		for (const [alias, canonical] of Object.entries(expected)) {
			assert.strictEqual(
				resolveAlias(alias),
				canonical,
				`Alias "${alias}" should resolve to "${canonical}"`,
			);
		}
	});

	test("plural forms resolve to singular", () => {
		assert.strictEqual(resolveAlias("profiles"), "profile");
		assert.strictEqual(resolveAlias("plugins"), "plugin");
		assert.strictEqual(resolveAlias("users"), "user");
		assert.strictEqual(resolveAlias("roles"), "role");
		assert.strictEqual(resolveAlias("groups"), "group");
		assert.strictEqual(resolveAlias("tenants"), "tenant");
		assert.strictEqual(resolveAlias("authorizations"), "authorization");
		assert.strictEqual(resolveAlias("mapping-rules"), "mapping-rule");
	});

	test("unknown resources pass through unchanged", () => {
		assert.strictEqual(resolveAlias("topology"), "topology");
		assert.strictEqual(resolveAlias("form"), "form");
		assert.strictEqual(resolveAlias("nonexistent"), "nonexistent");
	});
});

// ─── Search resource flags ───────────────────────────────────────────────────

describe("search resourceFlags consistency", () => {
	const resourceFlags = COMMAND_REGISTRY.search.resourceFlags;
	const EXPECTED_SEARCH_RESOURCES = [
		"process-definition",
		"process-instance",
		"user-task",
		"incident",
		"jobs",
		"variable",
		"user",
		"role",
		"group",
		"tenant",
		"authorization",
		"mapping-rule",
	];

	test("every searchable resource has a flag set", () => {
		for (const resource of EXPECTED_SEARCH_RESOURCES) {
			assert.ok(
				resourceFlags[resource],
				`Missing resourceFlags entry for "${resource}"`,
			);
		}
	});

	test("every flag set is a non-empty object", () => {
		for (const [resource, flags] of Object.entries(resourceFlags)) {
			assert.ok(
				Object.keys(flags).length > 0,
				`${resource}: flags should not be empty`,
			);
		}
	});

	test("search resources match the search command resources", () => {
		const searchDef = COMMAND_REGISTRY.search;
		assert.ok(searchDef, "search command must exist");

		// Every resourceFlags key should be reachable from the
		// search command's resources list (after alias resolution).
		for (const resource of Object.keys(resourceFlags)) {
			const reachable = searchDef.resources.some(
				(r) => resolveAlias(r) === resource || r === resource,
			);
			assert.ok(
				reachable,
				`resourceFlags has "${resource}" but it's not reachable from search.resources`,
			);
		}
	});
});

// ─── Global flags ────────────────────────────────────────────────────────────

describe("GLOBAL_FLAGS", () => {
	test("includes required infrastructure flags", () => {
		const required = ["help", "version", "profile", "dry-run", "verbose"];
		for (const flag of required) {
			assert.ok(GLOBAL_FLAGS[flag], `Missing global flag "${flag}"`);
		}
	});

	test("help has short alias -h", () => {
		assert.strictEqual(GLOBAL_FLAGS.help.short, "h");
	});

	test("version has short alias -v", () => {
		assert.strictEqual(GLOBAL_FLAGS.version.short, "v");
	});
});

// ─── Search flags ────────────────────────────────────────────────────────────

describe("SEARCH_FLAGS", () => {
	test("includes shared search flags", () => {
		const expected = ["sortBy", "asc", "desc", "limit", "between", "dateField"];
		for (const flag of expected) {
			assert.ok(SEARCH_FLAGS[flag], `Missing search flag "${flag}"`);
		}
	});
});

// ─── Helper functions ────────────────────────────────────────────────────────

describe("helper functions", () => {
	test("getCommandDef returns definition for known verbs", () => {
		const def = getCommandDef("list");
		assert.ok(def);
		assert.strictEqual(def.description, "List resources (process, identity)");
	});

	test("getCommandDef resolves verb aliases", () => {
		const def = getCommandDef("w");
		assert.ok(def);
		assert.strictEqual(def.description, "Watch files for changes and auto-deploy");
		const rmDef = getCommandDef("rm");
		assert.ok(rmDef);
	});

	test("getCommandDef returns undefined for unknown verbs", () => {
		assert.strictEqual(getCommandDef("nonexistent"), undefined);
	});

	test("getAcceptedFlags includes global + command flags", () => {
		const flags = getAcceptedFlags("create");
		assert.ok(flags);
		// Global flags present
		assert.ok(flags.help, "should include global flag 'help'");
		assert.ok(flags.profile, "should include global flag 'profile'");
		// Command-specific flags present
		assert.ok(flags.variables, "should include command flag 'variables'");
		assert.ok(flags.ownerId, "should include command flag 'ownerId'");
	});

	test("isValidCommand validates known verb×resource pairs", () => {
		assert.ok(isValidCommand("list", "pi"));
		assert.ok(isValidCommand("search", "vars"));
		assert.ok(isValidCommand("create", "pi"));
		assert.ok(isValidCommand("delete", "user"));
		assert.ok(isValidCommand("deploy", "")); // no resource required
	});

	test("isValidCommand accepts canonical resource names", () => {
		assert.ok(isValidCommand("list", "process-instance"));
		assert.ok(isValidCommand("search", "variable"));
		assert.ok(isValidCommand("get", "process-definition"));
	});

	test("isValidCommand works with verb aliases", () => {
		assert.ok(isValidCommand("w", "")); // w → watch, no resource required
		assert.ok(isValidCommand("rm", "profile")); // rm → remove
	});

	test("isValidCommand rejects invalid pairs", () => {
		assert.ok(!isValidCommand("nonexistent", "pi"));
		assert.ok(!isValidCommand("cancel", "user")); // cancel only supports pi
		assert.ok(!isValidCommand("fail", "pi")); // fail only supports job
	});

	test("deriveParseArgsOptions produces flat options for parseArgs", () => {
		const options = deriveParseArgsOptions();
		// Global flags
		assert.ok(options.help);
		assert.strictEqual(options.help.type, "boolean");
		assert.strictEqual(options.help.short, "h");
		// Search flags
		assert.ok(options.sortBy);
		assert.strictEqual(options.sortBy.type, "string");
		// Command-specific flags
		assert.ok(options.variables);
		assert.ok(options.ownerId);
		assert.ok(options["dry-run"]);
	});

	test("deriveParseArgsOptions covers all flags from parseArgs", () => {
		const options = deriveParseArgsOptions();
		// Spot-check flags that must be present for backward compatibility
		const mustExist = [
			"help",
			"version",
			"profile",
			"all",
			"xml",
			"bpmnProcessId",
			"id",
			"processDefinitionId",
			"processInstanceKey",
			"processDefinitionKey",
			"parentProcessInstanceKey",
			"variables",
			"state",
			"assignee",
			"type",
			"correlationKey",
			"timeToLive",
			"maxJobsToActivate",
			"timeout",
			"worker",
			"retries",
			"errorMessage",
			"sortBy",
			"asc",
			"desc",
			"limit",
			"between",
			"dateField",
			"fields",
			"dry-run",
			"verbose",
			"force",
			"none",
			"ownerId",
			"ownerType",
			"resourceType",
			"resourceId",
			"permissions",
			"roleId",
			"groupId",
			"tenantId",
			"claimName",
			"claimValue",
			"mappingRuleId",
			"to-user",
			"to-group",
			"to-tenant",
			"to-mapping-rule",
			"from-user",
			"from-group",
			"from-tenant",
			"from-mapping-rule",
			"userTask",
			"processDefinition",
			"username",
			"email",
			"password",
			"name",
			"key",
			"elementId",
			"errorType",
			"value",
			"scopeKey",
			"fullValue",
			"iname",
			"iid",
			"iassignee",
			"ierrorMessage",
			"itype",
			"ivalue",
			"awaitCompletion",
			"fetchVariables",
			"requestTimeout",
			"baseUrl",
			"clientId",
			"clientSecret",
			"audience",
			"oAuthUrl",
			"defaultTenantId",
			"from-file",
			"from-env",
		];

		const missing = mustExist.filter((f) => !options[f]);
		assert.deepStrictEqual(
			missing,
			[],
			`Missing flags in deriveParseArgsOptions: ${missing.join(", ")}`,
		);
	});
});

// ─── Mutating flag consistency ───────────────────────────────────────────────

describe("mutating flag correctness", () => {
	const MUTATING_VERBS = [
		"create",
		"delete",
		"cancel",
		"await",
		"complete",
		"fail",
		"activate",
		"resolve",
		"publish",
		"correlate",
		"deploy",
		"run",
		"assign",
		"unassign",
		"completion",
	];

	const NON_MUTATING_VERBS = [
		"list",
		"search",
		"get",
		"watch",
		"open",
		"add",
		"remove",
		"load",
		"unload",
		"upgrade",
		"downgrade",
		"sync",
		"init",
		"use",
		"output",
		"mcp-proxy",
		"feedback",
		"help",
		"which",
	];

	test("all mutating verbs are marked as mutating", () => {
		for (const verb of MUTATING_VERBS) {
			const def = COMMAND_REGISTRY[verb];
			assert.ok(def, `Missing entry for "${verb}"`);
			assert.strictEqual(
				def.mutating,
				true,
				`"${verb}" should be mutating`,
			);
		}
	});

	test("all non-mutating verbs are marked as non-mutating", () => {
		for (const verb of NON_MUTATING_VERBS) {
			const def = COMMAND_REGISTRY[verb];
			assert.ok(def, `Missing entry for "${verb}"`);
			assert.strictEqual(
				def.mutating,
				false,
				`"${verb}" should not be mutating`,
			);
		}
	});
});
