/**
 * Green/green baseline guards for Round 3 of the `process.exit` migration
 * (issue #300, follow-on to #288, #301, #302, #304).
 *
 * Per AGENTS.md ("Coverage analysis before a behaviour-preserving refactor"):
 * before changing any of these handlers, lock in the current observable
 * invariants so the refactor cannot silently change them. These tests assert
 * ONLY the invariants — the things that must hold both BEFORE and AFTER the
 * Round 3 refactor:
 *
 *   1. exit code is 1 (the command did fail)
 *   2. the original error message appears in stderr
 *
 * The Round 3 refactor will additionally make the framework's
 * `Failed to <verb> <resource>` prefix appear in stderr (where the call site
 * is dispatched through `defineCommand`). That is the intended behaviour
 * change and will be asserted by a separate, post-refactor test file.
 * The baseline assertions in THIS file remain green throughout.
 *
 * Sites in the Round 3 allow-list (47 total across 4 files):
 *   - src/commands/completion.ts (5 sites)
 *   - src/commands/identity.ts   (18 sites)
 *   - src/commands/plugins.ts    (16 sites)
 *   - src/commands/profiles.ts   (8 sites)
 *
 * Of those 47, this file covers the 26 sites that are CLI-reachable today.
 * The remaining 21 sites fall into three categories that have no observable
 * CLI behaviour to lock in (the architectural guard in
 * `tests/unit/no-process-exit-in-handlers.test.ts` is the durable catch
 * for any regression that re-introduces `process.exit` in those files):
 *
 *   - Defensive defaults that are unreachable at runtime because an
 *     upstream guard (also in the same file) already filters the bad
 *     input — e.g. the inner-switch `default:` arms in
 *     `handleAssign`/`handleUnassign` are unreachable because the
 *     `allowedTargets` check above them rejects unknown flags first.
 *   - Sites shadowed by the registry's positional-argument validation,
 *     which exits 1 with a different "<resource> required" message
 *     before the in-handler guard ever runs (e.g. plugins.ts L350,
 *     L788, L866 are all shadowed by the framework).
 *   - Filesystem / network / shell-state-dependent paths that cannot
 *     be triggered deterministically from a unit test (e.g. the catch
 *     block in `installCompletion`, the "Directory already exists"
 *     branch in `init plugin`, the "Failed to extract plugin name from
 *     URL" branch in `load plugin`).
 *
 * Sites covered (26):
 *   completion.ts (4 of 5):
 *     - L569: `c8 completion`                          (no shell)
 *     - L587: `c8 completion powershell`               (unknown shell)
 *     - L737: `SHELL='' c8 completion install`         (cannot detect shell)
 *     - L742: `c8 completion install --shell=foo`      (unsupported shell)
 *   identity.ts (8 of 18):
 *     - L127: `c8 assign foo abc --to-user=u`                (bad resource)
 *     - L136: `c8 assign role abc --to-user=u --to-group=g`  (>1 target flag)
 *     - L140: `c8 assign role abc`                            (no target flag)
 *     - L148: `c8 assign group abc --to-user=u`               (bad target for resource)
 *     - L300: `c8 unassign foo abc --from-user=u`             (bad resource)
 *     - L309: `c8 unassign role abc --from-user=u --from-group=g` (>1 source flag)
 *     - L313: `c8 unassign role abc`                          (no source flag)
 *     - L321: `c8 unassign group abc --from-user=u`           (bad source for resource)
 *   plugins.ts (8 of 16):
 *     - L67:  `c8 load plugin foo --from=https://x`      (positional + --from)
 *     - L74:  `c8 load plugin`                            (no name and no --from)
 *     - L81:  `c8 load plugin --from=not-a-url`           (invalid URL)
 *     - L88:  `c8 load plugin https://example.com`        (URL as positional)
 *     - L362: `c8 unload plugin nonexistent-pkg-xyz`      (not registered/installed)
 *     - L796: `c8 upgrade plugin nonexistent-pkg-xyz`     (not registered)
 *     - L874: `c8 downgrade plugin nonexistent-pkg-xyz 1.0.0` (not registered)
 *     - L949: `c8 init plugin c8ctl-plugin-`              (empty plugin name)
 *   profiles.ts (6 of 8):
 *     - L84:  `c8 use profile <bad>`                      (profile not found)
 *     - L164: `c8 add profile p --from-file=x --from-env` (conflicting flags)
 *     - L171: `c8 add profile p --from-file=/nonexistent` (file not found)
 *     - L178: tmp .env file without CAMUNDA_BASE_URL      (missing in file)
 *     - L190: `CAMUNDA_BASE_URL='' c8 add profile p --from-env` (missing in env)
 *     - L233: `c8 remove profile <bad>`                   (profile not found)
 */

