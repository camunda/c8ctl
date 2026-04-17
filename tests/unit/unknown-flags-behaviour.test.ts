/**
 * CLI behavioural tests for unknown-flag detection.
 *
 * These tests exercise the full dispatch path by spawning the CLI
 * as a subprocess with --dry-run. They verify that:
 *   1. Unknown flags emit a warning on stderr
 *   2. The warning message names the offending flag(s)
 *   3. The command still succeeds (exit 0) — unknown flags are warnings, not errors
 *   4. Valid flags do NOT trigger warnings
 *   5. Detection works for every verb category (search, list, get, create, etc.)
 */

import assert from "node:assert";
import { describe, test } from "node:test";
import { c8 } from "../utils/cli.ts";

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Parse a JSON-mode warning line from stderr. */
function parseWarning(
	stderr: string,
): { status: string; message: string } | null {
	for (const line of stderr.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const parsed = JSON.parse(trimmed);
			if (parsed.status === "warning") return parsed;
		} catch {
			// text-mode or non-JSON line — skip
		}
	}
	return null;
}

/** Assert stderr contains NO unknown-flag warning. */
function assertNoWarning(stderr: string): void {
	const warning = parseWarning(stderr);
	if (warning?.message.includes("not recognized")) {
		assert.fail(`Unexpected unknown-flag warning: ${warning.message}`);
	}
}

