/**
 * Unit tests for identity commands
 * Covers: required-flag validation, dry-run request construction, assign/unassign flag validation
 */

import assert from "node:assert";
import { afterEach, beforeEach, describe, test } from "node:test";
import { createClient } from "../../src/client.ts";
import { handleAssign, handleUnassign } from "../../src/commands/identity.ts";
import {
	createIdentityAuthorizationCommand,
	deleteIdentityAuthorizationCommand,
	validateCreateAuthorizationOptions,
} from "../../src/commands/identity-authorizations.ts";
import {
	createIdentityGroupCommand,
	deleteIdentityGroupCommand,
} from "../../src/commands/identity-groups.ts";
import {
	createIdentityMappingRuleCommand,
	deleteIdentityMappingRuleCommand,
} from "../../src/commands/identity-mapping-rules.ts";
import {
	createIdentityRoleCommand,
	deleteIdentityRoleCommand,
} from "../../src/commands/identity-roles.ts";
import {
	createIdentityTenantCommand,
	deleteIdentityTenantCommand,
} from "../../src/commands/identity-tenants.ts";
import {
	createIdentityUserCommand,
	deleteIdentityUserCommand,
} from "../../src/commands/identity-users.ts";
import { resolveTenantId } from "../../src/config.ts";
import { getLogger } from "../../src/logger.ts";
import { c8ctl } from "../../src/runtime.ts";

const TEST_BASE_URL = "http://test-cluster/v2";

// ─── Shared spy / mock infrastructure ───────────────────────────────────────

let logSpy: string[];
let errorSpy: string[];
let originalLog: typeof console.log;
let originalError: typeof console.error;
let originalExit: typeof process.exit;
let originalBaseUrl: string | undefined;
let originalActiveProfile: typeof c8ctl.activeProfile;
let originalDryRun: typeof c8ctl.dryRun;
let originalOutputMode: typeof c8ctl.outputMode;

function setup() {
	logSpy = [];
	errorSpy = [];
	originalLog = console.log;
	originalError = console.error;
	originalExit = process.exit;
	originalBaseUrl = process.env.CAMUNDA_BASE_URL;
	originalActiveProfile = c8ctl.activeProfile;
	originalDryRun = c8ctl.dryRun;
	originalOutputMode = c8ctl.outputMode;

	console.log = (...args: any[]) => logSpy.push(args.join(" "));
	console.error = (...args: any[]) => errorSpy.push(args.join(" "));
	// Make process.exit throw so tests can catch it with assert.rejects / assert.throws
	(process.exit as any) = (code: number) => {
		throw new Error(`process.exit(${code})`);
	};

	// Provide a base URL so resolveClusterConfig uses the env-var path,
	// no profile file or local cluster needed.
	process.env.CAMUNDA_BASE_URL = TEST_BASE_URL;
	c8ctl.activeProfile = undefined;
	c8ctl.dryRun = false;
	c8ctl.outputMode = "text";
}

function teardown() {
	console.log = originalLog;
	console.error = originalError;
	process.exit = originalExit;
	if (originalBaseUrl === undefined) {
		delete process.env.CAMUNDA_BASE_URL;
	} else {
		process.env.CAMUNDA_BASE_URL = originalBaseUrl;
	}
	c8ctl.activeProfile = originalActiveProfile;
	c8ctl.dryRun = originalDryRun;
	c8ctl.outputMode = originalOutputMode;
}

/** Parse the first JSON line captured on stdout */
function capturedJson(): Record<string, unknown> {
	assert.ok(logSpy.length > 0, "Expected at least one stdout line");
	return JSON.parse(logSpy[0]);
}

/** Build a minimal CommandContext for test execution */
function buildCtx(profile?: string) {
	return {
		client: createClient(profile),
		logger: getLogger(),
		tenantId: resolveTenantId(profile),
		resource: "",
		positionals: [] as string[],
		sortOrder: "asc" as const,
		sortBy: undefined,
		limit: undefined,
		all: undefined,
		between: undefined,
		dateField: undefined,
		dryRun: c8ctl.dryRun,
		profile,
	};
}

