/**
 * Tests for plugin flag support
 */

import assert from "node:assert";
import { describe, test } from "node:test";

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
			"Verbose flag should be boolean type",
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
