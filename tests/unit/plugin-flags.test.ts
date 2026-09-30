/**
 * Tests for plugin flag support
 */

import assert from "node:assert";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { asyncSpawn } from "../utils/spawn.ts";

const testPlugin = await import(
	// @ts-expect-error — JS plugin has no declaration file; typed via runtime shape assertions below
	"../fixtures/plugins/plugin-with-flags/c8ctl-plugin.js"
);

describe("Plugin Flags", () => {
	test("plugin command declares flags inline", () => {
		const cmd = testPlugin.commands["test-flags"];
		assert.ok(cmd, "Plugin should have test-flags command");
		assert.strictEqual(
			typeof cmd,
			"object",
			"Command with flags should be an object",
		);
		assert.ok("flags" in cmd, "Command object should have a flags property");
		assert.ok(
			"handler" in cmd,
			"Command object should have a handler property",
		);
		assert.strictEqual(
			cmd.flags.source.type,
			"string",
			"Source flag should be string type",
		);
		assert.strictEqual(
			cmd.flags.debug.type,
			"boolean",
			"Debug flag should be boolean type",
		);
	});

	test("plugin command handler accepts flags parameter", async () => {
		const cmd = testPlugin.commands["test-flags"];
		assert.strictEqual(
			typeof cmd.handler,
			"function",
			"handler should be a function",
		);
		assert.strictEqual(
			cmd.handler.length,
			2,
			"Handler should accept 2 parameters (args, flags)",
		);
	});

	test("plugin does not export a top-level flags object", () => {
		assert.strictEqual(
			testPlugin.flags,
			undefined,
			"Plugin should not export a top-level flags object",
		);
	});
});

describe("Plugin Flags Integration", () => {
	test("plugin receives flags when executing command", async () => {
		const flags = { source: "Gateway_1", target: "Task_2", debug: true };
		const args: string[] = [];

		let capturedOutput = "";
		const originalLog = console.log;
		console.log = (msg: string) => {
			capturedOutput = msg;
		};

		try {
			await testPlugin.commands["test-flags"].handler(args, flags);
			const output = JSON.parse(capturedOutput);

			assert.deepStrictEqual(output.args, args, "Args should be passed");
			assert.deepStrictEqual(
				output.flags,
				flags,
				"Flags should be passed correctly",
			);
		} finally {
			console.log = originalLog;
		}
	});

	test("plugin receives empty flags object when no flags provided", async () => {
		const args: string[] = ["arg1", "arg2"];

		let capturedOutput = "";
		const originalLog = console.log;
		console.log = (msg: string) => {
			capturedOutput = msg;
		};

		try {
			await testPlugin.commands["test-flags"].handler(args, undefined);
			const output = JSON.parse(capturedOutput);

			assert.deepStrictEqual(output.args, args, "Args should be passed");
			assert.deepStrictEqual(
				output.flags,
				{},
				"Flags should be empty object when undefined",
			);
		} finally {
			console.log = originalLog;
		}
	});
});

// ---------------------------------------------------------------------------
// Subprocess-level tests: exercise the full CLI reparse/blacklist path in
// src/index.ts rather than calling the handler directly.
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = "src/index.ts";
const FIXTURE_DIR = join(__dirname, "../fixtures/plugins/plugin-with-flags");

function makePluginDataDir(outputMode: "json" | "text" = "json"): string {
	const dir = mkdtempSync(join(tmpdir(), "c8ctl-plugin-test-"));
	writeFileSync(join(dir, "session.json"), JSON.stringify({ outputMode }));
	const pluginInstallDir = join(
		dir,
		"plugins",
		"node_modules",
		"plugin-with-flags",
	);
	mkdirSync(pluginInstallDir, { recursive: true });
	cpSync(FIXTURE_DIR, pluginInstallDir, { recursive: true });
	return dir;
}

const PLUGIN_DATA_DIR = makePluginDataDir();

const PLUGIN_TEXT_DATA_DIR = makePluginDataDir("text");