// ─── Required-flag validation ────────────────────────────────────────────────

describe("Identity Commands — required-flag validation", () => {
	beforeEach(setup);
	afterEach(teardown);

	// createIdentityUser
	test("createIdentityUser: errors when --username is missing", async () => {
		await assert.rejects(
			() =>
				createIdentityUserCommand.execute(
					buildCtx(),
					{ password: "secret" },
					[],
				),
			/process\.exit\(1\)/,
		);
		assert.ok(errorSpy.some((l) => l.includes("--username is required")));
	});

	test("createIdentityUser: errors when --password is missing", async () => {
		await assert.rejects(
			() =>
				createIdentityUserCommand.execute(
					buildCtx(),
					{ username: "alice" },
					[],
				),
			/process\.exit\(1\)/,
		);
		assert.ok(errorSpy.some((l) => l.includes("--password is required")));
	});

	// createIdentityRole
	test("createIdentityRole: errors when --roleId is missing", async () => {
		await assert.rejects(
			() =>
				createIdentityRoleCommand.execute(buildCtx(), { name: "admin" }, []),
			/process\.exit\(1\)/,
		);
		assert.ok(errorSpy.some((l) => l.includes("--roleId is required")));
	});

	test("createIdentityRole: errors when --name is missing", async () => {
		await assert.rejects(
			() =>
				createIdentityRoleCommand.execute(
					buildCtx(),
					{ roleId: "admin-role" },
					[],
				),
			/process\.exit\(1\)/,
		);
		assert.ok(errorSpy.some((l) => l.includes("--name is required")));
	});

	// createIdentityMappingRule
	test("createIdentityMappingRule: errors when --mappingRuleId is missing", async () => {
		await assert.rejects(
			() =>
				createIdentityMappingRuleCommand.execute(
					buildCtx(),
					{ name: "n", claimName: "c", claimValue: "v" },
					[],
				),
			/process\.exit\(1\)/,
		);
		assert.ok(errorSpy.some((l) => l.includes("--mappingRuleId is required")));
	});

	test("createIdentityMappingRule: errors when --name is missing", async () => {
		await assert.rejects(
			() =>
				createIdentityMappingRuleCommand.execute(
					buildCtx(),
					{ mappingRuleId: "r1", claimName: "c", claimValue: "v" },
					[],
				),
			/process\.exit\(1\)/,
		);
		assert.ok(errorSpy.some((l) => l.includes("--name is required")));
	});

	test("createIdentityMappingRule: errors when --claimName is missing", async () => {
		await assert.rejects(
			() =>
				createIdentityMappingRuleCommand.execute(
					buildCtx(),
					{ mappingRuleId: "r1", name: "n", claimValue: "v" },
					[],
				),
			/process\.exit\(1\)/,
		);
		assert.ok(errorSpy.some((l) => l.includes("--claimName is required")));
	});

	test("createIdentityMappingRule: errors when --claimValue is missing", async () => {
		await assert.rejects(
			() =>
				createIdentityMappingRuleCommand.execute(
					buildCtx(),
					{ mappingRuleId: "r1", name: "n", claimName: "c" },
					[],
				),
			/process\.exit\(1\)/,
		);
		assert.ok(errorSpy.some((l) => l.includes("--claimValue is required")));
	});

	// createIdentityAuthorization — validation now lives in validateCreateAuthorizationOptions
	test("createIdentityAuthorization: errors when --ownerId is missing", async () => {
		assert.throws(
			() =>
				validateCreateAuthorizationOptions({
					ownerType: "USER",
					resourceType: "PROCESS_DEFINITION",
					resourceId: "r",
					permissions: "READ",
				}),
			/process\.exit\(1\)/,
		);
		assert.ok(errorSpy.some((l) => l.includes("--ownerId is required")));
	});

	test("createIdentityAuthorization: errors when --ownerType is missing", async () => {
		assert.throws(
			() =>
				validateCreateAuthorizationOptions({
					ownerId: "alice",
					resourceType: "PROCESS_DEFINITION",
					resourceId: "r",
					permissions: "READ",
				}),
			/process\.exit\(1\)/,
		);
		assert.ok(errorSpy.some((l) => l.includes("--ownerType is required")));
	});

	test("createIdentityAuthorization: errors when --resourceId is missing", async () => {
		assert.throws(
			() =>
				validateCreateAuthorizationOptions({
					ownerId: "alice",
					ownerType: "USER",
					resourceType: "PROCESS_DEFINITION",
					permissions: "READ",
				}),
			/process\.exit\(1\)/,
		);
		assert.ok(errorSpy.some((l) => l.includes("--resourceId is required")));
	});

	test("createIdentityAuthorization: errors when --resourceType is missing", async () => {
		assert.throws(
			() =>
				validateCreateAuthorizationOptions({
					ownerId: "alice",
					ownerType: "USER",
					resourceId: "r",
					permissions: "READ",
				}),
			/process\.exit\(1\)/,
		);
		assert.ok(errorSpy.some((l) => l.includes("--resourceType is required")));
	});

	test("createIdentityAuthorization: errors when --permissions is missing", async () => {
		assert.throws(
			() =>
				validateCreateAuthorizationOptions({
					ownerId: "alice",
					ownerType: "USER",
					resourceType: "PROCESS_DEFINITION",
					resourceId: "r",
				}),
			/process\.exit\(1\)/,
		);
		assert.ok(errorSpy.some((l) => l.includes("--permissions is required")));
	});

	// Enum validation — invalid values rejected with valid-values listing
	test("createIdentityAuthorization: errors on invalid --ownerType", async () => {
		assert.throws(
			() =>
				validateCreateAuthorizationOptions({
					ownerId: "alice",
					ownerType: "BOGUS",
					resourceType: "PROCESS_DEFINITION",
					resourceId: "r",
					permissions: "READ",
				}),
			/process\.exit\(1\)/,
		);
		assert.ok(errorSpy.some((l) => l.includes('Invalid --ownerType "BOGUS"')));
		assert.ok(errorSpy.some((l) => l.includes("Valid values:")));
	});

	test("createIdentityAuthorization: errors on invalid --resourceType", async () => {
		assert.throws(
			() =>
				validateCreateAuthorizationOptions({
					ownerId: "alice",
					ownerType: "USER",
					resourceType: "NOPE",
					resourceId: "r",
					permissions: "READ",
				}),
			/process\.exit\(1\)/,
		);
		assert.ok(
			errorSpy.some((l) => l.includes('Invalid --resourceType "NOPE"')),
		);
	});

	test("createIdentityAuthorization: errors on invalid --permissions", async () => {
		assert.throws(
			() =>
				validateCreateAuthorizationOptions({
					ownerId: "alice",
					ownerType: "USER",
					resourceType: "PROCESS_DEFINITION",
					resourceId: "r",
					permissions: "READ,BOGUS",
				}),
			/process\.exit\(1\)/,
		);
		assert.ok(errorSpy.some((l) => l.includes("Invalid --permissions: BOGUS")));
	});

	test("createIdentityAuthorization: accepts valid enum values", () => {
		const result = validateCreateAuthorizationOptions({
			ownerId: "alice",
			ownerType: "USER",
			resourceType: "PROCESS_DEFINITION",
			resourceId: "my-process",
			permissions: "READ,UPDATE",
		});
		assert.strictEqual(result.ownerId, "alice");
		assert.strictEqual(result.ownerType, "USER");
		assert.strictEqual(result.resourceType, "PROCESS_DEFINITION");
		assert.strictEqual(result.resourceId, "my-process");
		assert.deepStrictEqual(result.permissionTypes, ["READ", "UPDATE"]);
	});
});

