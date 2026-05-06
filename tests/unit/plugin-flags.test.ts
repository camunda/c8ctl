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

function makePluginDataDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "c8ctl-plugin-test-"));
	writeFileSync(
		join(dir, "session.json"),
		JSON.stringify({ outputMode: "json" }),
	);
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

async function c8plugin(...args: string[]) {
	return asyncSpawn("node", ["--experimental-strip-types", CLI, ...args], {
		env: {
			...process.env,
			CAMUNDA_BASE_URL: "http://test-cluster/v2",
			HOME: "/tmp/c8ctl-test-nonexistent-home",
			C8CTL_DATA_DIR: PLUGIN_DATA_DIR,
		},
	});
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