function runWithDataDir(dataDir: string, args: string[]) {
	return asyncSpawn("node", ["--experimental-strip-types", CLI, ...args], {
		env: {
			...process.env,
			CAMUNDA_BASE_URL: "http://test-cluster/v2",
			HOME: "/tmp/c8ctl-test-nonexistent-home",
			C8CTL_DATA_DIR: dataDir,
		},
	});
}

async function c8plugin(...args: string[]) {
	return runWithDataDir(PLUGIN_DATA_DIR, args);
}

/** Text output mode: `help <verb>` renders the plugin's own Flags block. */
async function c8pluginText(...args: string[]) {
	return runWithDataDir(PLUGIN_TEXT_DATA_DIR, args);
}

describe("Plugin Flags CLI subprocess — required flags", () => {
	test("exits 1 with error message when required flag is omitted", async () => {
		const result = await c8plugin("test-required");
		assert.strictEqual(
			result.status,
			1,
			`expected exit 1, got ${result.status}. stderr: ${result.stderr}`,
		);
		assert.ok(
			result.stderr.includes("--required-name is required"),
			`expected '--required-name is required' in stderr. stderr: ${result.stderr}`,
		);
	});

	test("exits 0 and passes value when required flag is provided", async () => {
		const result = await c8plugin("test-required", "--required-name", "hello");
		assert.strictEqual(
			result.status,
			0,
			`expected exit 0, got ${result.status}. stderr: ${result.stderr}`,
		);
		const output = JSON.parse(result.stdout);
		assert.strictEqual(output.flags["required-name"], "hello");
	});
});

describe("Plugin Flags CLI subprocess — built-in collision", () => {
	test("emits warning and does not forward colliding flag to handler", async () => {
		const result = await c8plugin(
			"test-collision",
			"--verbose",
			"myval",
			"--safe",
			"safeval",
		);
		assert.strictEqual(
			result.status,
			0,
			`expected exit 0, got ${result.status}. stderr: ${result.stderr}`,
		);
		assert.ok(
			result.stderr.includes("verbose"),
			`expected collision warning for 'verbose' in stderr. stderr: ${result.stderr}`,
		);
		const output = JSON.parse(result.stdout);
		assert.strictEqual(
			output.flags.verbose,
			undefined,
			"colliding flag should not reach handler",
		);
		assert.strictEqual(
			output.flags.safe,
			"safeval",
			"non-colliding flag should still be passed",
		);
		assert.deepStrictEqual(
			output.args,
			[],
			"value token of blocked flag should not appear as a positional arg",
		);
	});
});

describe("Plugin Flags CLI subprocess — required + built-in collision (#364)", () => {
	// A plugin flag declared `required: true` whose name collides with a
	// built-in flag is unsatisfiable: the colliding token is always stripped
	// from argv before the plugin parser sees it. The CLI must fail fast at
	// dispatch with an actionable error rather than emit the misleading
	// "--<name> is required" after the handler has been "called".
	test("rejects unsatisfiable command with actionable error, even when user passes the flag", async () => {
		const result = await c8plugin(
			"test-required-collision",
			"--profile",
			"anything",
		);
		assert.strictEqual(
			result.status,
			1,
			`expected exit 1, got ${result.status}. stderr: ${result.stderr}`,
		);
		assert.ok(
			result.stderr.includes("--profile"),
			`expected error to name the colliding flag. stderr: ${result.stderr}`,
		);
		assert.ok(
			result.stderr.includes(
				"is declared required but conflicts with a global c8ctl flag",
			),
			`expected new actionable error sentence. stderr: ${result.stderr}`,
		);
		// The misleading legacy message is the bare phrase "--profile is
		// required" with no surrounding "declared" / "conflicts" context.
		// Assert it is absent independently of stderr formatting (text vs
		// JSON, ✗ prefix, etc.).
		const legacyBareError =
			/(?:^|[^a-zA-Z])--profile is required(?:[^a-zA-Z]|$)/;
		const withoutNewMessage = result.stderr
			.split("\n")
			.filter((line) => !line.includes("is declared required but conflicts"))
			.join("\n");
		assert.ok(
			!legacyBareError.test(withoutNewMessage),
			`legacy bare "--profile is required" must not appear. stderr: ${result.stderr}`,
		);
		assert.strictEqual(
			result.stdout.trim(),
			"",
			`handler must not run. stdout: ${result.stdout}`,
		);
	});

	test("rejects unsatisfiable command even when user omits the flag entirely", async () => {
		const result = await c8plugin("test-required-collision");
		assert.strictEqual(
			result.status,
			1,
			`expected exit 1, got ${result.status}. stderr: ${result.stderr}`,
		);
		assert.ok(
			result.stderr.includes("global c8ctl flag"),
			`expected error mentioning global flag collision. stderr: ${result.stderr}`,
		);
	});
});