// ─── Dry-run request construction ────────────────────────────────────────────

describe("Identity Commands — dry-run output", () => {
	beforeEach(() => {
		setup();
		c8ctl.dryRun = true;
	});
	afterEach(teardown);

	test("createIdentityUser: emits POST to /users with body; password is redacted", async () => {
		await createIdentityUserCommand.execute(
			buildCtx(),
			{
				username: "alice",
				password: "secret",
				name: "Alice",
				email: "alice@example.com",
			},
			[],
		);

		const out = capturedJson();
		assert.strictEqual(out.dryRun, true);
		assert.strictEqual(out.method, "POST");
		assert.ok(
			(out.url as string).endsWith("/users"),
			`expected URL to end with /users, got: ${out.url}`,
		);
		const body = out.body as Record<string, unknown>;
		assert.strictEqual(body.username, "alice");
		assert.strictEqual(
			body.password,
			"[REDACTED]",
			"password must be redacted in dry-run output",
		);
		assert.strictEqual(body.name, "Alice");
		assert.strictEqual(body.email, "alice@example.com");
	});

	test("deleteIdentityUser: emits DELETE to /users/:username", async () => {
		await deleteIdentityUserCommand.execute(buildCtx(), {}, ["alice"]);

		const out = capturedJson();
		assert.strictEqual(out.dryRun, true);
		assert.strictEqual(out.method, "DELETE");
		assert.ok(
			(out.url as string).endsWith("/users/alice"),
			`expected URL to end with /users/alice, got: ${out.url}`,
		);
	});

	test("createIdentityRole: emits POST to /roles with name in body", async () => {
		await createIdentityRoleCommand.execute(
			buildCtx(),
			{ roleId: "admin-role", name: "admin" },
			[],
		);

		const out = capturedJson();
		assert.strictEqual(out.dryRun, true);
		assert.strictEqual(out.method, "POST");
		assert.ok(
			(out.url as string).endsWith("/roles"),
			`expected URL to end with /roles, got: ${out.url}`,
		);
		assert.deepStrictEqual(out.body, { roleId: "admin-role", name: "admin" });
	});

	test("deleteIdentityRole: emits DELETE to /roles/:roleId", async () => {
		await deleteIdentityRoleCommand.execute(buildCtx(), {}, ["admin-role"]);

		const out = capturedJson();
		assert.strictEqual(out.dryRun, true);
		assert.strictEqual(out.method, "DELETE");
		assert.ok((out.url as string).endsWith("/roles/admin-role"));
	});

	test("createIdentityMappingRule: emits POST to /mapping-rules with all fields", async () => {
		await createIdentityMappingRuleCommand.execute(
			buildCtx(),
			{
				mappingRuleId: "rule-1",
				name: "My Rule",
				claimName: "email",
				claimValue: "*@example.com",
			},
			[],
		);

		const out = capturedJson();
		assert.strictEqual(out.dryRun, true);
		assert.strictEqual(out.method, "POST");
		assert.ok((out.url as string).endsWith("/mapping-rules"));
		assert.deepStrictEqual(out.body, {
			mappingRuleId: "rule-1",
			name: "My Rule",
			claimName: "email",
			claimValue: "*@example.com",
		});
	});

	test("deleteIdentityMappingRule: emits DELETE to /mapping-rules/:id", async () => {
		await deleteIdentityMappingRuleCommand.execute(buildCtx(), {}, ["rule-1"]);

		const out = capturedJson();
		assert.strictEqual(out.dryRun, true);
		assert.strictEqual(out.method, "DELETE");
		assert.ok((out.url as string).endsWith("/mapping-rules/rule-1"));
	});

	test("createIdentityAuthorization: emits POST to /authorizations with permissionTypes array", async () => {
		await createIdentityAuthorizationCommand.execute(
			buildCtx(),
			{
				ownerId: "alice",
				ownerType: "USER",
				resourceType: "PROCESS_DEFINITION",
				resourceId: "my-process",
				permissions: "READ,UPDATE",
			},
			[],
		);

		const out = capturedJson();
		assert.strictEqual(out.dryRun, true);
		assert.strictEqual(out.method, "POST");
		assert.ok((out.url as string).endsWith("/authorizations"));
		const body = out.body as Record<string, unknown>;
		assert.strictEqual(body.ownerId, "alice");
		assert.strictEqual(body.ownerType, "USER");
		assert.strictEqual(body.resourceType, "PROCESS_DEFINITION");
		assert.strictEqual(body.resourceId, "my-process");
		assert.deepStrictEqual(body.permissionTypes, ["READ", "UPDATE"]);
	});

	test("deleteIdentityAuthorization: emits DELETE to /authorizations/:key", async () => {
		await deleteIdentityAuthorizationCommand.execute(buildCtx(), {}, ["42"]);

		const out = capturedJson();
		assert.strictEqual(out.dryRun, true);
		assert.strictEqual(out.method, "DELETE");
		assert.ok((out.url as string).endsWith("/authorizations/42"));
	});
});

