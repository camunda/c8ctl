/**
 * CLI behavioural tests for identity commands (users, roles, groups, tenants,
 * mapping-rules, assign, unassign).
 *
 * These tests exercise the full dispatch path by spawning the CLI
 * as a subprocess with --dry-run. They verify that CLI flags flow
 * correctly through index.ts dispatch → validation → handler → JSON output.
 *
 * Authorization commands are covered in identity-authorization-cli.test.ts.
 */

import assert from "node:assert";
import { describe, test } from "node:test";
import { c8, parseJson } from "../utils/cli.ts";
import { asRecord, getUrl } from "../utils/guards.ts";

// ─── create user ─────────────────────────────────────────────────────────────

describe("CLI behavioural: create user", () => {
	test("--dry-run emits POST to /users with required fields", async () => {
		const result = await c8(
			"create",
			"user",
			"--dry-run",
			"--username",
			"alice",
			"--password",
			"secret123",
		);

		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);

		assert.strictEqual(out.dryRun, true);
		assert.strictEqual(out.method, "POST");
		assert.ok(getUrl(out).endsWith("/users"));

		const body = asRecord(out.body, "dry-run body");
		assert.strictEqual(body.username, "alice");
		// password is redacted by sanitizeForLogging — assert the actual
		// redaction marker, not just presence (a regression that emits the
		// raw secret would otherwise pass the weaker check).
		assert.strictEqual(
			body.password,
			"[REDACTED]",
			"password must be redacted in dry-run output",
		);
	});

	test("--dry-run includes optional name and email", async () => {
		const result = await c8(
			"create",
			"user",
			"--dry-run",
			"--username",
			"bob",
			"--password",
			"pass",
			"--name",
			"Bob Smith",
			"--email",
			"bob@example.com",
		);

		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const body = asRecord(parseJson(result).body, "dry-run body");
		assert.strictEqual(body.name, "Bob Smith");
		assert.strictEqual(body.email, "bob@example.com");
	});

	test("rejects missing --username with exit code 1", async () => {
		const result = await c8("create", "user", "--password", "secret");

		assert.strictEqual(result.status, 1);
		assert.ok(
			result.stderr.includes("--username is required"),
			`stderr: ${result.stderr}`,
		);
	});

	test("rejects missing --password with exit code 1", async () => {
		const result = await c8("create", "user", "--username", "alice");

		assert.strictEqual(result.status, 1);
		assert.ok(
			result.stderr.includes("--password is required"),
			`stderr: ${result.stderr}`,
		);
	});
});

// ─── delete user ─────────────────────────────────────────────────────────────

describe("CLI behavioural: delete user", () => {
	test("--dry-run emits DELETE to /users/:username", async () => {
		const result = await c8("delete", "user", "--dry-run", "alice");

		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);
		assert.strictEqual(out.dryRun, true);
		assert.strictEqual(out.method, "DELETE");
		assert.ok(getUrl(out).endsWith("/users/alice"));
	});

	test("rejects missing username with exit code 1", async () => {
		const result = await c8("delete", "user");
		assert.strictEqual(result.status, 1);
		assert.ok(
			result.stderr.includes("Username required"),
			`stderr: ${result.stderr}`,
		);
	});
});

// ─── create role ─────────────────────────────────────────────────────────────

describe("CLI behavioural: create role", () => {
	test("--dry-run emits POST to /roles", async () => {
		const result = await c8(
			"create",
			"role",
			"--dry-run",
			"--roleId",
			"admin",
			"--name",
			"Administrator",
		);

		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);
		assert.strictEqual(out.dryRun, true);
		assert.strictEqual(out.method, "POST");
		assert.ok(getUrl(out).endsWith("/roles"));

		const body = asRecord(out.body, "dry-run body");
		assert.strictEqual(body.roleId, "admin");
		assert.strictEqual(body.name, "Administrator");
	});

	test("rejects missing --roleId with exit code 1", async () => {
		const result = await c8("create", "role", "--name", "Admin");
		assert.strictEqual(result.status, 1);
		assert.ok(
			result.stderr.includes("--roleId is required"),
			`stderr: ${result.stderr}`,
		);
	});

	test("rejects missing --name with exit code 1", async () => {
		const result = await c8("create", "role", "--roleId", "admin");
		assert.strictEqual(result.status, 1);
		assert.ok(
			result.stderr.includes("--name is required"),
			`stderr: ${result.stderr}`,
		);
	});
});

// ─── delete role ─────────────────────────────────────────────────────────────

