/**
 * CLI behavioural tests for read-only commands (list, search, get).
 *
 * These tests exercise the full dispatch path by spawning the CLI
 * as a subprocess with --dry-run. They verify that the dry-run preview
 * emits the correct method, endpoint, and filter body for every
 * list/search/get command.
 */

import assert from "node:assert";
import { describe, test } from "node:test";
import { c8, parseJson } from "../utils/cli.ts";
import { getFilter } from "../utils/guards.ts";

// ─── helpers ─────────────────────────────────────────────────────────────────

function assertDryRun(
	out: Record<string, unknown>,
	expected: { method: string; urlSuffix: string },
) {
	assert.strictEqual(out.dryRun, true);
	assert.strictEqual(out.method, expected.method);
	assert.ok(
		typeof out.url === "string" && out.url.endsWith(expected.urlSuffix),
		`Expected URL to end with "${expected.urlSuffix}", got "${String(out.url)}"`,
	);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Process Instances
// ═══════════════════════════════════════════════════════════════════════════════

describe("CLI behavioural: list process-instances", () => {
	test("--dry-run emits POST to /process-instances/search", async () => {
		const result = await c8("list", "pi", "--dry-run");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assertDryRun(parseJson(result), {
			method: "POST",
			urlSuffix: "/process-instances/search",
		});
	});

	test("--dry-run works with full resource name", async () => {
		const result = await c8("list", "process-instances", "--dry-run");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assertDryRun(parseJson(result), {
			method: "POST",
			urlSuffix: "/process-instances/search",
		});
	});
});

describe("CLI behavioural: search process-instances", () => {
	test("--dry-run emits POST with state filter", async () => {
		const result = await c8("search", "pi", "--dry-run", "--state", "ACTIVE");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);
		assertDryRun(out, {
			method: "POST",
			urlSuffix: "/process-instances/search",
		});
		assert.strictEqual(getFilter(out).state, "ACTIVE");
	});

	test("--dry-run includes processDefinitionId filter", async () => {
		const result = await c8("search", "pi", "--dry-run", "--id", "my-process");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);
		assert.strictEqual(getFilter(out).processDefinitionId, "my-process");
	});

	test("--dry-run includes date range filter", async () => {
		const result = await c8(
			"search",
			"process-instances",
			"--dry-run",
			"--between",
			"2024-01-01..2024-12-31",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);
		assert.ok(getFilter(out).startDate, "Expected startDate filter");
	});
});