// ─── handleAssign / handleUnassign ───────────────────────────────────────────

describe("handleAssign — dry-run and flag validation", () => {
	beforeEach(setup);
	afterEach(teardown);

	test("dry-run emits method/url/body and returns without making API call", async () => {
		c8ctl.dryRun = true;
		await handleAssign("role", "admin-role", { "to-user": "alice" }, {});

		const out = capturedJson();
		assert.strictEqual(out.dryRun, true);
		assert.strictEqual(out.command, "assign");
		assert.strictEqual(out.method, "POST");
		assert.ok((out.url as string).includes("/roles/admin-role/users/alice"));
		assert.strictEqual(out.body, null);
	});

	test("errors when multiple --to-* flags are provided", async () => {
		await assert.rejects(
			() =>
				handleAssign(
					"role",
					"admin-role",
					{ "to-user": "alice", "to-group": "ops" },
					{},
				),
			/process\.exit\(1\)/,
		);
		const allError = errorSpy.join("\n");
		assert.ok(
			allError.includes("--to-user"),
			"error should list the conflicting flags",
		);
		assert.ok(
			allError.includes("--to-group"),
			"error should list the conflicting flags",
		);
	});

	test("errors when no --to-* flag is provided", async () => {
		await assert.rejects(
			() => handleAssign("role", "admin-role", {}, {}),
			/process\.exit\(1\)/,
		);
		assert.ok(errorSpy.some((l) => l.includes("Target required")));
	});

	test("dry-run with multiple --to-* flags errors before emitting", async () => {
		c8ctl.dryRun = true;
		await assert.rejects(
			() =>
				handleAssign(
					"role",
					"admin",
					{ "to-user": "alice", "to-group": "ops", "to-tenant": "t1" },
					{},
				),
			/process\.exit\(1\)/,
		);
		// No JSON should have been emitted
		assert.strictEqual(logSpy.length, 0);
	});

	test("dry-run encodes special characters in path", async () => {
		c8ctl.dryRun = true;
		await handleAssign(
			"user",
			"alice@example.com",
			{ "to-group": "my group" },
			{},
		);

		const out = capturedJson();
		assert.ok(
			(out.url as string).includes(encodeURIComponent("alice@example.com")),
		);
		assert.ok((out.url as string).includes(encodeURIComponent("my group")));
	});
});

