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
import { asRecord } from "../utils/guards.ts";

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
		assert.ok((out.url as string).endsWith("/users"));

		const body = asRecord(out.body, "dry-run body");
		assert.strictEqual(body.username, "alice");
		// password is redacted by sanitizeForLogging
		assert.ok(
			body.password !== undefined,
			"body should include password field",
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
		assert.ok((out.url as string).endsWith("/users/alice"));
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
		assert.ok((out.url as string).endsWith("/roles"));

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
		assert.ok((out.url as string).endsWith("/roles/admin"));
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
		assert.ok((out.url as string).endsWith("/groups"));

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
		assert.ok((out.url as string).endsWith("/groups/devs"));
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
		assert.ok((out.url as string).endsWith("/tenants"));

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
		assert.ok((out.url as string).endsWith("/tenants/acme"));
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
		assert.ok((out.url as string).endsWith("/mapping-rules"));

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
		assert.ok((out.url as string).endsWith("/mapping-rules/rule-1"));
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
		assert.ok((out.url as string).includes("/roles/admin/"));
		assert.ok((out.url as string).includes("alice"));
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
		assert.ok((out.url as string).includes("/roles/admin/"));
		assert.ok((out.url as string).includes("devs"));
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
		assert.ok(
			(out.url as string).includes("alice") ||
				(out.url as string).includes("acme"),
		);
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
		assert.ok(
			(out.url as string).includes("alice") ||
				(out.url as string).includes("ops"),
		);
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
		assert.ok((out.url as string).includes("/roles/admin/"));
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