import assert from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { c8 } from "../utils/cli.ts";
import { asyncSpawn, type SpawnResult } from "../utils/spawn.ts";

const CLI = "src/index.ts";

/**
 * Spawn the CLI with a custom environment — used for the few sites whose
 * trigger requires an env var the standard `c8` helper sets unconditionally
 * (SHELL for completion install, CAMUNDA_BASE_URL for `add profile --from-env`).
 */
async function c8WithEnv(
	env: NodeJS.ProcessEnv,
	...args: string[]
): Promise<SpawnResult> {
	return asyncSpawn("node", ["--experimental-strip-types", CLI, ...args], {
		env,
	});
}

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
		`${context}: expected stderr to contain '${fragment}'. stderr:\n${result.stderr}`,
	);
}

// ── completion.ts ────────────────────────────────────────────────────────────

describe("baseline: completion.ts validation guards", () => {
	test("`c8 completion` (no shell) → exit 1 + 'Shell type required'", async () => {
		const result = await c8("completion");
		assertExitOneWithMessage(
			result,
			"Shell type required",
			"completion (no shell)",
		);
	});

	test("`c8 completion powershell` → exit 1 + 'Unknown shell: powershell'", async () => {
		const result = await c8("completion", "powershell");
		assertExitOneWithMessage(
			result,
			"Unknown shell: powershell",
			"completion powershell",
		);
	});

	test("`SHELL='' c8 completion install` → exit 1 + 'Could not detect shell'", async () => {
		const env = { ...process.env, SHELL: "" };
		const result = await c8WithEnv(env, "completion", "install");
		assertExitOneWithMessage(
			result,
			"Could not detect shell",
			"completion install (no SHELL)",
		);
	});

	test("`c8 completion install --shell=foo` → exit 1 + 'Unsupported shell: foo'", async () => {
		const result = await c8("completion", "install", "--shell=foo");
		assertExitOneWithMessage(
			result,
			"Unsupported shell: foo",
			"completion install --shell=foo",
		);
	});
});

// ── identity.ts ──────────────────────────────────────────────────────────────

describe("baseline: identity.ts handleAssign validation guards", () => {
	test("`c8 assign foo abc --to-user=u` → exit 1 + 'Cannot assign resource type: foo'", async () => {
		const result = await c8("assign", "foo", "abc", "--to-user=u");
		assertExitOneWithMessage(
			result,
			"Cannot assign resource type: foo",
			"assign foo (bad resource)",
		);
	});

	test("`c8 assign role abc --to-user=u --to-group=g` → exit 1 + 'Exactly one target flag is required'", async () => {
		const result = await c8(
			"assign",
			"role",
			"abc",
			"--to-user=u",
			"--to-group=g",
		);
		assertExitOneWithMessage(
			result,
			"Exactly one target flag is required",
			"assign role (>1 target)",
		);
	});

	test("`c8 assign role abc` → exit 1 + 'Target required'", async () => {
		const result = await c8("assign", "role", "abc");
		assertExitOneWithMessage(
			result,
			"Target required. Use --to-user, --to-group, --to-tenant, --to-mapping-rule.",
			"assign role (no target)",
		);
	});

	test("`c8 assign group abc --to-user=u` → exit 1 + 'Unsupported target flag --to-user for resource \\'group\\''", async () => {
		const result = await c8("assign", "group", "abc", "--to-user=u");
		assertExitOneWithMessage(
			result,
			"Unsupported target flag --to-user for resource 'group'",
			"assign group (bad target)",
		);
	});
});