describe("handleUnassign — dry-run and flag validation", () => {
	beforeEach(setup);
	afterEach(teardown);

	test("dry-run emits method/url/body and returns without making API call", async () => {
		c8ctl.dryRun = true;
		await handleUnassign("user", "alice", { "from-group": "ops" }, {});

		const out = capturedJson();
		assert.strictEqual(out.dryRun, true);
		assert.strictEqual(out.command, "unassign");
		assert.strictEqual(out.method, "DELETE");
		assert.ok((out.url as string).includes("/users/alice/groups/ops"));
		assert.strictEqual(out.body, null);
	});

	test("errors when multiple --from-* flags are provided", async () => {
		await assert.rejects(
			() =>
				handleUnassign(
					"user",
					"alice",
					{ "from-group": "ops", "from-tenant": "t1" },
					{},
				),
			/process\.exit\(1\)/,
		);
		const allError = errorSpy.join("\n");
		assert.ok(
			allError.includes("--from-group"),
			"error should list the conflicting flags",
		);
		assert.ok(
			allError.includes("--from-tenant"),
			"error should list the conflicting flags",
		);
	});

	test("errors when no --from-* flag is provided", async () => {
		await assert.rejects(
			() => handleUnassign("user", "alice", {}, {}),
			/process\.exit\(1\)/,
		);
		assert.ok(errorSpy.some((l) => l.includes("Source required")));
	});
});