describe("Plugin Flags CLI subprocess", () => {
	test("string and boolean flags are parsed and passed to handler", async () => {
		const result = await c8plugin(
			"test-flags",
			"--source",
			"Gateway_1",
			"--debug",
		);
		assert.strictEqual(
			result.status,
			0,
			`expected exit 0, got ${result.status}. stderr: ${result.stderr}`,
		);
		const output = JSON.parse(result.stdout);
		assert.strictEqual(output.flags.source, "Gateway_1");
		assert.strictEqual(output.flags.debug, true);
	});

	test("positional args are passed alongside flags", async () => {
		const result = await c8plugin(
			"test-flags",
			"arg1",
			"--source",
			"Gateway_1",
		);
		assert.strictEqual(
			result.status,
			0,
			`expected exit 0. stderr: ${result.stderr}`,
		);
		const output = JSON.parse(result.stdout);
		assert.deepStrictEqual(output.args, ["arg1"]);
		assert.strictEqual(output.flags.source, "Gateway_1");
	});

	test("repeated string flag uses last value", async () => {
		const result = await c8plugin(
			"test-flags",
			"--source",
			"first",
			"--source",
			"last",
		);
		assert.strictEqual(
			result.status,
			0,
			`expected exit 0. stderr: ${result.stderr}`,
		);
		const output = JSON.parse(result.stdout);
		assert.strictEqual(output.flags.source, "last");
	});
});

describe("Plugin Flags CLI subprocess — string flag without a value", () => {
	// A string flag followed by another flag (or by the end of the line) was
	// given without a value. It reads as `true` — never as the next flag's
	// text — and the following flag is still parsed as a flag.
	test("`--source --debug` gives source:true and debug:true", async () => {
		const result = await c8plugin("test-flags", "--source", "--debug");
		assert.strictEqual(result.status, 0, result.stderr);
		const { flags } = JSON.parse(result.stdout);
		assert.strictEqual(flags.source, true);
		assert.strictEqual(flags.debug, true);
	});

	test("`--source` at the end of the line gives source:true", async () => {
		const result = await c8plugin("test-flags", "--debug", "--source");
		assert.strictEqual(result.status, 0, result.stderr);
		const { flags } = JSON.parse(result.stdout);
		assert.strictEqual(flags.source, true);
		assert.strictEqual(flags.debug, true);
	});

	test("`--source=x` and `--source x` give the value", async () => {
		for (const form of [["--source=x"], ["--source", "x"]]) {
			const result = await c8plugin("test-flags", ...form);
			assert.strictEqual(result.status, 0, result.stderr);
			assert.strictEqual(JSON.parse(result.stdout).flags.source, "x");
		}
	});

	test("`--source=` is an explicit empty value", async () => {
		const result = await c8plugin("test-flags", "--source=");
		assert.strictEqual(result.status, 0, result.stderr);
		assert.strictEqual(JSON.parse(result.stdout).flags.source, "");
	});

	test("`--source -5` keeps `-5` as the value (it is not a known flag)", async () => {
		const result = await c8plugin("test-flags", "--source", "-5");
		assert.strictEqual(result.status, 0, result.stderr);
		const { flags, args } = JSON.parse(result.stdout);
		assert.strictEqual(flags.source, "-5");
		assert.deepStrictEqual(args, []);
	});

	test("a string flag followed by a global flag is not given the global as its value", async () => {
		const result = await c8plugin("test-flags", "--source", "--json");
		assert.strictEqual(result.status, 0, result.stderr);
		assert.strictEqual(JSON.parse(result.stdout).flags.source, true);
	});
});