describe("baseline: identity.ts handleUnassign validation guards", () => {
	test("`c8 unassign foo abc --from-user=u` → exit 1 + 'Cannot unassign resource type: foo'", async () => {
		const result = await c8("unassign", "foo", "abc", "--from-user=u");
		assertExitOneWithMessage(
			result,
			"Cannot unassign resource type: foo",
			"unassign foo (bad resource)",
		);
	});

	test("`c8 unassign role abc --from-user=u --from-group=g` → exit 1 + 'Exactly one source flag is required'", async () => {
		const result = await c8(
			"unassign",
			"role",
			"abc",
			"--from-user=u",
			"--from-group=g",
		);
		assertExitOneWithMessage(
			result,
			"Exactly one source flag is required",
			"unassign role (>1 source)",
		);
	});

	test("`c8 unassign role abc` → exit 1 + 'Source required'", async () => {
		const result = await c8("unassign", "role", "abc");
		assertExitOneWithMessage(
			result,
			"Source required. Use --from-user, --from-group, --from-tenant, --from-mapping-rule.",
			"unassign role (no source)",
		);
	});

	test("`c8 unassign group abc --from-user=u` → exit 1 + 'Unsupported source flag --from-user for resource \\'group\\''", async () => {
		const result = await c8("unassign", "group", "abc", "--from-user=u");
		assertExitOneWithMessage(
			result,
			"Unsupported source flag --from-user for resource 'group'",
			"unassign group (bad source)",
		);
	});
});

// ── plugins.ts ───────────────────────────────────────────────────────────────

describe("baseline: plugins.ts load plugin validation guards", () => {
	test("`c8 load plugin foo --from=https://x` → exit 1 + 'Cannot specify both a positional argument and --from flag'", async () => {
		const result = await c8("load", "plugin", "foo", "--from=https://x");
		assertExitOneWithMessage(
			result,
			"Cannot specify both a positional argument and --from flag",
			"load plugin (positional + --from)",
		);
	});

	test("`c8 load plugin` → exit 1 + 'Package name or URL required'", async () => {
		const result = await c8("load", "plugin");
		assertExitOneWithMessage(
			result,
			"Package name or URL required",
			"load plugin (no name)",
		);
	});

	test("`c8 load plugin --from=not-a-url` → exit 1 + 'Invalid URL format'", async () => {
		const result = await c8("load", "plugin", "--from=not-a-url");
		assertExitOneWithMessage(
			result,
			"Invalid URL format",
			"load plugin (invalid URL)",
		);
	});

	test("`c8 load plugin https://example.com` → exit 1 + 'Package name cannot be a URL'", async () => {
		const result = await c8("load", "plugin", "https://example.com");
		assertExitOneWithMessage(
			result,
			"Package name cannot be a URL",
			"load plugin (URL as positional)",
		);
	});
});

describe("baseline: plugins.ts unload/upgrade/downgrade plugin guards", () => {
	test("`c8 unload plugin nonexistent-pkg-xyz` → exit 1 + 'is neither registered nor installed'", async () => {
		const result = await c8("unload", "plugin", "nonexistent-pkg-xyz");
		assertExitOneWithMessage(
			result,
			"is neither registered nor installed",
			"unload plugin (not present)",
		);
	});

	test("`c8 upgrade plugin nonexistent-pkg-xyz` → exit 1 + 'is not registered'", async () => {
		const result = await c8("upgrade", "plugin", "nonexistent-pkg-xyz");
		assertExitOneWithMessage(
			result,
			"nonexistent-pkg-xyz",
			"upgrade plugin (not registered) — name appears in stderr",
		);
		assertExitOneWithMessage(
			result,
			"is not registered",
			"upgrade plugin (not registered) — message fragment",
		);
	});

	test("`c8 downgrade plugin nonexistent-pkg-xyz 1.0.0` → exit 1 + 'is not registered'", async () => {
		const result = await c8(
			"downgrade",
			"plugin",
			"nonexistent-pkg-xyz",
			"1.0.0",
		);
		assertExitOneWithMessage(
			result,
			"nonexistent-pkg-xyz",
			"downgrade plugin (not registered) — name appears in stderr",
		);
		assertExitOneWithMessage(
			result,
			"is not registered",
			"downgrade plugin (not registered) — message fragment",
		);
	});
});