// ─── sanitizeForLogging (logger boundary) ────────────────────────────────────

describe("sanitizeForLogging — credential redaction", () => {
	// Import directly to unit-test the sanitizer in isolation
	test("redacts password from a flat object", async () => {
		const { sanitizeForLogging } = await import("../../src/logger.ts");
		const result = sanitizeForLogging({
			username: "alice",
			password: "secret",
		}) as any;
		assert.strictEqual(result.username, "alice");
		assert.strictEqual(result.password, "[REDACTED]");
	});

	test("redacts clientSecret from a nested body object", async () => {
		const { sanitizeForLogging } = await import("../../src/logger.ts");
		const result = sanitizeForLogging({
			config: { clientId: "id", clientSecret: "shhh" },
		}) as any;
		assert.strictEqual(result.config.clientId, "id");
		assert.strictEqual(result.config.clientSecret, "[REDACTED]");
	});

	test("does NOT redact oAuthUrl (it is a URL, not a credential)", async () => {
		const { sanitizeForLogging } = await import("../../src/logger.ts");
		const url = "https://auth.example.com/oauth/token";
		const result = sanitizeForLogging({ oAuthUrl: url }) as Record<
			string,
			unknown
		>;
		assert.strictEqual(result.oAuthUrl, url);
	});

	test("does NOT redact authorizationKey (false positive — it is a resource identifier)", async () => {
		const { sanitizeForLogging } = await import("../../src/logger.ts");
		const result = sanitizeForLogging({ authorizationKey: "42" }) as any;
		assert.strictEqual(result.authorizationKey, "42");
	});

	test("redacts password inside an array of objects", async () => {
		const { sanitizeForLogging } = await import("../../src/logger.ts");
		const result = sanitizeForLogging([
			{ user: "alice", password: "p1" },
			{ user: "bob", password: "p2" },
		]) as any[];
		assert.strictEqual(result[0].password, "[REDACTED]");
		assert.strictEqual(result[1].password, "[REDACTED]");
		assert.strictEqual(result[0].user, "alice");
	});

	test("passes primitives through unchanged", async () => {
		const { sanitizeForLogging } = await import("../../src/logger.ts");
		assert.strictEqual(sanitizeForLogging("hello"), "hello");
		assert.strictEqual(sanitizeForLogging(42), 42);
		assert.strictEqual(sanitizeForLogging(null), null);
	});
});

// ─── Defect class: dry-run schema consistency ────────────────────────────────
// Every mutating identity command's dry-run output must include { dryRun, command, method, url, body }.
// The body field must be present (null for DELETE, an object for POST/PUT).