describe("CLI behavioural: delete role", () => {
	test("--dry-run emits DELETE to /roles/:roleId", async () => {
		const result = await c8("delete", "role", "--dry-run", "admin");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);
		assert.strictEqual(out.method, "DELETE");
		assert.ok(getUrl(out).endsWith("/roles/admin"));
	});

	test("rejects missing role ID with exit code 1", async () => {
		const result = await c8("delete", "role");
		assert.strictEqual(result.status, 1);
		assert.ok(
			result.stderr.includes("Role ID required"),
			`stderr: ${result.stderr}`,
		);
	});
});

// ─── create group ────────────────────────────────────────────────────────────

describe("CLI behavioural: create group", () => {
	test("--dry-run emits POST to /groups", async () => {
		const result = await c8(
			"create",
			"group",
			"--dry-run",
			"--groupId",
			"devs",
			"--name",
			"Developers",
		);

		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);
		assert.strictEqual(out.method, "POST");
		assert.ok(getUrl(out).endsWith("/groups"));

		const body = asRecord(out.body, "dry-run body");
		assert.strictEqual(body.groupId, "devs");
		assert.strictEqual(body.name, "Developers");
	});

	test("rejects missing --groupId with exit code 1", async () => {
		const result = await c8("create", "group", "--name", "Devs");
		assert.strictEqual(result.status, 1);
		assert.ok(
			result.stderr.includes("--groupId is required"),
			`stderr: ${result.stderr}`,
		);
	});

	test("rejects missing --name with exit code 1", async () => {
		const result = await c8("create", "group", "--groupId", "devs");
		assert.strictEqual(result.status, 1);
		assert.ok(
			result.stderr.includes("--name is required"),
			`stderr: ${result.stderr}`,
		);
	});
});

// ─── delete group ────────────────────────────────────────────────────────────

describe("CLI behavioural: delete group", () => {
	test("--dry-run emits DELETE to /groups/:groupId", async () => {
		const result = await c8("delete", "group", "--dry-run", "devs");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);
		assert.strictEqual(out.method, "DELETE");
		assert.ok(getUrl(out).endsWith("/groups/devs"));
	});

	test("rejects missing group ID with exit code 1", async () => {
		const result = await c8("delete", "group");
		assert.strictEqual(result.status, 1);
		assert.ok(
			result.stderr.includes("Group ID required"),
			`stderr: ${result.stderr}`,
		);
	});
});

// ─── create tenant ───────────────────────────────────────────────────────────

describe("CLI behavioural: create tenant", () => {
	test("--dry-run emits POST to /tenants", async () => {
		const result = await c8(
			"create",
			"tenant",
			"--dry-run",
			"--tenantId",
			"acme",
			"--name",
			"ACME Corp",
		);

		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);
		assert.strictEqual(out.method, "POST");
		assert.ok(getUrl(out).endsWith("/tenants"));

		const body = asRecord(out.body, "dry-run body");
		assert.strictEqual(body.tenantId, "acme");
		assert.strictEqual(body.name, "ACME Corp");
	});

	test("rejects missing --tenantId with exit code 1", async () => {
		const result = await c8("create", "tenant", "--name", "ACME");
		assert.strictEqual(result.status, 1);
		assert.ok(
			result.stderr.includes("--tenantId is required"),
			`stderr: ${result.stderr}`,
		);
	});

	test("rejects missing --name with exit code 1", async () => {
		const result = await c8("create", "tenant", "--tenantId", "acme");
		assert.strictEqual(result.status, 1);
		assert.ok(
			result.stderr.includes("--name is required"),
			`stderr: ${result.stderr}`,
		);
	});
});

// ─── delete tenant ───────────────────────────────────────────────────────────

describe("CLI behavioural: delete tenant", () => {
	test("--dry-run emits DELETE to /tenants/:tenantId", async () => {
		const result = await c8("delete", "tenant", "--dry-run", "acme");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);
		assert.strictEqual(out.method, "DELETE");
		assert.ok(getUrl(out).endsWith("/tenants/acme"));
	});

	test("rejects missing tenant ID with exit code 1", async () => {
		const result = await c8("delete", "tenant");
		assert.strictEqual(result.status, 1);
		assert.ok(
			result.stderr.includes("Tenant ID required"),
			`stderr: ${result.stderr}`,
		);
	});
});

// ─── create mapping-rule ─────────────────────────────────────────────────────

