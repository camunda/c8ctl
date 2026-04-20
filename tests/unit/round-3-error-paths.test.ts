/**
 * Post-refactor assertions for Round 3 of the `process.exit` migration
 * (issue #300, PR #306).
 *
 * `round-3-baseline.test.ts` locked in the pre-refactor invariants:
 *   1. exit code = 1
 *   2. original error message appears in stderr
 *
 * This file locks in the *new* invariant that the Round 3 refactor adds:
 *   3. the framework's `Failed to <verb> <resource>` prefix appears in
 *      stderr (or `Failed to <verb> ` for resource-less verbs and the
 *      generic fallback handlers).
 *
 * Together with the baseline, these tests guarantee that every Round 3
 * site now routes through `handleCommandError` via `throw` — which is
 * the architectural goal of the migration.
 *
 * Only CLI-reachable sites are covered here; sites that are unreachable
 * (defensive defaults, shadowed by upstream guards, filesystem-dependent)
 * are protected instead by `tests/unit/no-process-exit-in-handlers.test.ts`.
 */

import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import { c8 } from "../utils/cli.ts";
import { asyncSpawn, type SpawnResult } from "../utils/spawn.ts";

const CLI = "src/index.ts";

const TEST_DATA_DIR = mkdtempSync(join(tmpdir(), "c8ctl-round3-paths-"));
// Minimal profile so CAMUNDA_BASE_URL is set for tests that go through the
// client factory. Dry-run / validation paths don't need it but it keeps the
// environment consistent with round-3-baseline.test.ts.
writeFileSync(
	join(TEST_DATA_DIR, "session.json"),
	JSON.stringify({ outputMode: "json" }),
);