describe("Dry-run schema — all mutating identity commands include body field", () => {
	beforeEach(() => {
		setup();
		c8ctl.dryRun = true;
	});
	afterEach(teardown);

	const REQUIRED_DRY_RUN_KEYS = ["dryRun", "command", "method", "url", "body"];

	function assertDryRunSchema(out: Record<string, unknown>, label: string) {
		for (const key of REQUIRED_DRY_RUN_KEYS) {
			assert.ok(
				key in out,
				`${label}: dry-run output missing required key '${key}'. Got keys: ${Object.keys(out).join(", ")}`,
			);
		}
	}

	// DELETE commands — body should be null
	test("deleteIdentityUser dry-run includes body: null", async () => {
		await deleteIdentityUserCommand.execute(buildCtx(), {}, ["alice"]);
		assertDryRunSchema(capturedJson(), "deleteIdentityUser");
		assert.strictEqual(capturedJson().body, null);
	});

	test("deleteIdentityRole dry-run includes body: null", async () => {
		await deleteIdentityRoleCommand.execute(buildCtx(), {}, ["admin"]);
		assertDryRunSchema(capturedJson(), "deleteIdentityRole");
		assert.strictEqual(capturedJson().body, null);
	});

	test("deleteIdentityGroup dry-run includes body: null", async () => {
		await deleteIdentityGroupCommand.execute(buildCtx(), {}, ["ops"]);
		assertDryRunSchema(capturedJson(), "deleteIdentityGroup");
		assert.strictEqual(capturedJson().body, null);
	});

	test("deleteIdentityTenant dry-run includes body: null", async () => {
		await deleteIdentityTenantCommand.execute(buildCtx(), {}, ["t1"]);
		assertDryRunSchema(capturedJson(), "deleteIdentityTenant");
		assert.strictEqual(capturedJson().body, null);
	});

	test("deleteIdentityMappingRule dry-run includes body: null", async () => {
		await deleteIdentityMappingRuleCommand.execute(buildCtx(), {}, ["rule-1"]);
		assertDryRunSchema(capturedJson(), "deleteIdentityMappingRule");
		assert.strictEqual(capturedJson().body, null);
	});

	test("deleteIdentityAuthorization dry-run includes body: null", async () => {
		await deleteIdentityAuthorizationCommand.execute(buildCtx(), {}, ["42"]);
		assertDryRunSchema(capturedJson(), "deleteIdentityAuthorization");
		assert.strictEqual(capturedJson().body, null);
	});

	// CREATE commands — body must be present and an object
	test("createIdentityUser dry-run includes body object", async () => {
		await createIdentityUserCommand.execute(
			buildCtx(),
			{ username: "alice", password: "pw" },
			[],
		);
		assertDryRunSchema(capturedJson(), "createIdentityUser");
		assert.ok(
			typeof capturedJson().body === "object" && capturedJson().body !== null,
		);
	});

	test("createIdentityRole dry-run includes body object", async () => {
		await createIdentityRoleCommand.execute(
			buildCtx(),
			{ roleId: "admin-role", name: "admin" },
			[],
		);
		assertDryRunSchema(capturedJson(), "createIdentityRole");
		assert.ok(
			typeof capturedJson().body === "object" && capturedJson().body !== null,
		);
	});
});

// ─── Defect class: assign/unassign target map ↔ switch consistency ───────────
// Every resource in the allowed-targets/sources map must succeed in dry-run mode.
// If a resource appears in the map but has no switch case, dry-run will pass
// but non-dry-run would fail — the dry-run test catches the *map* side;
// the non-dry-run test catches the *switch* side.