describe("CLI behavioural: create mapping-rule", () => {
	test("--dry-run emits POST to /mapping-rules", async () => {
		const result = await c8(
			"create",
			"mapping-rule",
			"--dry-run",
			"--mappingRuleId",
			"rule-1",
			"--name",
			"My Rule",
			"--claimName",
			"groups",
			"--claimValue",
			"admin",
		);

		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);
		assert.strictEqual(out.method, "POST");
		assert.ok(getUrl(out).endsWith("/mapping-rules"));

		const body = asRecord(out.body, "dry-run body");
		assert.strictEqual(body.mappingRuleId, "rule-1");
		assert.strictEqual(body.name, "My Rule");
		assert.strictEqual(body.claimName, "groups");
		assert.strictEqual(body.claimValue, "admin");
	});

	test("rejects missing --mappingRuleId with exit code 1", async () => {
		const result = await c8(
			"create",
			"mapping-rule",
			"--name",
			"Rule",
			"--claimName",
			"groups",
			"--claimValue",
			"admin",
		);
		assert.strictEqual(result.status, 1);
		assert.ok(
			result.stderr.includes("--mappingRuleId is required"),
			`stderr: ${result.stderr}`,
		);
	});

	test("rejects missing --claimName with exit code 1", async () => {
		const result = await c8(
			"create",
			"mapping-rule",
			"--mappingRuleId",
			"rule-1",
			"--name",
			"Rule",
			"--claimValue",
			"admin",
		);
		assert.strictEqual(result.status, 1);
		assert.ok(
			result.stderr.includes("--claimName is required"),
			`stderr: ${result.stderr}`,
		);
	});
});

// ─── delete mapping-rule ─────────────────────────────────────────────────────

describe("CLI behavioural: delete mapping-rule", () => {
	test("--dry-run emits DELETE to /mapping-rules/:id", async () => {
		const result = await c8("delete", "mapping-rule", "--dry-run", "rule-1");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);
		assert.strictEqual(out.method, "DELETE");
		assert.ok(getUrl(out).endsWith("/mapping-rules/rule-1"));
	});

	test("rejects missing mapping-rule ID with exit code 1", async () => {
		const result = await c8("delete", "mapping-rule");
		assert.strictEqual(result.status, 1);
		assert.ok(
			result.stderr.includes("Mapping rule ID required"),
			`stderr: ${result.stderr}`,
		);
	});
});

// ─── assign ──────────────────────────────────────────────────────────────────

describe("CLI behavioural: assign", () => {
	test("--dry-run assign role --to-user emits POST", async () => {
		const result = await c8(
			"assign",
			"role",
			"admin",
			"--dry-run",
			"--to-user",
			"alice",
		);

		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);
		assert.strictEqual(out.dryRun, true);
		assert.strictEqual(out.method, "POST");
		assert.ok(getUrl(out).includes("/roles/admin/"));
		assert.ok(getUrl(out).includes("alice"));
	});

	test("--dry-run assign role --to-group emits POST", async () => {
		const result = await c8(
			"assign",
			"role",
			"admin",
			"--dry-run",
			"--to-group",
			"devs",
		);

		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);
		assert.strictEqual(out.method, "POST");
		assert.ok(getUrl(out).includes("/roles/admin/"));
		assert.ok(getUrl(out).includes("devs"));
	});

	test("--dry-run assign user --to-tenant emits POST", async () => {
		const result = await c8(
			"assign",
			"user",
			"alice",
			"--dry-run",
			"--to-tenant",
			"acme",
		);

		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);
		assert.strictEqual(out.method, "POST");
		assert.ok(getUrl(out).includes("alice") || getUrl(out).includes("acme"));
	});

	test("rejects missing target flag with exit code 1", async () => {
		const result = await c8("assign", "role", "admin");
		assert.strictEqual(result.status, 1);
		assert.ok(
			result.stderr.includes("Target required") ||
				result.stderr.includes("target"),
			`stderr: ${result.stderr}`,
		);
	});

	test("rejects missing ID with exit code 1", async () => {
		const result = await c8("assign", "role");
		assert.strictEqual(result.status, 1);
		assert.ok(
			result.stderr.includes("ID required"),
			`stderr: ${result.stderr}`,
		);
	});
});

// ─── unassign ────────────────────────────────────────────────────────────────