/** Assert stderr contains an unknown-flag warning mentioning the given flag(s). */
function assertWarning(stderr: string, ...flags: string[]): void {
	const warning = parseWarning(stderr);
	assert.ok(
		warning,
		`Expected unknown-flag warning in stderr but got none.\nstderr: ${stderr}`,
	);
	for (const flag of flags) {
		assert.ok(
			warning.message.includes(`--${flag}`),
			`Expected warning to mention "--${flag}" but got: ${warning.message}`,
		);
	}
	assert.ok(
		warning.message.includes("not recognized"),
		`Expected warning to say "not recognized" but got: ${warning.message}`,
	);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Search — resource-scoped detection
// ═══════════════════════════════════════════════════════════════════════════════

describe("CLI behavioural: unknown flags — search", () => {
	test("warns on unknown flag for search process-instances", async () => {
		const result = await c8("search", "pi", "--dry-run", "--bogus", "val");
		assert.strictEqual(result.status, 0, `Non-zero exit: ${result.stderr}`);
		assertWarning(result.stderr, "bogus");
	});

	test("warns on unknown flag for search process-definitions", async () => {
		const result = await c8("search", "pd", "--dry-run", "--bogus", "val");
		assert.strictEqual(result.status, 0, `Non-zero exit: ${result.stderr}`);
		assertWarning(result.stderr, "bogus");
	});

	test("warns on unknown flag for search user-tasks", async () => {
		const result = await c8("search", "ut", "--dry-run", "--bogus", "val");
		assert.strictEqual(result.status, 0, `Non-zero exit: ${result.stderr}`);
		assertWarning(result.stderr, "bogus");
	});

	test("warns on unknown flag for search incidents", async () => {
		const result = await c8("search", "inc", "--dry-run", "--bogus", "val");
		assert.strictEqual(result.status, 0, `Non-zero exit: ${result.stderr}`);
		assertWarning(result.stderr, "bogus");
	});

	test("warns on unknown flag for search jobs", async () => {
		const result = await c8("search", "jobs", "--dry-run", "--bogus", "val");
		assert.strictEqual(result.status, 0, `Non-zero exit: ${result.stderr}`);
		assertWarning(result.stderr, "bogus");
	});

	test("warns on unknown flag for search variables", async () => {
		const result = await c8("search", "vars", "--dry-run", "--bogus", "val");
		assert.strictEqual(result.status, 0, `Non-zero exit: ${result.stderr}`);
		assertWarning(result.stderr, "bogus");
	});

	test("warns with multiple unknown flags", async () => {
		const result = await c8(
			"search",
			"pi",
			"--dry-run",
			"--bogus",
			"val",
			"--fake",
			"val2",
		);
		assert.strictEqual(result.status, 0, `Non-zero exit: ${result.stderr}`);
		assertWarning(result.stderr, "bogus", "fake");
	});

	test("warning message includes verb and resource", async () => {
		const result = await c8("search", "pi", "--dry-run", "--bogus", "val");
		assert.strictEqual(result.status, 0, `Non-zero exit: ${result.stderr}`);
		const warning = parseWarning(result.stderr);
		assert.ok(warning);
		assert.ok(
			warning.message.includes("'search pi'") ||
				warning.message.includes("'search process-instance'"),
			`Warning should mention the command, got: ${warning.message}`,
		);
	});

	// ─── cross-resource detection: a flag valid for one resource is unknown on another ───

	test("--assignee is valid for user-tasks but unknown for process-instances", async () => {
		const utResult = await c8(
			"search",
			"ut",
			"--dry-run",
			"--assignee",
			"john",
		);
		assert.strictEqual(utResult.status, 0, `stderr: ${utResult.stderr}`);
		assertNoWarning(utResult.stderr);

		const piResult = await c8(
			"search",
			"pi",
			"--dry-run",
			"--assignee",
			"john",
		);
		assert.strictEqual(piResult.status, 0, `stderr: ${piResult.stderr}`);
		assertWarning(piResult.stderr, "assignee");
	});

	test("--state is valid for process-instances but unknown for variables", async () => {
		const piResult = await c8("search", "pi", "--dry-run", "--state", "ACTIVE");
		assert.strictEqual(piResult.status, 0, `stderr: ${piResult.stderr}`);
		assertNoWarning(piResult.stderr);

		const varResult = await c8(
			"search",
			"vars",
			"--dry-run",
			"--state",
			"ACTIVE",
		);
		assert.strictEqual(varResult.status, 0, `stderr: ${varResult.stderr}`);
		assertWarning(varResult.stderr, "state");
	});

	// ─── valid flags should NOT warn ──────────────────────────────────────────────

	test("no warning for valid resource-specific flag (--state on pi)", async () => {
		const result = await c8("search", "pi", "--dry-run", "--state", "ACTIVE");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assertNoWarning(result.stderr);
	});

	test("no warning for valid global flag (--profile)", async () => {
		const result = await c8("search", "pi", "--dry-run", "--profile", "dev");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assertNoWarning(result.stderr);
	});

	test("no warning for shared search flag (--sortBy)", async () => {
		const result = await c8(
			"search",
			"pi",
			"--dry-run",
			"--sortBy",
			"startDate",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assertNoWarning(result.stderr);
	});

	test("no warning for --limit on search", async () => {
		const result = await c8("search", "pi", "--dry-run", "--limit", "10");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assertNoWarning(result.stderr);
	});

	test("no warning for --between on search", async () => {
		const result = await c8(
			"search",
			"pi",
			"--dry-run",
			"--between",
			"2024-01-01..2024-12-31",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assertNoWarning(result.stderr);
	});
});

// ═══════════════════════════════════════════════════════════════════════════════
//  List — shares resource-scoped detection with search
// ═══════════════════════════════════════════════════════════════════════════════

describe("CLI behavioural: unknown flags — list", () => {
	test("warns on unknown flag for list process-instances", async () => {
		const result = await c8("list", "pi", "--dry-run", "--bogus", "val");
		assert.strictEqual(result.status, 0, `Non-zero exit: ${result.stderr}`);
		assertWarning(result.stderr, "bogus");
	});

	test("no warning for valid flag (--state on list pi)", async () => {
		const result = await c8("list", "pi", "--dry-run", "--state", "ACTIVE");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assertNoWarning(result.stderr);
	});

	test("no warning for list-specific --all flag", async () => {
		const result = await c8("list", "pi", "--dry-run", "--all");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assertNoWarning(result.stderr);
	});

	test("--all is unknown for search (list-only flag)", async () => {
		const result = await c8("search", "pi", "--dry-run", "--all");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assertWarning(result.stderr, "all");
	});
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Get — verb-level detection
// ═══════════════════════════════════════════════════════════════════════════════

describe("CLI behavioural: unknown flags — get", () => {
	test("warns on unknown flag for get", async () => {
		const result = await c8(
			"get",
			"pd",
			"12345",
			"--dry-run",
			"--bogus",
			"val",
		);
		assert.strictEqual(result.status, 0, `Non-zero exit: ${result.stderr}`);
		assertWarning(result.stderr, "bogus");
	});

	test("no warning for valid --xml flag on get pd", async () => {
		const result = await c8("get", "pd", "12345", "--dry-run", "--xml");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assertNoWarning(result.stderr);
	});

	test("no warning for global flags on get", async () => {
		const result = await c8(
			"get",
			"pd",
			"12345",
			"--dry-run",
			"--profile",
			"dev",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assertNoWarning(result.stderr);
	});

	test("--state is unknown for get (search-only flag)", async () => {
		const result = await c8(
			"get",
			"pd",
			"12345",
			"--dry-run",
			"--state",
			"ACTIVE",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assertWarning(result.stderr, "state");
	});
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Create — verb-level detection
// ═══════════════════════════════════════════════════════════════════════════════

describe("CLI behavioural: unknown flags — create", () => {
	test("warns on unknown flag for create pi", async () => {
		const result = await c8(
			"create",
			"pi",
			"--dry-run",
			"--id",
			"my-process",
			"--bogus",
			"val",
		);
		assert.strictEqual(result.status, 0, `Non-zero exit: ${result.stderr}`);
		assertWarning(result.stderr, "bogus");
	});

	test("no warning for valid --variables flag on create pi", async () => {
		const result = await c8(
			"create",
			"pi",
			"--dry-run",
			"--id",
			"my-process",
			"--variables",
			"{}",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assertNoWarning(result.stderr);
	});

	test("--sortBy is unknown for create (search-only flag)", async () => {
		const result = await c8(
			"create",
			"pi",
			"--dry-run",
			"--id",
			"my-process",
			"--sortBy",
			"startDate",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assertWarning(result.stderr, "sortBy");
	});
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Delete — has no verb-specific flags
// ═══════════════════════════════════════════════════════════════════════════════

describe("CLI behavioural: unknown flags — delete", () => {
	test("warns on any non-global flag for delete", async () => {
		const result = await c8(
			"delete",
			"user",
			"user-key-123",
			"--dry-run",
			"--name",
			"test",
		);
		assert.strictEqual(result.status, 0, `Non-zero exit: ${result.stderr}`);
		assertWarning(result.stderr, "name");
	});

	test("no warning for global flags on delete", async () => {
		const result = await c8(
			"delete",
			"user",
			"user-key-123",
			"--dry-run",
			"--profile",
			"dev",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assertNoWarning(result.stderr);
	});
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Cancel — has no verb-specific flags
// ═══════════════════════════════════════════════════════════════════════════════

describe("CLI behavioural: unknown flags — cancel", () => {
	test("warns on any non-global flag for cancel", async () => {
		const result = await c8(
			"cancel",
			"pi",
			"12345",
			"--dry-run",
			"--reason",
			"test",
		);
		assert.strictEqual(result.status, 0, `Non-zero exit: ${result.stderr}`);
		assertWarning(result.stderr, "reason");
	});

	test("no warning for global flags on cancel", async () => {
		const result = await c8(
			"cancel",
			"pi",
			"12345",
			"--dry-run",
			"--profile",
			"dev",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assertNoWarning(result.stderr);
	});
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Complete — verb-level detection
// ═══════════════════════════════════════════════════════════════════════════════

describe("CLI behavioural: unknown flags — complete", () => {
	test("warns on unknown flag for complete", async () => {
		const result = await c8(
			"complete",
			"ut",
			"12345",
			"--dry-run",
			"--bogus",
			"val",
		);
		assert.strictEqual(result.status, 0, `Non-zero exit: ${result.stderr}`);
		assertWarning(result.stderr, "bogus");
	});

	test("no warning for valid --variables flag on complete", async () => {
		const result = await c8(
			"complete",
			"ut",
			"12345",
			"--dry-run",
			"--variables",
			"{}",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assertNoWarning(result.stderr);
	});
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Fail — verb-level detection
// ═══════════════════════════════════════════════════════════════════════════════

describe("CLI behavioural: unknown flags — fail", () => {
	test("warns on unknown flag for fail job", async () => {
		const result = await c8(
			"fail",
			"job",
			"12345",
			"--dry-run",
			"--bogus",
			"val",
		);
		assert.strictEqual(result.status, 0, `Non-zero exit: ${result.stderr}`);
		assertWarning(result.stderr, "bogus");
	});

	test("no warning for valid --retries flag on fail", async () => {
		const result = await c8(
			"fail",
			"job",
			"12345",
			"--dry-run",
			"--retries",
			"3",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assertNoWarning(result.stderr);
	});

	test("--variables is unknown for fail (complete-only flag)", async () => {
		const result = await c8(
			"fail",
			"job",
			"12345",
			"--dry-run",
			"--variables",
			"{}",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assertWarning(result.stderr, "variables");
	});
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Activate — verb-level detection
// ═══════════════════════════════════════════════════════════════════════════════

describe("CLI behavioural: unknown flags — activate", () => {
	test("warns on unknown flag for activate jobs", async () => {
		const result = await c8(
			"activate",
			"jobs",
			"email",
			"--dry-run",
			"--bogus",
			"val",
		);
		assert.strictEqual(result.status, 0, `Non-zero exit: ${result.stderr}`);
		assertWarning(result.stderr, "bogus");
	});

	test("no warning for valid --worker flag on activate", async () => {
		const result = await c8(
			"activate",
			"jobs",
			"email",
			"--dry-run",
			"--worker",
			"w1",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assertNoWarning(result.stderr);
	});
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Resolve — has no verb-specific flags
// ═══════════════════════════════════════════════════════════════════════════════

describe("CLI behavioural: unknown flags — resolve", () => {
	test("warns on any non-global flag for resolve", async () => {
		const result = await c8(
			"resolve",
			"inc",
			"12345",
			"--dry-run",
			"--errorMessage",
			"test",
		);
		assert.strictEqual(result.status, 0, `Non-zero exit: ${result.stderr}`);
		assertWarning(result.stderr, "errorMessage");
	});

	test("no warning for global flags on resolve", async () => {
		const result = await c8(
			"resolve",
			"inc",
			"12345",
			"--dry-run",
			"--profile",
			"dev",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assertNoWarning(result.stderr);
	});
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Publish — verb-level detection
// ═══════════════════════════════════════════════════════════════════════════════

describe("CLI behavioural: unknown flags — publish", () => {
	test("warns on unknown flag for publish message", async () => {
		const result = await c8(
			"publish",
			"msg",
			"my-message",
			"--dry-run",
			"--bogus",
			"val",
		);
		assert.strictEqual(result.status, 0, `Non-zero exit: ${result.stderr}`);
		assertWarning(result.stderr, "bogus");
	});

	test("no warning for valid --correlationKey flag on publish", async () => {
		const result = await c8(
			"publish",
			"msg",
			"my-message",
			"--dry-run",
			"--correlationKey",
			"k1",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assertNoWarning(result.stderr);
	});
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Edge cases
// ═══════════════════════════════════════════════════════════════════════════════

describe("CLI behavioural: unknown flags — edge cases", () => {
	test("--dry-run itself is never flagged as unknown", async () => {
		const result = await c8("search", "pi", "--dry-run");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assertNoWarning(result.stderr);
	});

	test("--verbose is never flagged as unknown", async () => {
		const result = await c8("search", "pi", "--dry-run", "--verbose");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assertNoWarning(result.stderr);
	});

	test("--help is never flagged as unknown", async () => {
		const result = await c8("search", "--help");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assertNoWarning(result.stderr);
	});

	test("unknown flag warning does not prevent dry-run output", async () => {
		const result = await c8("search", "pi", "--dry-run", "--bogus", "val");
		assert.strictEqual(result.status, 0, `Non-zero exit: ${result.stderr}`);
		assertWarning(result.stderr, "bogus");
		// stdout should still contain the dry-run JSON
		const out = JSON.parse(result.stdout);
		assert.strictEqual(out.dryRun, true);
		assert.strictEqual(out.method, "POST");
	});
});
