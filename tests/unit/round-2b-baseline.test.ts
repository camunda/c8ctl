/**
 * Green/green baseline guards for Round 2b of the `process.exit` migration
 * (issue #300, follow-on to #288).
 *
 * Per AGENTS.md ("Coverage analysis before a behaviour-preserving refactor"):
 * before changing any of these handlers, lock in the current observable
 * invariants so the refactor cannot silently change them. These tests assert
 * ONLY the invariants — the things that must hold both BEFORE and AFTER the
 * Round 2b refactor:
 *
 *   1. exit code is 1 (the command did fail)
 *   2. the original error message appears in stderr
 *
 * The Round 2b refactor will additionally make the framework's
 * `Failed to <verb> <resource>` prefix appear in stderr — that is the
 * intended behaviour change and is asserted by a separate, post-refactor
 * test file (`tests/unit/round-2b-error-paths.test.ts`). The baseline
 * assertions in THIS file remain green throughout.
 *
 * Sites covered (19 total across 5 files):
 *   - src/commands/identity-mapping-rules.ts (4 sites: --mappingRuleId / --name / --claimName / --claimValue required)
 *   - src/commands/jobs.ts                   (4 sites: list / activate ×2 / fail)
 *   - src/commands/process-instances.ts      (4 sites: list / create ×2 / await)
 *   - src/commands/search.ts                 (4 sites: search process-instance / user-task / incident / jobs, all `--between`)
 *   - src/commands/session.ts                (3 sites: use profile bad / output bad / use profile no-args)
 */

import assert from "node:assert";
import { describe, test } from "node:test";
import { c8 } from "../utils/cli.ts";
import type { SpawnResult } from "../utils/spawn.ts";

function assertExitOneWithMessage(
	result: SpawnResult,
	fragment: string,
	context: string,
): void {
	assert.strictEqual(
		result.status,
		1,
		`${context}: expected exit 1, got ${result.status}. stderr:\n${result.stderr}`,
	);
	assert.ok(
		result.stderr.includes(fragment),
		`${context}: expected '${fragment}' in stderr. stderr:\n${result.stderr}`,
	);
}

describe("Round 2b baseline — identity-mapping-rules.ts", () => {
	test("create mapping-rule without --mappingRuleId fails with required-flag message", async () => {
		const result = await c8("create", "mapping-rule");
		assertExitOneWithMessage(
			result,
			"--mappingRuleId is required",
			"create mapping-rule (no flags)",
		);
	});

	test("create mapping-rule without --name fails with required-flag message", async () => {
		const result = await c8(
			"create",
			"mapping-rule",
			"--mappingRuleId",
			"rule-123",
		);
		assertExitOneWithMessage(
			result,
			"--name is required",
			"create mapping-rule (missing --name)",
		);
	});

	test("create mapping-rule without --claimName fails with required-flag message", async () => {
		const result = await c8(
			"create",
			"mapping-rule",
			"--mappingRuleId",
			"rule-123",
			"--name",
			"test-rule",
		);
		assertExitOneWithMessage(
			result,
			"--claimName is required",
			"create mapping-rule (missing --claimName)",
		);
	});

	test("create mapping-rule without --claimValue fails with required-flag message", async () => {
		const result = await c8(
			"create",
			"mapping-rule",
			"--mappingRuleId",
			"rule-123",
			"--name",
			"test-rule",
			"--claimName",
			"sub",
		);
		assertExitOneWithMessage(
			result,
			"--claimValue is required",
			"create mapping-rule (missing --claimValue)",
		);
	});
});