describe("CLI behavioural: unassign", () => {
	test("--dry-run unassign user --from-group emits DELETE", async () => {
		const result = await c8(
			"unassign",
			"user",
			"alice",
			"--dry-run",
			"--from-group",
			"ops",
		);

		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);
		assert.strictEqual(out.dryRun, true);
		assert.strictEqual(out.method, "DELETE");
		assert.ok(getUrl(out).includes("alice") || getUrl(out).includes("ops"));
	});

	test("--dry-run unassign role --from-user emits DELETE", async () => {
		const result = await c8(
			"unassign",
			"role",
			"admin",
			"--dry-run",
			"--from-user",
			"alice",
		);

		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);
		assert.strictEqual(out.method, "DELETE");
		assert.ok(getUrl(out).includes("/roles/admin/"));
	});

	test("rejects missing source flag with exit code 1", async () => {
		const result = await c8("unassign", "user", "alice");
		assert.strictEqual(result.status, 1);
		assert.ok(
			result.stderr.includes("Source required") ||
				result.stderr.includes("source"),
			`stderr: ${result.stderr}`,
		);
	});

	test("rejects missing ID with exit code 1", async () => {
		const result = await c8("unassign", "role");
		assert.strictEqual(result.status, 1);
		assert.ok(
			result.stderr.includes("ID required"),
			`stderr: ${result.stderr}`,
		);
	});
});

// ─── assign / unassign — additional dispatcher behaviour ─────────────────────
//
// These tests cover error and edge-case paths that previously lived in
// `tests/unit/identity.test.ts` as direct-call tests against `handleAssign` /
// `handleUnassign`. Migrated to the `c8()` subprocess pattern as part of
// #341 to remove the last `tests/** → src/commands/**` import boundary
// violation (#291). The `Failed to assign|unassign <resource>:` prefix is
// added by the framework wrapper in `command-framework.ts`.

describe("CLI behavioural: assign — error and encoding paths", () => {
	test("rejects when multiple --to-* flags are provided", async () => {
		const result = await c8(
			"assign",
			"role",
			"admin",
			"--to-user",
			"alice",
			"--to-group",
			"ops",
		);
		assert.strictEqual(result.status, 1);
		assert.ok(
			result.stderr.includes("--to-user") &&
				result.stderr.includes("--to-group"),
			`stderr: ${result.stderr}`,
		);
	});

	test("--dry-run with multiple --to-* flags errors before emitting JSON", async () => {
		const result = await c8(
			"assign",
			"role",
			"admin",
			"--dry-run",
			"--to-user",
			"alice",
			"--to-group",
			"ops",
			"--to-tenant",
			"t1",
		);
		assert.strictEqual(result.status, 1);
		assert.ok(
			result.stderr.includes("Exactly one target flag"),
			`stderr: ${result.stderr}`,
		);
		// stdout must NOT contain the JSON payload that a successful dry-run
		// would emit — validation must short-circuit before the logger.json call.
		assert.strictEqual(
			result.stdout.trim(),
			"",
			`stdout should be empty on validation failure, got: ${result.stdout}`,
		);
	});

	test("--dry-run encodes special characters in path segments", async () => {
		const result = await c8(
			"assign",
			"user",
			"alice@example.com",
			"--dry-run",
			"--to-group",
			"my group",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);
		const url = getUrl(out);
		assert.ok(
			url.includes(encodeURIComponent("alice@example.com")),
			`expected URL to contain encoded id, got: ${url}`,
		);
		assert.ok(
			url.includes(encodeURIComponent("my group")),
			`expected URL to contain encoded target value, got: ${url}`,
		);
	});

	test("rejects unsupported assign resource type", async () => {
		const result = await c8("assign", "bogus", "id", "--to-user", "alice");
		assert.strictEqual(result.status, 1);
		assert.ok(
			result.stderr.includes("Cannot assign resource type: bogus"),
			`stderr: ${result.stderr}`,
		);
	});

	test("rejects unsupported target flag for the resource (user --to-user)", async () => {
		// The `user` resource permits --to-group / --to-tenant only;
		// --to-user is rejected because you can't assign a user to another user.
		const result = await c8("assign", "user", "alice", "--to-user", "bob");
		assert.strictEqual(result.status, 1);
		assert.ok(
			result.stderr.includes("Unsupported target flag"),
			`stderr: ${result.stderr}`,
		);
	});
});

describe("CLI behavioural: unassign — error paths", () => {
	test("rejects when multiple --from-* flags are provided", async () => {
		const result = await c8(
			"unassign",
			"user",
			"alice",
			"--from-group",
			"ops",
			"--from-tenant",
			"t1",
		);
		assert.strictEqual(result.status, 1);
		assert.ok(
			result.stderr.includes("--from-group") &&
				result.stderr.includes("--from-tenant"),
			`stderr: ${result.stderr}`,
		);
	});
});

// ─── Defect class: dry-run schema consistency ────────────────────────────────
//
// Every mutating identity command's `--dry-run` output must include
// { dryRun, command, method, url, body }. Class-scoped (not per-command) so a
// new `create|delete <identity-resource>` handler that forgets the `body`
// field is rejected by this guard rather than slipping through.