describe("Plugin Flags CLI subprocess — undeclared flags are reported", () => {
	test("an undeclared flag warns, names the declared flags, and the command still runs", async () => {
		const result = await c8plugin("test-flags", "--nope", "--source", "x");
		assert.strictEqual(result.status, 0, result.stderr);
		assert.ok(
			result.stderr.includes("Unknown flag --nope for 'test-flags'"),
			`expected unknown-flag warning. stderr: ${result.stderr}`,
		);
		assert.ok(
			result.stderr.includes("--source") &&
				result.stderr.includes("--target") &&
				result.stderr.includes("--debug"),
			`expected the declared flags to be listed. stderr: ${result.stderr}`,
		);
		const { flags } = JSON.parse(result.stdout);
		assert.strictEqual(flags.source, "x");
		assert.strictEqual(flags.nope, undefined);
	});

	test("no warning when only declared and global flags are used", async () => {
		const result = await c8plugin("test-flags", "--source", "x", "--json");
		assert.strictEqual(result.status, 0, result.stderr);
		assert.ok(!result.stderr.includes("Unknown flag"), result.stderr);
	});

	test("a bare-function command (no declared flags) warns too, and gets only positionals", async () => {
		const result = await c8plugin("test-bare", "pos", "--nope");
		assert.strictEqual(result.status, 0, result.stderr);
		assert.ok(
			result.stderr.includes("Unknown flag --nope for 'test-bare'") &&
				result.stderr.includes("declares no flags"),
			result.stderr,
		);
		assert.deepStrictEqual(JSON.parse(result.stdout).args, ["pos"]);
	});

	test("an undeclared short flag is reported as -x", async () => {
		const result = await c8plugin("test-flags", "-z");
		assert.strictEqual(result.status, 0, result.stderr);
		assert.ok(result.stderr.includes("Unknown flag -z"), result.stderr);
	});
});

describe("Plugin Flags CLI subprocess — collision warnings only on use", () => {
	test("no warning when the user does not type the colliding flag", async () => {
		const result = await c8plugin("test-collision", "--safe", "safeval");
		assert.strictEqual(result.status, 0, result.stderr);
		assert.strictEqual(
			result.stderr.trim(),
			"",
			`expected a silent run. stderr: ${result.stderr}`,
		);
	});

	test("typing the colliding flag warns that it is reserved by c8ctl", async () => {
		const result = await c8plugin("test-collision", "--verbose");
		assert.strictEqual(result.status, 0, result.stderr);
		assert.ok(
			result.stderr.includes("--verbose is reserved by c8ctl"),
			result.stderr,
		);
	});

	test("a colliding short alias warns only when typed; the long flag keeps working", async () => {
		const quiet = await c8plugin("test-short-collision", "--label-value", "a");
		assert.strictEqual(quiet.status, 0, quiet.stderr);
		assert.strictEqual(quiet.stderr.trim(), "", quiet.stderr);
		assert.strictEqual(JSON.parse(quiet.stdout).flags["label-value"], "a");

		const typed = await c8plugin("test-short-collision", "-y", "a");
		assert.ok(typed.stderr.includes("-y is reserved by c8ctl"), typed.stderr);
	});
});

describe("Plugin Flags CLI subprocess — help hides reserved flags", () => {
	test("`help <verb>` lists usable flags but not flags named like a global", async () => {
		const result = await c8pluginText("help", "test-collision");
		assert.strictEqual(result.status, 0, result.stderr);
		const out = result.stdout + result.stderr;
		assert.ok(out.includes("safe"), "the usable flag must be listed");
		assert.ok(
			!out.includes("Collides with built-in --verbose"),
			`a reserved flag must not be advertised. output: ${out}`,
		);
	});

	test("a reserved short alias is not advertised, the long flag is", async () => {
		const result = await c8pluginText("help", "test-short-collision");
		const out = result.stdout + result.stderr;
		assert.ok(out.includes("label-value"), out);
		assert.ok(
			!out.includes("--label-value, -y"),
			`reserved alias must not be shown: ${out}`,
		);
	});
});

