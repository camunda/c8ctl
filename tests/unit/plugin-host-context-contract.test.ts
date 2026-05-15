/**
 * Plugin host context contract tests (#377).
 *
 * Pins three contracts:
 *
 *   A. Flag-aware plugin handlers receive a third `ctx` argument
 *      exposing the resolved host globals (`dryRun`, `verbose`,
 *      `outputMode`, `fields`, `profile`, `logger`, lazy `client`).
 *      Every member of `GLOBAL_FLAGS` is either reflected in `ctx`
 *      or has an explicit, named host-only reason.
 *
 *   B. A plugin can opt into `ctx.dryRun` and have it work end-to-end.
 *
 *   C. Plugin-authored `--help` and `--version`:
 *      - `c8ctl <plugin-verb> --help` renders the plugin's declarative
 *        help (description, helpDescription, flags, examples) instead
 *        of dispatching the handler.
 *      - `c8ctl <plugin-verb> --version` prints the plugin's
 *        `package.json#version`, not the c8ctl version.
 *
 *   D. Backward compatibility: a plugin whose handler is declared
 *      with the legacy `(args, flags)` signature must keep working
 *      when the host passes a third arg.
 *
 * Fixture: tests/fixtures/plugins/plugin-with-host-context/. Installed
 * per-test into a temp `C8CTL_DATA_DIR` so other tests can't see it.
 */

import assert from "node:assert";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { GLOBAL_FLAGS } from "../../src/command-registry.ts";
import { isRecord } from "../../src/logger.ts";
import { asyncSpawn, type SpawnResult } from "../utils/spawn.ts";

const FIXTURE_DIR = join(
	process.cwd(),
	"tests",
	"fixtures",
	"plugins",
	"plugin-with-host-context",
);
const PLUGIN_PKG_NAME = "c8ctl-plugin-host-context";
const PLUGIN_VERSION = "9.9.9"; // matches fixture package.json
// The loader uses `package.json#name` as the canonical plugin name
// (not `metadata.name`), so --version output identifies the plugin
// by its package name.
const PLUGIN_NAME = PLUGIN_PKG_NAME;

let testDataDir: string;

beforeEach(() => {
	testDataDir = mkdtempSync(join(tmpdir(), "c8ctl-plugin-ctx-"));
	writeFileSync(
		join(testDataDir, "session.json"),
		JSON.stringify({ outputMode: "json" }),
	);
	const installDir = join(
		testDataDir,
		"plugins",
		"node_modules",
		PLUGIN_PKG_NAME,
	);
	mkdirSync(installDir, { recursive: true });
	cpSync(FIXTURE_DIR, installDir, { recursive: true });
});

afterEach(() => {
	rmSync(testDataDir, { recursive: true, force: true });
});

async function c8Plugin(...args: string[]): Promise<SpawnResult> {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		CAMUNDA_BASE_URL: "http://test-cluster/v2",
		HOME: "/tmp/c8ctl-test-nonexistent-home",
		C8CTL_DATA_DIR: testDataDir,
	};
	delete env.DEBUG;
	delete env.C8CTL_DEBUG;
	delete env.NODE_DEBUG;
	delete env.NODE_OPTIONS;
	return asyncSpawn(
		"node",
		["--experimental-strip-types", "src/index.ts", ...args],
		{
			env,
			timeout: 10_000,
		},
	);
}

/**
 * Walk stdout from end and return the last line that parses to a record.
 * The CLI may emit a warning JSON before the handler payload.
 */
function lastJsonRecord(stdout: string): Record<string, unknown> {
	const lines = stdout
		.trim()
		.split("\n")
		.filter((l) => l.length > 0);
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i];
		if (line === undefined) continue;
		try {
			const parsed: unknown = JSON.parse(line);
			if (isRecord(parsed)) return parsed;
		} catch {
			// keep walking
		}
	}
	throw new Error(`No JSON object found in stdout:\n${stdout}`);
}

// ─── A. Plugin ctx third arg ─────────────────────────────────────────────────