describe("baseline: plugins.ts init plugin guards", () => {
	test("`c8 init plugin c8ctl-plugin-` (empty suffix) → exit 1 + 'Plugin name cannot be empty'", async () => {
		const result = await c8("init", "plugin", "c8ctl-plugin-");
		assertExitOneWithMessage(
			result,
			"Plugin name cannot be empty",
			"init plugin (empty name)",
		);
	});
});

// ── profiles.ts ──────────────────────────────────────────────────────────────

describe("baseline: profiles.ts validation guards", () => {
	test("`c8 use profile <nonexistent>` → exit 1 + \"Profile '<name>' not found\"", async () => {
		const result = await c8(
			"use",
			"profile",
			"definitely-not-a-real-profile-name-xyz",
		);
		assertExitOneWithMessage(
			result,
			"Profile 'definitely-not-a-real-profile-name-xyz' not found",
			"use profile (nonexistent)",
		);
	});

	test("`c8 add profile p --from-file=x --from-env` → exit 1 + 'Cannot use --from-file and --from-env together'", async () => {
		const result = await c8(
			"add",
			"profile",
			"testp",
			"--from-file=somefile",
			"--from-env",
		);
		assertExitOneWithMessage(
			result,
			"Cannot use --from-file and --from-env together",
			"add profile (conflicting --from flags)",
		);
	});

	test("`c8 add profile p --from-file=/nonexistent/path/xyz.env` → exit 1 + 'File not found'", async () => {
		const result = await c8(
			"add",
			"profile",
			"testp",
			"--from-file=/nonexistent/path/xyz-baseline.env",
		);
		assertExitOneWithMessage(
			result,
			"File not found: /nonexistent/path/xyz-baseline.env",
			"add profile (file not found)",
		);
	});

	test("`c8 add profile p --from-file=<.env without CAMUNDA_BASE_URL>` → exit 1 + 'CAMUNDA_BASE_URL not found in'", async () => {
		// Write an .env file with no CAMUNDA_BASE_URL to trigger L178.
		const dir = mkdtempSync(join(tmpdir(), "c8ctl-baseline-r3-"));
		const envFile = join(dir, "missing-base-url.env");
		writeFileSync(envFile, "OTHER_VAR=value\n");
		const result = await c8(
			"add",
			"profile",
			"testp",
			`--from-file=${envFile}`,
		);
		assertExitOneWithMessage(
			result,
			`CAMUNDA_BASE_URL not found in ${envFile}`,
			"add profile (env file missing CAMUNDA_BASE_URL)",
		);
	});

	test("`CAMUNDA_BASE_URL='' c8 add profile p --from-env` → exit 1 + 'CAMUNDA_BASE_URL not set in environment'", async () => {
		const env = { ...process.env };
		// Strip any inherited CAMUNDA_* so envVarsToProfile sees no baseUrl.
		for (const key of Object.keys(env)) {
			if (key.startsWith("CAMUNDA_")) delete env[key];
		}
		const result = await c8WithEnv(
			env,
			"add",
			"profile",
			"testp",
			"--from-env",
		);
		assertExitOneWithMessage(
			result,
			"CAMUNDA_BASE_URL not set in environment",
			"add profile --from-env (no env)",
		);
	});

	test("`c8 remove profile <nonexistent>` → exit 1 + \"Profile '<name>' not found\"", async () => {
		const result = await c8(
			"remove",
			"profile",
			"definitely-not-a-real-profile-name-xyz",
		);
		assertExitOneWithMessage(
			result,
			"Profile 'definitely-not-a-real-profile-name-xyz' not found",
			"remove profile (nonexistent)",
		);
	});
});