describe("Plugin Flags CLI subprocess — doctor reports reserved flags once", () => {
	test("`doctor plugin` lists colliding declarations", async () => {
		const result = await c8plugin("doctor", "plugin");
		assert.strictEqual(result.status, 0, result.stderr);
		const report = JSON.parse(result.stdout);
		const found = report.flagCollisions.map(
			(c: { command: string; flag: string; kind: string }) =>
				`${c.command}:${c.flag}:${c.kind}`,
		);
		assert.ok(found.includes("test-collision:verbose:name"), found.join());
		assert.ok(
			found.includes("test-required-collision:profile:name"),
			found.join(),
		);
		assert.ok(
			found.includes("test-short-collision:label-value:short"),
			found.join(),
		);
	});
});

describe("Plugin Flags CLI subprocess — plugin flags before the verb are rejected", () => {
	test("`--source x test-flags` fails with a corrected-order suggestion, not 'Unknown command'", async () => {
		const result = await c8plugin("--source", "x", "test-flags");
		const out = result.stdout + result.stderr;
		assert.notStrictEqual(result.status, 0);
		assert.ok(!out.includes("Unknown command"), out);
		assert.ok(out.includes("Flag --source is not a global flag"), out);
		assert.ok(out.includes("Did you mean: c8ctl test-flags --source x"), out);
	});

	test("a boolean plugin flag before the verb", async () => {
		const result = await c8plugin("--debug", "test-flags");
		assert.notStrictEqual(result.status, 0);
		assert.ok(
			(result.stdout + result.stderr).includes(
				"Did you mean: c8ctl test-flags --debug",
			),
			result.stderr,
		);
	});

	test("the same flags after the verb still work", async () => {
		const result = await c8plugin("test-flags", "--source", "x", "--debug");
		assert.strictEqual(result.status, 0, result.stderr);
		assert.strictEqual(JSON.parse(result.stdout).flags.source, "x");
	});

	test("a global before the plugin verb still works", async () => {
		const result = await c8plugin("--json", "test-flags", "--source", "x");
		assert.strictEqual(result.status, 0, result.stderr);
	});
});

describe("Plugin Flags CLI subprocess — `--` terminator and flag spelling", () => {
	test("tokens after `--` are literal positionals, even a reserved flag name", async () => {
		const result = await c8plugin(
			"test-collision",
			"--",
			"--verbose",
			"literal",
		);
		assert.strictEqual(result.status, 0, result.stderr);
		assert.deepStrictEqual(JSON.parse(result.stdout).args, [
			"--verbose",
			"literal",
		]);
		assert.ok(!result.stderr.includes("reserved"), result.stderr);
	});

	test("a reserved flag before `--` is still stripped, the ones after it are kept", async () => {
		const result = await c8plugin(
			"test-collision",
			"--verbose",
			"--",
			"--verbose",
		);
		assert.strictEqual(result.status, 0, result.stderr);
		assert.deepStrictEqual(JSON.parse(result.stdout).args, ["--verbose"]);
	});

	test("an undeclared long flag is reported as --x, not -x", async () => {
		const result = await c8plugin("test-flags", "--x");
		assert.ok(result.stderr.includes("Unknown flag --x for"), result.stderr);
		assert.ok(!/Unknown flag -x\b/.test(result.stderr), result.stderr);
	});

	test("an undeclared short flag is reported as -x, and a repeat is listed once", async () => {
		const short = await c8plugin("test-flags", "-x");
		assert.ok(short.stderr.includes("Unknown flag -x for"), short.stderr);
		const both = await c8plugin("test-flags", "--x", "-x", "--x=1");
		assert.ok(both.stderr.includes("Unknown flags --x, -x for"), both.stderr);
	});

	test("an undeclared flag after `--` is not reported", async () => {
		const result = await c8plugin("test-flags", "--", "--nope");
		assert.ok(!result.stderr.includes("Unknown flag"), result.stderr);
	});
});