describe("plugin host context: ctx is passed as the third handler argument", () => {
	test("sanity: ctx is an object on a flag-aware handler", async () => {
		const result = await c8Plugin("echo-ctx");
		assert.strictEqual(
			result.status,
			0,
			`expected exit 0, got ${result.status}. stderr: ${result.stderr}`,
		);
		const parsed = lastJsonRecord(result.stdout);
		assert.ok(
			isRecord(parsed.ctx),
			`expected ctx to be an object on the handler payload. got: ${JSON.stringify(parsed)}`,
		);
	});

	test("ctx.dryRun reflects --dry-run", async () => {
		const result = await c8Plugin("echo-ctx", "--dry-run");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const parsed = lastJsonRecord(result.stdout);
		assert.ok(isRecord(parsed.ctx));
		assert.strictEqual(
			parsed.ctx.dryRun,
			true,
			`expected ctx.dryRun=true with --dry-run. got: ${JSON.stringify(parsed.ctx)}`,
		);
	});

	test("ctx.dryRun is false when --dry-run is omitted", async () => {
		const result = await c8Plugin("echo-ctx");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const parsed = lastJsonRecord(result.stdout);
		assert.ok(isRecord(parsed.ctx));
		assert.strictEqual(parsed.ctx.dryRun, false);
	});

	test("ctx.verbose reflects --verbose", async () => {
		const result = await c8Plugin("echo-ctx", "--verbose");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const parsed = lastJsonRecord(result.stdout);
		assert.ok(isRecord(parsed.ctx));
		assert.strictEqual(parsed.ctx.verbose, true);
	});

	test("ctx.profile reflects --profile", async () => {
		const result = await c8Plugin("echo-ctx", "--profile", "myprofile");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const parsed = lastJsonRecord(result.stdout);
		assert.ok(isRecord(parsed.ctx));
		assert.strictEqual(parsed.ctx.profile, "myprofile");
	});

	test("ctx.profile is undefined when no --profile or session profile is set", async () => {
		// Built-in commands pass `undefined` so resolveClusterConfig() can
		// fall through to CAMUNDA_* env vars. The plugin host must do the
		// same — defaulting to "default" would silently pin every plugin to
		// the local default profile and skip env-var resolution entirely.
		const result = await c8Plugin("echo-ctx");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const parsed = lastJsonRecord(result.stdout);
		assert.ok(isRecord(parsed.ctx));
		assert.strictEqual(parsed.ctx.profile, undefined);
	});

	test("ctx.outputMode is 'json' when --json is set", async () => {
		const result = await c8Plugin("echo-ctx", "--json");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const parsed = lastJsonRecord(result.stdout);
		assert.ok(isRecord(parsed.ctx));
		assert.strictEqual(parsed.ctx.outputMode, "json");
	});

	test("ctx.fields reflects --fields (parsed to array)", async () => {
		const result = await c8Plugin("echo-ctx", "--fields", "a,b,c");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const parsed = lastJsonRecord(result.stdout);
		assert.ok(isRecord(parsed.ctx));
		assert.deepStrictEqual(parsed.ctx.fields, ["a", "b", "c"]);
	});

	test("ctx.logger is exposed (object reference)", async () => {
		const result = await c8Plugin("echo-ctx");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const parsed = lastJsonRecord(result.stdout);
		assert.ok(isRecord(parsed.ctx));
		assert.strictEqual(
			parsed.ctx.hasLogger,
			true,
			"ctx.logger must be present and non-null",
		);
	});

	test("ctx.client getter is exposed (lazy — not eagerly resolved)", async () => {
		// The contract: `client` is a getter so plugins that never touch
		// it (session/profile commands) don't trigger credential resolution.
		const result = await c8Plugin("echo-ctx");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const parsed = lastJsonRecord(result.stdout);
		assert.ok(isRecord(parsed.ctx));
		assert.strictEqual(
			parsed.ctx.hasClient,
			true,
			"ctx.client property must be present (lazy getter)",
		);
	});

	// Class-scoped guard: every GLOBAL_FLAGS member is reflected in ctx
	// OR appears in the documented host-only exemption set.
	test("class-scoped: every GLOBAL_FLAGS entry is reflected in ctx or documented host-only", () => {
		// `help` and `version` are intercepted by the host BEFORE the
		// plugin handler runs (rendering happens out-of-band). Listing
		// them here makes the exemption explicit and reviewable.
		const HOST_ONLY: ReadonlySet<string> = new Set(["help", "version"]);
		const CTX_REFLECTIONS: ReadonlyMap<string, string> = new Map([
			["profile", "profile"],
			["dry-run", "dryRun"],
			["verbose", "verbose"],
			["fields", "fields"],
			["json", "outputMode"], // --json toggles outputMode
		]);
		const missing: string[] = [];
		for (const name of Object.keys(GLOBAL_FLAGS)) {
			if (HOST_ONLY.has(name)) continue;
			if (!CTX_REFLECTIONS.has(name)) missing.push(name);
		}
		assert.deepStrictEqual(
			missing,
			[],
			`Every GLOBAL_FLAGS entry must be reflected in PluginCtx or appear in HOST_ONLY. Missing: ${missing.join(", ")}`,
		);
	});
});