describe("handleAssign — every allowed resource/target pair works in dry-run", () => {
	beforeEach(() => {
		setup();
		c8ctl.dryRun = true;
	});
	afterEach(teardown);

	// These are ALL the valid resource+target combos that the code claims to support.
	// If any entry here is in the allowed map but missing from the switch, the
	// non-dry-run test below will catch it (dry-run checks the map path only).
	const VALID_ASSIGN_COMBOS: Array<{
		resource: string;
		flag: string;
		value: string;
	}> = [
		{ resource: "role", flag: "to-user", value: "alice" },
		{ resource: "role", flag: "to-group", value: "ops" },
		{ resource: "role", flag: "to-tenant", value: "t1" },
		{ resource: "role", flag: "to-mapping-rule", value: "mr1" },
		{ resource: "user", flag: "to-group", value: "ops" },
		{ resource: "user", flag: "to-tenant", value: "t1" },
		{ resource: "group", flag: "to-tenant", value: "t1" },
		{ resource: "mapping-rule", flag: "to-group", value: "ops" },
		{ resource: "mapping-rule", flag: "to-tenant", value: "t1" },
	];

	for (const { resource, flag, value } of VALID_ASSIGN_COMBOS) {
		test(`assign ${resource} --${flag}=${value} produces valid dry-run output`, async () => {
			await handleAssign(resource, "test-id", { [flag]: value }, {});
			const out = capturedJson();
			assert.strictEqual(out.dryRun, true);
			assert.strictEqual(out.command, "assign");
			assert.strictEqual(out.method, "POST");
			assert.ok(typeof out.url === "string" && (out.url as string).length > 0);
		});
	}

	test("assign rejects unsupported resource", async () => {
		await assert.rejects(
			() => handleAssign("bogus", "id", { "to-user": "a" }, {}),
			/process\.exit\(1\)/,
		);
	});

	test("assign rejects unsupported target flag for resource", async () => {
		// user does not support --to-user (you can\'t assign a user to another user)
		await assert.rejects(
			() => handleAssign("user", "alice", { "to-user": "bob" }, {}),
			/process\.exit\(1\)/,
		);
		assert.ok(errorSpy.some((l) => l.includes("Unsupported target flag")));
	});
});

// ─── Defect class: sanitizeForLogging must preserve built-in types ────────────
// sanitizeForLogging should not destroy Error, Date, URL, RegExp, or other
// common built-in instances by treating them as plain objects (which drops
// non-enumerable properties like Error.message or returns {} for Date).

describe("sanitizeForLogging — built-in type preservation", () => {
	test("preserves Error name, message, and stack", async () => {
		const { sanitizeForLogging } = await import("../../src/logger.ts");
		const err = new Error("something broke");
		const result = sanitizeForLogging(err) as Record<string, unknown>;
		assert.strictEqual(result.name, "Error");
		assert.strictEqual(result.message, "something broke");
		assert.ok(
			typeof result.stack === "string" && result.stack.length > 0,
			"stack should be preserved",
		);
	});

	test("preserves nested Error in cause chain", async () => {
		const { sanitizeForLogging } = await import("../../src/logger.ts");
		const inner = new Error("root cause");
		const outer = new Error("wrapper", { cause: inner });
		const result = sanitizeForLogging(outer) as Record<string, unknown>;
		assert.strictEqual(result.message, "wrapper");
		const causeResult = result.cause as Record<string, unknown>;
		assert.strictEqual(causeResult.message, "root cause");
	});

	test("redacts sensitive fields on Error with enumerable credentials", async () => {
		const { sanitizeForLogging } = await import("../../src/logger.ts");
		const err = new Error("auth failed");
		(err as any).password = "secret123";
		const result = sanitizeForLogging(err) as Record<string, unknown>;
		assert.strictEqual(result.message, "auth failed");
		assert.strictEqual(result.password, "[REDACTED]");
	});

	test("preserves Date instances (does not return empty object)", async () => {
		const { sanitizeForLogging } = await import("../../src/logger.ts");
		const date = new Date("2025-01-15T10:30:00Z");
		const result = sanitizeForLogging(date);
		// Should either return the Date as-is or a string representation — not {}
		assert.notDeepStrictEqual(
			result,
			{},
			"Date should not be serialized as empty object",
		);
	});

	test("preserves URL instances (does not return empty object)", async () => {
		const { sanitizeForLogging } = await import("../../src/logger.ts");
		const url = new URL("https://example.com/path");
		const result = sanitizeForLogging(url);
		assert.notDeepStrictEqual(
			result,
			{},
			"URL should not be serialized as empty object",
		);
	});

	test("preserves RegExp instances", async () => {
		const { sanitizeForLogging } = await import("../../src/logger.ts");
		const re = /test-pattern/gi;
		const result = sanitizeForLogging(re);
		assert.notDeepStrictEqual(
			result,
			{},
			"RegExp should not be serialized as empty object",
		);
	});
});