after(() => {
	rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

/**
 * Spawn the CLI with a deterministic base env plus caller-supplied overrides.
 * Mirrors `round-3-baseline.test.ts`: intentionally does NOT spread
 * `process.env` — only `PATH` is inherited so the child process is isolated
 * from any host-side CAMUNDA_*, HOME, SHELL, etc.
 *
 * The few tests that need this are the ones whose failure trigger depends on
 * an env var (`SHELL` for `completion install`, `CAMUNDA_BASE_URL` for
 * `add profile --from-env`). Tests without env sensitivity use the shared
 * `c8()` helper from `tests/utils/cli.ts`.
 */
async function c8WithEnv(
	overrides: Record<string, string>,
	...args: string[]
): Promise<SpawnResult> {
	const env: NodeJS.ProcessEnv = {
		PATH: process.env.PATH,
		CAMUNDA_BASE_URL: "http://test-cluster/v2",
		HOME: "/tmp/c8ctl-test-nonexistent-home",
		C8CTL_DATA_DIR: TEST_DATA_DIR,
		...overrides,
	};
	return asyncSpawn("node", ["--experimental-strip-types", CLI, ...args], {
		env,
	});
}

/**
 * Assert exit 1 AND that stderr contains BOTH the framework prefix
 * (`Failed to <verb> <resource>`) and the original error fragment.
 *
 * This is the combined check that makes Round 3 meaningful: the framework
 * now owns the error pipeline AND the original diagnostic is preserved.
 */
function assertFrameworkFailure(
	result: SpawnResult,
	frameworkPrefix: string,
	originalFragment: string,
	context: string,
): void {
	assert.strictEqual(
		result.status,
		1,
		`${context}: expected exit 1, got ${result.status}. stderr:\n${result.stderr}`,
	);
	assert.ok(
		result.stderr.includes(frameworkPrefix),
		`${context}: expected stderr to contain framework prefix '${frameworkPrefix}'. stderr:\n${result.stderr}`,
	);
	assert.ok(
		result.stderr.includes(originalFragment),
		`${context}: expected stderr to contain original fragment '${originalFragment}'. stderr:\n${result.stderr}`,
	);
}

// ── completion.ts (framework prefix: "Failed to completion ") ────────────────

describe("round-3 framework prefix: completion", () => {
	test("`c8 completion` → 'Failed to completion' + 'Shell type required'", async () => {
		const result = await c8("completion");
		assertFrameworkFailure(
			result,
			"Failed to completion",
			"Shell type required",
			"completion (no shell)",
		);
	});

	test("`c8 completion powershell` → 'Failed to completion' + 'Unknown shell'", async () => {
		const result = await c8("completion", "powershell");
		assertFrameworkFailure(
			result,
			"Failed to completion",
			"Unknown shell: powershell",
			"completion powershell",
		);
	});

	test("`SHELL='' c8 completion install` → 'Failed to completion' + 'Could not detect shell'", async () => {
		const result = await c8WithEnv({ SHELL: "" }, "completion", "install");
		assertFrameworkFailure(
			result,
			"Failed to completion",
			"Could not detect shell",
			"completion install (no SHELL)",
		);
	});

	test("`c8 completion install --shell=foo` → 'Failed to completion' + 'Unsupported shell'", async () => {
		const result = await c8("completion", "install", "--shell=foo");
		assertFrameworkFailure(
			result,
			"Failed to completion",
			"Unsupported shell: foo",
			"completion install --shell=foo",
		);
	});
});

// ── identity.ts (framework prefix: "Failed to assign <resource>" etc.) ───────

describe("round-3 framework prefix: assign / unassign", () => {
	test("`c8 assign foo abc --to-user=u` → 'Failed to assign' + 'Cannot assign resource type: foo'", async () => {
		const result = await c8("assign", "foo", "abc", "--to-user=u");
		assertFrameworkFailure(
			result,
			"Failed to assign",
			"Cannot assign resource type: foo",
			"assign foo (bad resource)",
		);
	});

	test("`c8 assign role abc --to-user=u --to-group=g` → 'Failed to assign role' + 'Exactly one target flag'", async () => {
		const result = await c8(
			"assign",
			"role",
			"abc",
			"--to-user=u",
			"--to-group=g",
		);
		assertFrameworkFailure(
			result,
			"Failed to assign role",
			"Exactly one target flag is required",
			"assign role (>1 target)",
		);
	});

	test("`c8 assign role abc` → 'Failed to assign role' + 'Target required'", async () => {
		const result = await c8("assign", "role", "abc");
		assertFrameworkFailure(
			result,
			"Failed to assign role",
			"Target required",
			"assign role (no target)",
		);
	});

	test("`c8 assign group abc --to-user=u` → 'Failed to assign group' + 'Unsupported target flag'", async () => {
		const result = await c8("assign", "group", "abc", "--to-user=u");
		assertFrameworkFailure(
			result,
			"Failed to assign group",
			"Unsupported target flag --to-user for resource 'group'",
			"assign group (bad target)",
		);
	});

	test("`c8 unassign foo abc --from-user=u` → 'Failed to unassign' + 'Cannot unassign resource type: foo'", async () => {
		const result = await c8("unassign", "foo", "abc", "--from-user=u");
		assertFrameworkFailure(
			result,
			"Failed to unassign",
			"Cannot unassign resource type: foo",
			"unassign foo (bad resource)",
		);
	});

	test("`c8 unassign role abc --from-user=u --from-group=g` → 'Failed to unassign role' + 'Exactly one source flag'", async () => {
		const result = await c8(
			"unassign",
			"role",
			"abc",
			"--from-user=u",
			"--from-group=g",
		);
		assertFrameworkFailure(
			result,
			"Failed to unassign role",
			"Exactly one source flag is required",
			"unassign role (>1 source)",
		);
	});

	test("`c8 unassign role abc` → 'Failed to unassign role' + 'Source required'", async () => {
		const result = await c8("unassign", "role", "abc");
		assertFrameworkFailure(
			result,
			"Failed to unassign role",
			"Source required",
			"unassign role (no source)",
		);
	});

	test("`c8 unassign group abc --from-user=u` → 'Failed to unassign group' + 'Unsupported source flag'", async () => {
		const result = await c8("unassign", "group", "abc", "--from-user=u");
		assertFrameworkFailure(
			result,
			"Failed to unassign group",
			"Unsupported source flag --from-user for resource 'group'",
			"unassign group (bad source)",
		);
	});
});

// ── plugins.ts (framework prefix: "Failed to <verb> plugin") ─────────────────

describe("round-3 framework prefix: plugins", () => {
	test("`c8 load plugin foo --from=https://x` → 'Failed to load plugin' + 'Cannot specify both'", async () => {
		const result = await c8("load", "plugin", "foo", "--from=https://x");
		assertFrameworkFailure(
			result,
			"Failed to load plugin",
			"Cannot specify both a positional argument and --from flag",
			"load plugin (positional + --from)",
		);
	});

	test("`c8 load plugin` → 'Failed to load plugin' + 'Package name or URL required'", async () => {
		const result = await c8("load", "plugin");
		assertFrameworkFailure(
			result,
			"Failed to load plugin",
			"Package name or URL required",
			"load plugin (no name, no --from)",
		);
	});

	test("`c8 load plugin --from=not-a-url` → 'Failed to load plugin' + 'Invalid URL format'", async () => {
		const result = await c8("load", "plugin", "--from=not-a-url");
		assertFrameworkFailure(
			result,
			"Failed to load plugin",
			"Invalid URL format",
			"load plugin (invalid URL)",
		);
	});

	test("`c8 load plugin https://example.com` → 'Failed to load plugin' + 'Package name cannot be a URL'", async () => {
		const result = await c8("load", "plugin", "https://example.com");
		assertFrameworkFailure(
			result,
			"Failed to load plugin",
			"Package name cannot be a URL",
			"load plugin (URL as positional)",
		);
	});

	test("`c8 unload plugin nonexistent-pkg-xyz` → 'Failed to unload plugin' + 'neither registered nor installed'", async () => {
		const result = await c8("unload", "plugin", "nonexistent-pkg-xyz");
		assertFrameworkFailure(
			result,
			"Failed to unload plugin",
			"neither registered nor installed",
			"unload plugin (not registered, not installed)",
		);
	});

	test("`c8 upgrade plugin nonexistent-pkg-xyz` → 'Failed to upgrade plugin' + 'not registered'", async () => {
		const result = await c8("upgrade", "plugin", "nonexistent-pkg-xyz");
		assertFrameworkFailure(
			result,
			"Failed to upgrade plugin",
			"is not registered",
			"upgrade plugin (not registered)",
		);
	});

	test("`c8 downgrade plugin nonexistent-pkg-xyz 1.0.0` → 'Failed to downgrade plugin' + 'not registered'", async () => {
		const result = await c8(
			"downgrade",
			"plugin",
			"nonexistent-pkg-xyz",
			"1.0.0",
		);
		assertFrameworkFailure(
			result,
			"Failed to downgrade plugin",
			"is not registered",
			"downgrade plugin (not registered)",
		);
	});

	test("`c8 init plugin c8ctl-plugin-` → 'Failed to init plugin' + 'Plugin name cannot be empty'", async () => {
		const result = await c8("init", "plugin", "c8ctl-plugin-");
		assertFrameworkFailure(
			result,
			"Failed to init plugin",
			"Plugin name cannot be empty",
			"init plugin (empty name)",
		);
	});
});

// ── profiles.ts (framework prefix: "Failed to <verb> profile") ───────────────

describe("round-3 framework prefix: profiles", () => {
	test("`c8 use profile <bad>` → 'Failed to use profile' + 'not found'", async () => {
		const result = await c8("use", "profile", "nonexistent-profile-xyz");
		assertFrameworkFailure(
			result,
			"Failed to use profile",
			"not found",
			"use profile (not found)",
		);
	});

	test("`c8 add profile p --from-file=x --from-env` → 'Failed to add profile' + 'Cannot use --from-file and --from-env together'", async () => {
		const result = await c8(
			"add",
			"profile",
			"p",
			"--from-file=x",
			"--from-env",
		);
		assertFrameworkFailure(
			result,
			"Failed to add profile",
			"Cannot use --from-file and --from-env together",
			"add profile (conflicting flags)",
		);
	});

	test("`c8 add profile p --from-file=/nonexistent` → 'Failed to add profile' + 'File not found'", async () => {
		const result = await c8(
			"add",
			"profile",
			"p",
			"--from-file=/nonexistent-path-xyz",
		);
		assertFrameworkFailure(
			result,
			"Failed to add profile",
			"File not found",
			"add profile (file not found)",
		);
	});

	test("tmp .env without CAMUNDA_BASE_URL → 'Failed to add profile' + 'CAMUNDA_BASE_URL not found'", async () => {
		const envFile = join(TEST_DATA_DIR, "empty.env");
		writeFileSync(envFile, "# no CAMUNDA_BASE_URL here\nFOO=bar\n");
		try {
			const result = await c8("add", "profile", "p", `--from-file=${envFile}`);
			assertFrameworkFailure(
				result,
				"Failed to add profile",
				"CAMUNDA_BASE_URL not found",
				"add profile (missing in file)",
			);
		} finally {
			rmSync(envFile, { force: true });
		}
	});

	test("`CAMUNDA_BASE_URL='' c8 add profile p --from-env` → 'Failed to add profile' + 'CAMUNDA_BASE_URL not set in environment'", async () => {
		const result = await c8WithEnv(
			{ CAMUNDA_BASE_URL: "" },
			"add",
			"profile",
			"p",
			"--from-env",
		);
		assertFrameworkFailure(
			result,
			"Failed to add profile",
			"CAMUNDA_BASE_URL not set in environment",
			"add profile (missing in env)",
		);
	});

	test("`c8 remove profile <bad>` → 'Failed to remove profile' + 'not found'", async () => {
		const result = await c8("remove", "profile", "nonexistent-profile-xyz");
		assertFrameworkFailure(
			result,
			"Failed to remove profile",
			"not found",
			"remove profile (not found)",
		);
	});
});
