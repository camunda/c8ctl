/**
 * Tests for plugin flag support
 */

import assert from "node:assert";
import { describe, test } from "node:test";
import { clearLoadedPlugins, getPluginFlags } from "../../src/plugin-loader.ts";

const testPlugin = await import(
	// @ts-expect-error — JS plugin has no declaration file; typed via runtime shape assertions below
	"../fixtures/plugins/plugin-with-flags/c8ctl-plugin.js"
);

describe("Plugin Flags", () => {
	test("plugin exports flags alongside commands", () => {
		assert.ok(testPlugin.flags, "Plugin should export flags");
		assert.ok(
			testPlugin.flags["test-flags"],
			"Plugin should have flags for test-flags command",
		);
		assert.strictEqual(
			testPlugin.flags["test-flags"].source.type,
			"string",
			"Source flag should be string type",
		);
		assert.strictEqual(
			testPlugin.flags["test-flags"].verbose.type,
			"boolean",
			"Verbose flag should be boolean type",
		);
	});

	test("plugin command handler accepts flags parameter", async () => {
		const handler = testPlugin.commands["test-flags"];
		assert.strictEqual(
			typeof handler,
			"function",
			"Command handler should be a function",
		);
		// Check function signature accepts two parameters (args and flags)
		assert.strictEqual(
			handler.length,
			2,
			"Handler should accept 2 parameters (args, flags)",
		);
	});
});

describe("Plugin Flags Integration", () => {
	test("getPluginFlags returns empty object when no plugins loaded", () => {
		clearLoadedPlugins();
		const flags = getPluginFlags();
		assert.deepStrictEqual(flags, {}, "Should return empty object");
	});

	test("plugin receives flags when executing command", async () => {
		// Simulate plugin execution with flags
		const flags = { source: "Gateway_1", target: "Task_2", verbose: true };
		const args: string[] = [];

		// Capture stdout to verify plugin output
		let capturedOutput = "";
		const originalLog = console.log;
		console.log = (msg: string) => {
			capturedOutput = msg;
		};

		try {
			await testPlugin.commands["test-flags"](args, flags);
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

		// Capture stdout to verify plugin output
		let capturedOutput = "";
		const originalLog = console.log;
		console.log = (msg: string) => {
			capturedOutput = msg;
		};

		try {
			await testPlugin.commands["test-flags"](args, undefined);
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