// ─── B. End-to-end honouring of ctx.dryRun ───────────────────────────────────

describe("plugin host context: a plugin can honour --dry-run via ctx", () => {
	test("plugin emits a dry-run summary when --dry-run is set", async () => {
		const result = await c8Plugin("dry-run-echo", "--dry-run");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const parsed = lastJsonRecord(result.stdout);
		assert.strictEqual(parsed.kind, "dry-run");
		assert.strictEqual(parsed.message, "would do X");
	});

	test("plugin executes normally when --dry-run is omitted", async () => {
		const result = await c8Plugin("dry-run-echo");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const parsed = lastJsonRecord(result.stdout);
		assert.strictEqual(parsed.kind, "executed");
	});
});

// ─── C. Plugin-authored --help and --version ─────────────────────────────────

describe("plugin host context: plugin-authored --help", () => {
	test("--help on a plugin verb renders plugin metadata, not the handler", async () => {
		// In JSON mode (set by the session fixture), help renders as JSON.
		// The plugin handler must NOT be invoked — if it were, we'd see
		// the echo-ctx payload shape `{args, flags, ctx}` instead.
		const result = await c8Plugin("echo-ctx", "--help");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const parsed = lastJsonRecord(result.stdout);
		// Help renderer payload shape — not the handler's `{args, flags, ctx}`.
		assert.ok(
			!("ctx" in parsed),
			`expected help renderer output, not handler echo. got: ${JSON.stringify(parsed).slice(0, 200)}`,
		);
		// The plugin's verb name must appear somewhere identifying.
		const stringifiedJson = JSON.stringify(parsed);
		assert.ok(
			stringifiedJson.includes("echo-ctx"),
			`expected help payload to identify the verb. got: ${stringifiedJson.slice(0, 200)}`,
		);
	});

	test("--help payload includes the plugin's declared flags", async () => {
		const result = await c8Plugin("echo-ctx", "--help");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const stringifiedJson = JSON.stringify(lastJsonRecord(result.stdout));
		assert.ok(
			stringifiedJson.includes("flag1"),
			`expected plugin's declared --flag1 to appear in help. got: ${stringifiedJson.slice(0, 400)}`,
		);
	});

	test("--help payload includes the plugin's examples", async () => {
		const result = await c8Plugin("echo-ctx", "--help");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const stringifiedJson = JSON.stringify(lastJsonRecord(result.stdout));
		// The fixture declares an example with this exact string.
		assert.ok(
			stringifiedJson.includes("Echo with a plugin flag"),
			`expected plugin example to appear in help. got: ${stringifiedJson.slice(0, 400)}`,
		);
	});
});

describe("plugin host context: plugin-authored --version", () => {
	test("--version on a plugin verb prints the plugin's version (not c8ctl's)", async () => {
		const result = await c8Plugin("echo-ctx", "--version");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const combined = `${result.stdout}\n${result.stderr}`;
		assert.ok(
			combined.includes(PLUGIN_VERSION),
			`expected plugin version "${PLUGIN_VERSION}" in output. got stdout: ${result.stdout} stderr: ${result.stderr}`,
		);
	});

	test("--version on a plugin verb identifies the plugin by name", async () => {
		const result = await c8Plugin("echo-ctx", "--version");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const combined = `${result.stdout}\n${result.stderr}`;
		assert.ok(
			combined.includes(PLUGIN_NAME),
			`expected plugin name "${PLUGIN_NAME}" in --version output. got: ${combined}`,
		);
	});
});

// ─── D. Backward compatibility ───────────────────────────────────────────────

describe("plugin host context: backward compatibility for 2-arg handlers", () => {
	test("a legacy (args, flags) handler still runs when host passes 3 args", async () => {
		const result = await c8Plugin("legacy-two-arg", "pos1");
		assert.strictEqual(
			result.status,
			0,
			`legacy 2-arg plugin handler must keep working. stderr: ${result.stderr}`,
		);
		const parsed = lastJsonRecord(result.stdout);
		assert.deepStrictEqual(parsed.args, ["pos1"]);
		assert.strictEqual(parsed.sawCtx, false);
	});
});