describe("Defect class: identity --dry-run output includes body field", () => {
	const REQUIRED_DRY_RUN_KEYS = [
		"dryRun",
		"command",
		"method",
		"url",
		"body",
	] as const;

	function assertDryRunSchema(out: Record<string, unknown>, label: string) {
		for (const key of REQUIRED_DRY_RUN_KEYS) {
			assert.ok(
				key in out,
				`${label}: dry-run output missing required key '${key}'. Got keys: ${Object.keys(out).join(", ")}`,
			);
		}
	}

	// DELETE commands — body must be present and equal to null
	const DELETE_CASES: Array<{ resource: string; positional: string }> = [
		{ resource: "user", positional: "alice" },
		{ resource: "role", positional: "admin" },
		{ resource: "group", positional: "ops" },
		{ resource: "tenant", positional: "t1" },
		{ resource: "mapping-rule", positional: "rule-1" },
		{ resource: "authorization", positional: "42" },
	];
	for (const { resource, positional } of DELETE_CASES) {
		test(`delete ${resource} --dry-run includes body: null`, async () => {
			const result = await c8("delete", resource, "--dry-run", positional);
			assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
			const out = parseJson(result);
			assertDryRunSchema(out, `delete ${resource}`);
			assert.strictEqual(out.body, null);
		});
	}

	// CREATE commands — body must be present and an object
	const CREATE_CASES: Array<{ resource: string; flags: string[] }> = [
		{
			resource: "user",
			flags: ["--username", "alice", "--password", "pw"],
		},
		{
			resource: "role",
			flags: ["--roleId", "admin-role", "--name", "admin"],
		},
		{
			resource: "group",
			flags: ["--groupId", "devs", "--name", "Developers"],
		},
		{
			resource: "tenant",
			flags: ["--tenantId", "acme", "--name", "ACME"],
		},
		{
			resource: "mapping-rule",
			flags: [
				"--mappingRuleId",
				"rule-1",
				"--name",
				"Rule",
				"--claimName",
				"groups",
				"--claimValue",
				"admin",
			],
		},
		{
			resource: "authorization",
			flags: [
				"--ownerId",
				"alice",
				"--ownerType",
				"USER",
				"--resourceType",
				"PROCESS_DEFINITION",
				"--resourceId",
				"my-process",
				"--permissions",
				"READ",
			],
		},
	];
	for (const { resource, flags } of CREATE_CASES) {
		test(`create ${resource} --dry-run includes body object`, async () => {
			const result = await c8("create", resource, "--dry-run", ...flags);
			assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
			const out = parseJson(result);
			assertDryRunSchema(out, `create ${resource}`);
			assert.ok(
				typeof out.body === "object" && out.body !== null,
				`create ${resource}: body must be a non-null object, got ${JSON.stringify(out.body)}`,
			);
		});
	}
});

// ─── Defect class: assign target-map ↔ switch consistency ────────────────────
//
// Every (resource, --to-*) combo declared by the assign dispatcher must
// produce a valid dry-run. If a combo appears in the allowed-targets map but
// has no corresponding switch arm in the non-dry-run path, the combo will
// fail end-to-end. Class-scoped so a future map entry without a wired-up
// implementation is caught immediately.

describe("Defect class: assign — every allowed (resource, target) combo dry-runs", () => {
	const VALID_ASSIGN_COMBOS: Array<{
		resource: string;
		flag: string;
		value: string;
	}> = [
		{ resource: "role", flag: "--to-user", value: "alice" },
		{ resource: "role", flag: "--to-group", value: "ops" },
		{ resource: "role", flag: "--to-tenant", value: "t1" },
		{ resource: "role", flag: "--to-mapping-rule", value: "mr1" },
		{ resource: "user", flag: "--to-group", value: "ops" },
		{ resource: "user", flag: "--to-tenant", value: "t1" },
		{ resource: "group", flag: "--to-tenant", value: "t1" },
		{ resource: "mapping-rule", flag: "--to-group", value: "ops" },
		{ resource: "mapping-rule", flag: "--to-tenant", value: "t1" },
	];

	for (const { resource, flag, value } of VALID_ASSIGN_COMBOS) {
		test(`assign ${resource} ${flag}=${value} produces valid dry-run output`, async () => {
			const result = await c8(
				"assign",
				resource,
				"test-id",
				"--dry-run",
				flag,
				value,
			);
			assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
			const out = parseJson(result);
			assert.strictEqual(out.dryRun, true);
			assert.strictEqual(out.command, "assign");
			assert.strictEqual(out.method, "POST");
			assert.ok(
				typeof out.url === "string" && out.url.length > 0,
				`expected non-empty url, got: ${JSON.stringify(out.url)}`,
			);
		});
	}
});