describe("CLI behavioural: get process-instance", () => {
	test("--dry-run emits GET to /process-instances/:key", async () => {
		const result = await c8("get", "pi", "--dry-run", "12345");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assertDryRun(parseJson(result), {
			method: "GET",
			urlSuffix: "/process-instances/12345",
		});
	});

	test("--dry-run works with full resource name", async () => {
		const result = await c8("get", "process-instance", "--dry-run", "99999");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assertDryRun(parseJson(result), {
			method: "GET",
			urlSuffix: "/process-instances/99999",
		});
	});
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Process Definitions
// ═══════════════════════════════════════════════════════════════════════════════

describe("CLI behavioural: list process-definitions", () => {
	test("--dry-run emits POST to /process-definitions/search", async () => {
		const result = await c8("list", "pd", "--dry-run");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assertDryRun(parseJson(result), {
			method: "POST",
			urlSuffix: "/process-definitions/search",
		});
	});
});

describe("CLI behavioural: search process-definitions", () => {
	test("--dry-run emits POST with name filter", async () => {
		const result = await c8(
			"search",
			"pd",
			"--dry-run",
			"--name",
			"My Process",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);
		assertDryRun(out, {
			method: "POST",
			urlSuffix: "/process-definitions/search",
		});
		assert.strictEqual(getFilter(out).name, "My Process");
	});

	test("--dry-run includes processDefinitionId filter", async () => {
		const result = await c8(
			"search",
			"process-definitions",
			"--dry-run",
			"--id",
			"order-process",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);
		assert.strictEqual(getFilter(out).processDefinitionId, "order-process");
	});
});

describe("CLI behavioural: get process-definition", () => {
	test("--dry-run emits GET to /process-definitions/:key", async () => {
		const result = await c8("get", "pd", "--dry-run", "54321");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assertDryRun(parseJson(result), {
			method: "GET",
			urlSuffix: "/process-definitions/54321",
		});
	});

	test("--dry-run with --xml emits GET to /process-definitions/:key/xml", async () => {
		const result = await c8("get", "pd", "--dry-run", "--xml", "54321");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assertDryRun(parseJson(result), {
			method: "GET",
			urlSuffix: "/process-definitions/54321/xml",
		});
	});
});

// ═══════════════════════════════════════════════════════════════════════════════
//  User Tasks
// ═══════════════════════════════════════════════════════════════════════════════

describe("CLI behavioural: list user-tasks", () => {
	test("--dry-run emits POST to /user-tasks/search", async () => {
		const result = await c8("list", "ut", "--dry-run");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assertDryRun(parseJson(result), {
			method: "POST",
			urlSuffix: "/user-tasks/search",
		});
	});
});

describe("CLI behavioural: search user-tasks", () => {
	test("--dry-run emits POST with state filter", async () => {
		const result = await c8("search", "ut", "--dry-run", "--state", "CREATED");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);
		assertDryRun(out, { method: "POST", urlSuffix: "/user-tasks/search" });
		assert.strictEqual(getFilter(out).state, "CREATED");
	});

	test("--dry-run includes assignee filter", async () => {
		const result = await c8(
			"search",
			"user-tasks",
			"--dry-run",
			"--assignee",
			"alice",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);
		assert.strictEqual(getFilter(out).assignee, "alice");
	});
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Incidents
// ═══════════════════════════════════════════════════════════════════════════════

describe("CLI behavioural: list incidents", () => {
	test("--dry-run emits POST to /incidents/search", async () => {
		const result = await c8("list", "inc", "--dry-run");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assertDryRun(parseJson(result), {
			method: "POST",
			urlSuffix: "/incidents/search",
		});
	});
});

describe("CLI behavioural: search incidents", () => {
	test("--dry-run emits POST with state filter", async () => {
		const result = await c8("search", "inc", "--dry-run", "--state", "ACTIVE");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);
		assertDryRun(out, { method: "POST", urlSuffix: "/incidents/search" });
		assert.strictEqual(getFilter(out).state, "ACTIVE");
	});
});

describe("CLI behavioural: get incident", () => {
	test("--dry-run emits GET to /incidents/:key", async () => {
		const result = await c8("get", "inc", "--dry-run", "77777");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assertDryRun(parseJson(result), {
			method: "GET",
			urlSuffix: "/incidents/77777",
		});
	});
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Jobs
// ═══════════════════════════════════════════════════════════════════════════════

describe("CLI behavioural: search jobs", () => {
	test("--dry-run emits POST to /jobs/search with state filter", async () => {
		const result = await c8(
			"search",
			"jobs",
			"--dry-run",
			"--state",
			"ACTIVATABLE",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);
		assertDryRun(out, { method: "POST", urlSuffix: "/jobs/search" });
		assert.strictEqual(getFilter(out).state, "ACTIVATABLE");
	});

	test("--dry-run includes type filter", async () => {
		const result = await c8(
			"search",
			"jobs",
			"--dry-run",
			"--type",
			"send-email",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);
		assert.strictEqual(getFilter(out).type, "send-email");
	});
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Variables
// ═══════════════════════════════════════════════════════════════════════════════

describe("CLI behavioural: search variables", () => {
	test("--dry-run emits POST to /variables/search with name filter", async () => {
		const result = await c8("search", "vars", "--dry-run", "--name", "orderId");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);
		assertDryRun(out, { method: "POST", urlSuffix: "/variables/search" });
		assert.strictEqual(getFilter(out).name, "orderId");
	});
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Identity: Users
// ═══════════════════════════════════════════════════════════════════════════════

describe("CLI behavioural: list users", () => {
	test("--dry-run emits POST to /users/search", async () => {
		const result = await c8("list", "users", "--dry-run");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assertDryRun(parseJson(result), {
			method: "POST",
			urlSuffix: "/users/search",
		});
	});
});

describe("CLI behavioural: search users", () => {
	test("--dry-run emits POST with username filter", async () => {
		const result = await c8(
			"search",
			"users",
			"--dry-run",
			"--username",
			"alice",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);
		assertDryRun(out, { method: "POST", urlSuffix: "/users/search" });
		assert.strictEqual(getFilter(out).username, "alice");
	});
});

describe("CLI behavioural: get user", () => {
	test("--dry-run emits GET to /users/:username", async () => {
		const result = await c8("get", "user", "--dry-run", "alice");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assertDryRun(parseJson(result), {
			method: "GET",
			urlSuffix: "/users/alice",
		});
	});
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Identity: Roles
// ═══════════════════════════════════════════════════════════════════════════════

describe("CLI behavioural: list roles", () => {
	test("--dry-run emits POST to /roles/search", async () => {
		const result = await c8("list", "roles", "--dry-run");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assertDryRun(parseJson(result), {
			method: "POST",
			urlSuffix: "/roles/search",
		});
	});
});

describe("CLI behavioural: search roles", () => {
	test("--dry-run emits POST with name filter", async () => {
		const result = await c8("search", "roles", "--dry-run", "--name", "admin");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);
		assertDryRun(out, { method: "POST", urlSuffix: "/roles/search" });
		assert.strictEqual(getFilter(out).name, "admin");
	});
});

describe("CLI behavioural: get role", () => {
	test("--dry-run emits GET to /roles/:roleId", async () => {
		const result = await c8("get", "role", "--dry-run", "admin-role");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assertDryRun(parseJson(result), {
			method: "GET",
			urlSuffix: "/roles/admin-role",
		});
	});
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Identity: Groups
// ═══════════════════════════════════════════════════════════════════════════════

describe("CLI behavioural: list groups", () => {
	test("--dry-run emits POST to /groups/search", async () => {
		const result = await c8("list", "groups", "--dry-run");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assertDryRun(parseJson(result), {
			method: "POST",
			urlSuffix: "/groups/search",
		});
	});
});

describe("CLI behavioural: search groups", () => {
	test("--dry-run emits POST with name filter", async () => {
		const result = await c8(
			"search",
			"groups",
			"--dry-run",
			"--name",
			"engineering",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);
		assertDryRun(out, { method: "POST", urlSuffix: "/groups/search" });
		assert.strictEqual(getFilter(out).name, "engineering");
	});
});

describe("CLI behavioural: get group", () => {
	test("--dry-run emits GET to /groups/:groupId", async () => {
		const result = await c8("get", "group", "--dry-run", "eng-group");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assertDryRun(parseJson(result), {
			method: "GET",
			urlSuffix: "/groups/eng-group",
		});
	});
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Identity: Tenants
// ═══════════════════════════════════════════════════════════════════════════════

describe("CLI behavioural: list tenants", () => {
	test("--dry-run emits POST to /tenants/search", async () => {
		const result = await c8("list", "tenants", "--dry-run");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assertDryRun(parseJson(result), {
			method: "POST",
			urlSuffix: "/tenants/search",
		});
	});
});

describe("CLI behavioural: search tenants", () => {
	test("--dry-run emits POST with name filter", async () => {
		const result = await c8("search", "tenants", "--dry-run", "--name", "acme");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);
		assertDryRun(out, { method: "POST", urlSuffix: "/tenants/search" });
		assert.strictEqual(getFilter(out).name, "acme");
	});
});

describe("CLI behavioural: get tenant", () => {
	test("--dry-run emits GET to /tenants/:tenantId", async () => {
		const result = await c8("get", "tenant", "--dry-run", "acme-tenant");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assertDryRun(parseJson(result), {
			method: "GET",
			urlSuffix: "/tenants/acme-tenant",
		});
	});
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Identity: Authorizations
// ═══════════════════════════════════════════════════════════════════════════════

describe("CLI behavioural: list authorizations", () => {
	test("--dry-run emits POST to /authorizations/search", async () => {
		const result = await c8("list", "auth", "--dry-run");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assertDryRun(parseJson(result), {
			method: "POST",
			urlSuffix: "/authorizations/search",
		});
	});
});

describe("CLI behavioural: search authorizations", () => {
	test("--dry-run emits POST with ownerId filter", async () => {
		const result = await c8(
			"search",
			"auth",
			"--dry-run",
			"--ownerId",
			"alice",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);
		assertDryRun(out, { method: "POST", urlSuffix: "/authorizations/search" });
		assert.strictEqual(getFilter(out).ownerId, "alice");
	});
});

describe("CLI behavioural: get authorization", () => {
	test("--dry-run emits GET to /authorizations/:key", async () => {
		const result = await c8("get", "auth", "--dry-run", "12345");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assertDryRun(parseJson(result), {
			method: "GET",
			urlSuffix: "/authorizations/12345",
		});
	});
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Identity: Mapping Rules
// ═══════════════════════════════════════════════════════════════════════════════

describe("CLI behavioural: list mapping-rules", () => {
	test("--dry-run emits POST to /mapping-rules/search", async () => {
		const result = await c8("list", "mr", "--dry-run");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assertDryRun(parseJson(result), {
			method: "POST",
			urlSuffix: "/mapping-rules/search",
		});
	});
});

describe("CLI behavioural: search mapping-rules", () => {
	test("--dry-run emits POST with name filter", async () => {
		const result = await c8("search", "mr", "--dry-run", "--name", "my-rule");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);
		assertDryRun(out, { method: "POST", urlSuffix: "/mapping-rules/search" });
		assert.strictEqual(getFilter(out).name, "my-rule");
	});
});

describe("CLI behavioural: get mapping-rule", () => {
	test("--dry-run emits GET to /mapping-rules/:id", async () => {
		const result = await c8("get", "mr", "--dry-run", "rule-42");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assertDryRun(parseJson(result), {
			method: "GET",
			urlSuffix: "/mapping-rules/rule-42",
		});
	});
});
