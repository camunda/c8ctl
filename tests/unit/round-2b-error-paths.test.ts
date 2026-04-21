/**
 * Post-refactor framework-prefix assertions for Round 2b of the
 * `process.exit` migration (issue #300).
 *
 * The companion baseline file `tests/unit/round-2b-baseline.test.ts`
 * locks in the invariants that must hold both BEFORE and AFTER the
 * refactor (exit code + original error message). This file adds the
 * single new assertion the refactor enables: the framework's
 * `Failed to <verb> <resource>` prefix now appears in stderr.
 *
 * That prefix string is constructed by `defineCommand` in
 * `command-framework.ts` and passed into `handleCommandError` in
 * `src/errors.ts`, and CANNOT appear if the helper called
 * `process.exit(1)` directly.
 * Its presence is the durable behavioural confirmation that each migrated
 * call site is wired through the framework's error pipeline.
 *
 * One assertion per migrated handler is sufficient (the cross-handler
 * architectural guard in `tests/unit/no-process-exit-in-handlers.test.ts`
 * is the durable class-of-defect catch for the exit-vs-throw invariant).
 *
 * For the two `session.ts` free functions (`useProfile`, `setOutputFormat`)
 * the throw is caught by the `defineCommand` wrapper around them
 * (`useProfileCommand`, `outputCommand`), so the framework prefix
 * applies to those paths too.
 */

import assert from "node:assert";
import { describe, test } from "node:test";
import { c8 } from "../utils/cli.ts";
import type { SpawnResult } from "../utils/spawn.ts";

function assertFrameworkPrefix(
	result: SpawnResult,
	prefix: string,
	context: string,
): void {
	assert.ok(
		result.stderr.includes(prefix),
		`${context}: expected framework prefix '${prefix}' in stderr, proving the error flowed through handleCommandError instead of process.exit(1). stderr:\n${result.stderr}`,
	);
}

describe("identity-mapping-rules: framework prefix for create mapping-rule", () => {
	test("create mapping-rule (no flags) shows 'Failed to create mapping rule'", async () => {
		const result = await c8("create", "mapping-rule");
		assertFrameworkPrefix(
			result,
			"Failed to create mapping rule",
			"create mapping-rule",
		);
	});
});

describe("jobs: framework prefix for migrated handlers", () => {
	test("list jobs --between bad shows 'Failed to list jobs'", async () => {
		const result = await c8("list", "jobs", "--between", "not-a-valid-range");
		assertFrameworkPrefix(result, "Failed to list jobs", "list jobs");
	});

	test("activate jobs --maxJobsToActivate=0 shows 'Failed to activate jobs'", async () => {
		const result = await c8(
			"activate",
			"jobs",
			"some-type",
			"--maxJobsToActivate=0",
		);
		assertFrameworkPrefix(result, "Failed to activate jobs", "activate jobs");
	});

	test("fail job --retries=-1 shows 'Failed to fail job'", async () => {
		const result = await c8("fail", "job", "1234567890", "--retries=-1");
		assertFrameworkPrefix(result, "Failed to fail job", "fail job");
	});
});

describe("process-instances: framework prefix for migrated handlers", () => {
	test("list process-instances --between bad shows 'Failed to list process instance'", async () => {
		const result = await c8(
			"list",
			"process-instances",
			"--between",
			"not-a-valid-range",
		);
		assertFrameworkPrefix(
			result,
			"Failed to list process instance",
			"list process-instances",
		);
	});

	test("create process-instance (no id) shows 'Failed to create process instance'", async () => {
		const result = await c8("create", "process-instance", "--dry-run");
		assertFrameworkPrefix(
			result,
			"Failed to create process instance",
			"create process-instance",
		);
	});

	test("await process-instance (no id) shows 'Failed to await process instance'", async () => {
		const result = await c8("await", "process-instance", "--dry-run");
		assertFrameworkPrefix(
			result,
			"Failed to await process instance",
			"await process-instance",
		);
	});
});

describe("search: framework prefix for migrated handlers", () => {
	test("search process-instances --between bad shows 'Failed to search process instance'", async () => {
		const result = await c8(
			"search",
			"process-instances",
			"--between",
			"not-a-valid-range",
		);
		assertFrameworkPrefix(
			result,
			"Failed to search process instance",
			"search process-instances",
		);
	});

	test("search user-tasks --between bad shows 'Failed to search user task'", async () => {
		const result = await c8(
			"search",
			"user-tasks",
			"--between",
			"not-a-valid-range",
		);
		assertFrameworkPrefix(
			result,
			"Failed to search user task",
			"search user-tasks",
		);
	});

	test("search incidents --between bad shows 'Failed to search incident'", async () => {
		const result = await c8(
			"search",
			"incidents",
			"--between",
			"not-a-valid-range",
		);
		assertFrameworkPrefix(
			result,
			"Failed to search incident",
			"search incidents",
		);
	});

	// Note: registered resource is `jobs` (plural), so the prefix is
	// `Failed to search jobs` — not `search job` as Copilot's suggestion had.
	test("search jobs --between bad shows 'Failed to search jobs'", async () => {
		const result = await c8("search", "jobs", "--between", "not-a-valid-range");
		assertFrameworkPrefix(result, "Failed to search jobs", "search jobs");
	});
});

describe("session: framework prefix for migrated handlers", () => {
	test("use profile <nonexistent> shows 'Failed to use profile' (free function caught by defineCommand wrapper)", async () => {
		const result = await c8(
			"use",
			"profile",
			"definitely-not-a-real-profile-name-xyz",
		);
		assertFrameworkPrefix(
			result,
			"Failed to use profile",
			"use profile <nonexistent>",
		);
	});

	test("output yaml shows 'Failed to output' (free function caught by defineCommand wrapper)", async () => {
		const result = await c8("output", "yaml");
		assertFrameworkPrefix(result, "Failed to output", "output yaml");
	});

	test("use profile (no args) shows 'Failed to use profile'", async () => {
		const result = await c8("use", "profile");
		assertFrameworkPrefix(
			result,
			"Failed to use profile",
			"use profile (no args)",
		);
	});
});