describe("Round 2b baseline — jobs.ts", () => {
	test("list jobs --between invalid fails with --between message", async () => {
		const result = await c8("list", "jobs", "--between", "not-a-valid-range");
		assertExitOneWithMessage(
			result,
			"Invalid --between",
			"list jobs --between bad",
		);
	});

	test("activate jobs --maxJobsToActivate=0 fails with positive-integer message", async () => {
		const result = await c8(
			"activate",
			"jobs",
			"some-type",
			"--maxJobsToActivate=0",
		);
		assertExitOneWithMessage(
			result,
			"--maxJobsToActivate must be a positive integer",
			"activate jobs --maxJobsToActivate=0",
		);
	});

	test("activate jobs --timeout=0 fails with positive-integer message", async () => {
		const result = await c8("activate", "jobs", "some-type", "--timeout=0");
		assertExitOneWithMessage(
			result,
			"--timeout must be a positive integer",
			"activate jobs --timeout=0",
		);
	});

	test("fail job --retries=-1 fails with non-negative-integer message", async () => {
		const result = await c8("fail", "job", "1234567890", "--retries=-1");
		assertExitOneWithMessage(
			result,
			"--retries must be a non-negative integer",
			"fail job --retries=-1",
		);
	});
});

describe("Round 2b baseline — process-instances.ts", () => {
	test("list process-instances --between invalid fails with --between message", async () => {
		const result = await c8(
			"list",
			"process-instances",
			"--between",
			"not-a-valid-range",
		);
		assertExitOneWithMessage(
			result,
			"Invalid --between",
			"list process-instances --between bad",
		);
	});

	test("create process-instance with no id flags fails with processDefinitionId-required message", async () => {
		const result = await c8("create", "process-instance", "--dry-run");
		assertExitOneWithMessage(
			result,
			"processDefinitionId is required",
			"create process-instance (no id)",
		);
	});

	test("create process-instance --fetchVariables without --awaitCompletion fails", async () => {
		// Note: this guard is AFTER the dry-run gate, so we can't use --dry-run.
		// The CLI subprocess uses CAMUNDA_BASE_URL=http://test-cluster/v2 which
		// does not resolve, but the validation guard fires before any network call.
		const result = await c8(
			"create",
			"process-instance",
			"--processDefinitionId=some-id",
			"--fetchVariables",
		);
		assertExitOneWithMessage(
			result,
			"--fetchVariables can only be used with --awaitCompletion",
			"create process-instance --fetchVariables (no --awaitCompletion)",
		);
	});

	test("await process-instance with no id flags fails with processDefinitionId-required message", async () => {
		const result = await c8("await", "process-instance", "--dry-run");
		assertExitOneWithMessage(
			result,
			"processDefinitionId is required",
			"await process-instance (no id)",
		);
	});
});

describe("Round 2b baseline — search.ts", () => {
	test("search process-instances --between invalid fails", async () => {
		const result = await c8(
			"search",
			"process-instances",
			"--between",
			"not-a-valid-range",
		);
		assertExitOneWithMessage(
			result,
			"Invalid --between",
			"search process-instances --between bad",
		);
	});

	test("search user-tasks --between invalid fails", async () => {
		const result = await c8(
			"search",
			"user-tasks",
			"--between",
			"not-a-valid-range",
		);
		assertExitOneWithMessage(
			result,
			"Invalid --between",
			"search user-tasks --between bad",
		);
	});

	test("search incidents --between invalid fails", async () => {
		const result = await c8(
			"search",
			"incidents",
			"--between",
			"not-a-valid-range",
		);
		assertExitOneWithMessage(
			result,
			"Invalid --between",
			"search incidents --between bad",
		);
	});

	test("search jobs --between invalid fails", async () => {
		const result = await c8("search", "jobs", "--between", "not-a-valid-range");
		assertExitOneWithMessage(
			result,
			"Invalid --between",
			"search jobs --between bad",
		);
	});
});

describe("Round 2b baseline — session.ts", () => {
	test("use profile <nonexistent> fails with not-found message", async () => {
		const result = await c8(
			"use",
			"profile",
			"definitely-not-a-real-profile-name-xyz",
		);
		assertExitOneWithMessage(result, "not found", "use profile <nonexistent>");
	});

	test("output <invalid-mode> fails with invalid-mode message", async () => {
		const result = await c8("output", "yaml");
		assertExitOneWithMessage(
			result,
			"Invalid output mode",
			"output yaml (bad mode)",
		);
	});

	test("use profile with no name argument fails with usage message", async () => {
		const result = await c8("use", "profile");
		assertExitOneWithMessage(
			result,
			"Profile name required",
			"use profile (no args)",
		);
	});
});
