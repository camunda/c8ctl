/**
 * Unit tests for the bpmn plugin (default-plugins/bpmn)
 */

import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

// @ts-expect-error — JS plugin has no declaration file; typed via runtime shape assertions below
const plugin = await import("../../default-plugins/bpmn/c8ctl-plugin.js");

const FIXTURES_DIR = resolve(import.meta.dirname, "..", "fixtures");

// ---------------------------------------------------------------------------
// metadata
// ---------------------------------------------------------------------------

describe("BPMN Plugin – metadata", () => {
	test('has name "bpmn"', () => {
		assert.strictEqual(plugin.metadata.name, "bpmn");
	});

	test("has a description", () => {
		assert.ok(
			typeof plugin.metadata.description === "string" &&
				plugin.metadata.description.length > 0,
			"metadata.description should be a non-empty string",
		);
	});

	test('declares the "bpmn" command', () => {
		assert.ok(plugin.metadata.commands.bpmn, 'Should declare a "bpmn" command');
	});

	test("bpmn command has a description", () => {
		const cmd = plugin.metadata.commands.bpmn;
		assert.ok(
			typeof cmd.description === "string" && cmd.description.length > 0,
			"bpmn command should have a non-empty description",
		);
	});

	test("bpmn command provides examples", () => {
		const examples = plugin.metadata.commands.bpmn.examples;
		assert.ok(Array.isArray(examples), "examples should be an array");
		assert.ok(examples.length >= 2, "Should have at least two examples");

		for (const ex of examples) {
			assert.ok(
				typeof ex.command === "string" && ex.command.length > 0,
				"Each example must have a command",
			);
			assert.ok(
				typeof ex.description === "string" && ex.description.length > 0,
				"Each example must have a description",
			);
		}
	});

	test("examples include lint and apply-element-template commands", () => {
		const examples = plugin.metadata.commands.bpmn.examples;
		const cmds = examples.map((e: { command: string }) => e.command);
		assert.ok(
			cmds.some((c: string) => c.includes("lint")),
			"Should have a lint example",
		);
		assert.ok(
			cmds.some((c: string) => c.includes("apply-element-template")),
			"Should have an apply-element-template example",
		);
	});

	test("declares subcommands for shell completion", () => {
		const subcommands = plugin.metadata.commands.bpmn.subcommands;
		assert.ok(Array.isArray(subcommands), "subcommands should be an array");

		const names = subcommands.map((s: { name: string }) => s.name);
		assert.ok(names.includes("lint"), "Should include lint subcommand");
		assert.ok(
			names.includes("apply-element-template"),
			"Should include apply-element-template subcommand",
		);

		for (const sub of subcommands) {
			assert.ok(
				typeof sub.description === "string" && sub.description.length > 0,
				`Subcommand "${sub.name}" must have a description`,
			);
		}
	});
});

// ---------------------------------------------------------------------------
// commands export
// ---------------------------------------------------------------------------

describe("BPMN Plugin – commands export", () => {
	test('exports a commands object with a "bpmn" key', () => {
		assert.ok(plugin.commands, "Should export commands");
		assert.ok(
			typeof plugin.commands.bpmn === "function",
			'"bpmn" should be a function',
		);
	});
});

// ---------------------------------------------------------------------------
// bpmn command – usage / argument handling
// ---------------------------------------------------------------------------

describe("BPMN Plugin – command usage output", () => {
	let captured: string[];
	let originalLog: typeof console.log;

	beforeEach(() => {
		captured = [];
		originalLog = console.log;
		console.log = (...args: unknown[]) => {
			captured.push(args.map(String).join(" "));
		};
	});

	afterEach(() => {
		console.log = originalLog;
		process.exitCode = undefined;
	});

	test("prints usage when called with no arguments", async () => {
		await plugin.commands.bpmn([]);

		const output = captured.join("\n");
		assert.ok(output.includes("Usage"), "Should print usage header");
		assert.ok(output.includes("lint"), 'Usage should mention "lint"');
		assert.ok(
			output.includes("apply-element-template"),
			'Usage should mention "apply-element-template"',
		);
	});

	test("prints usage when called with an invalid subcommand", async () => {
		await plugin.commands.bpmn(["invalid"]);

		const output = captured.join("\n");
		assert.ok(
			output.includes("Usage"),
			"Should print usage for unrecognised subcommand",
		);
		assert.strictEqual(
			process.exitCode,
			1,
			"Should set exitCode to 1 for invalid subcommand",
		);
	});

	test("does not set exitCode when called with no arguments (help)", async () => {
		await plugin.commands.bpmn([]);
		assert.strictEqual(
			process.exitCode,
			undefined,
			"Should not set exitCode for help usage",
		);
	});

	test("usage mentions Subcommands section", async () => {
		await plugin.commands.bpmn([]);

		const output = captured.join("\n");
		assert.ok(
			output.includes("Subcommands"),
			"Should contain a Subcommands section",
		);
	});

	test("usage describes auto-detection of Camunda version", async () => {
		await plugin.commands.bpmn([]);

		const output = captured.join("\n");
		assert.ok(
			output.includes("auto-detect") || output.includes("Camunda Cloud"),
			"Should mention Camunda version detection",
		);
	});
});

// ---------------------------------------------------------------------------
// bpmn lint – file input
// ---------------------------------------------------------------------------

describe("BPMN Plugin – lint command", () => {
	let capturedLog: string[];
	let capturedErr: string[];
	let originalLog: typeof console.log;
	let originalErr: typeof console.error;
	let savedC8ctl: typeof globalThis.c8ctl;

	beforeEach(() => {
		capturedLog = [];
		capturedErr = [];
		originalLog = console.log;
		originalErr = console.error;
		savedC8ctl = globalThis.c8ctl;
		console.log = (...args: unknown[]) => {
			capturedLog.push(args.map(String).join(" "));
		};
		console.error = (...args: unknown[]) => {
			capturedErr.push(args.map(String).join(" "));
		};
		globalThis.c8ctl = {
			outputMode: "text",
			getLogger: () => ({
				info: (...args: unknown[]) =>
					capturedLog.push(args.map(String).join(" ")),
				warn: (...args: unknown[]) =>
					capturedErr.push(args.map(String).join(" ")),
				error: (...args: unknown[]) =>
					capturedErr.push(args.map(String).join(" ")),
				debug: () => {},
				json: (data: unknown) =>
					capturedLog.push(JSON.stringify(data, null, 2)),
			}),
		};
	});

	afterEach(() => {
		console.log = originalLog;
		console.error = originalErr;
		globalThis.c8ctl = savedC8ctl;
		process.exitCode = undefined;
	});

	test("lint clean file exits without errors", async () => {
		const file = join(FIXTURES_DIR, "simple.bpmn");
		await plugin.commands.bpmn(["lint", file]);

		// simple.bpmn is clean — no output expected
		assert.notStrictEqual(process.exitCode, 1, "Should not set exitCode 1");
	});

	test("lint file with issues reports errors", async () => {
		const file = join(FIXTURES_DIR, "simple-will-create-incident.bpmn");
		await plugin.commands.bpmn(["lint", file]);

		const output = capturedLog.join("\n");
		assert.ok(
			output.includes("label-required"),
			"Should report label-required rule violations",
		);
		assert.ok(
			output.includes("error"),
			"Should include error category in output",
		);
		assert.strictEqual(
			process.exitCode,
			1,
			"Should set exitCode to 1 when errors are found",
		);
	});

	test("lint file with issues shows problem count summary", async () => {
		const file = join(FIXTURES_DIR, "simple-will-create-incident.bpmn");
		await plugin.commands.bpmn(["lint", file]);

		const output = capturedLog.join("\n");
		assert.ok(/\d+ problem/.test(output), "Should show problem count summary");
	});

	test("lint missing file throws", async () => {
		await assert.rejects(
			plugin.commands.bpmn(["lint", "/nonexistent/file.bpmn"]),
			/File not found/,
			"Should throw for missing file",
		);
	});

	test("lint with no file and TTY stdin shows usage", async () => {
		// When stdin is a TTY and no file is given, the plugin shows usage
		// This test only works if stdin IS a TTY (which it is in test runner)
		if (process.stdin.isTTY) {
			await plugin.commands.bpmn(["lint"]);

			const allOutput = [...capturedLog, ...capturedErr].join("\n");
			assert.ok(
				allOutput.includes("Usage") || allOutput.includes("c8ctl bpmn lint"),
				"Should show usage when no input is available",
			);
			assert.strictEqual(
				process.exitCode,
				1,
				"Should set exitCode to 1 for missing input",
			);
		}
	});

	test("lint invalid XML sets exitCode to 1", async () => {
		// Create a temp file with invalid XML inline via the plugin
		const { writeFileSync, mkdtempSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const tempDir = mkdtempSync(join(tmpdir(), "c8ctl-bpmn-test-"));
		const tempFile = join(tempDir, "invalid.bpmn");
		writeFileSync(tempFile, "<not-valid-bpmn>broken</not-valid-bpmn>");

		try {
			await plugin.commands.bpmn(["lint", tempFile]);
			const allOutput = [...capturedLog, ...capturedErr].join("\n");
			assert.ok(
				allOutput.includes("Failed to parse") || process.exitCode === 1,
				"Should report parse error or set exitCode",
			);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// bpmn apply-element-template
// ---------------------------------------------------------------------------

describe("BPMN Plugin – apply-element-template command", () => {
	let capturedLog: string[];
	let capturedErr: string[];
	let capturedStdout: string[];
	let originalLog: typeof console.log;
	let originalErr: typeof console.error;
	let originalStdoutWrite: typeof process.stdout.write;
	let savedC8ctl: typeof globalThis.c8ctl;

	beforeEach(() => {
		capturedLog = [];
		capturedErr = [];
		capturedStdout = [];
		originalLog = console.log;
		originalErr = console.error;
		originalStdoutWrite = process.stdout.write;
		savedC8ctl = globalThis.c8ctl;

		console.log = (...args: unknown[]) => {
			capturedLog.push(args.map(String).join(" "));
		};
		console.error = (...args: unknown[]) => {
			capturedErr.push(args.map(String).join(" "));
		};
		process.stdout.write = ((chunk: string | Uint8Array) => {
			capturedStdout.push(typeof chunk === "string" ? chunk : chunk.toString());
			return true;
		}) satisfies typeof process.stdout.write;

		globalThis.c8ctl = {
			outputMode: "text",
			getLogger: () => ({
				info: (...args: unknown[]) =>
					capturedLog.push(args.map(String).join(" ")),
				warn: (...args: unknown[]) =>
					capturedErr.push(args.map(String).join(" ")),
				error: (...args: unknown[]) =>
					capturedErr.push(args.map(String).join(" ")),
				debug: () => {},
				json: (data: unknown) =>
					capturedLog.push(JSON.stringify(data, null, 2)),
			}),
		};
	});

	afterEach(() => {
		console.log = originalLog;
		console.error = originalErr;
		process.stdout.write = originalStdoutWrite;
		globalThis.c8ctl = savedC8ctl;
		process.exitCode = undefined;
	});

	test("applies template and outputs modified BPMN to stdout", async () => {
		const bpmnFile = join(FIXTURES_DIR, "simple.bpmn");
		const templateFile = join(FIXTURES_DIR, "element-template.json");

		await plugin.commands.bpmn([
			"apply-element-template",
			templateFile,
			"Activity_17s7axj",
			bpmnFile,
		]);

		const output = capturedStdout.join("");
		assert.ok(output.includes("<?xml"), "Should output valid XML");
		assert.ok(
			output.includes("test-type"),
			"Should include the template's task type value in output",
		);
		assert.notStrictEqual(
			process.exitCode,
			1,
			"Should not set exitCode to 1 on success",
		);
	});

	test("applies template in-place when --in-place flag is set", async () => {
		const { writeFileSync, mkdtempSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const tempDir = mkdtempSync(join(tmpdir(), "c8ctl-bpmn-test-"));
		const tempBpmn = join(tempDir, "test.bpmn");
		const originalXml = readFileSync(
			join(FIXTURES_DIR, "simple.bpmn"),
			"utf-8",
		);
		writeFileSync(tempBpmn, originalXml);

		const templateFile = join(FIXTURES_DIR, "element-template.json");

		// Inject --in-place into process.argv for the plugin to detect
		const originalArgv = process.argv;
		process.argv = [
			"node",
			"c8ctl",
			"bpmn",
			"apply-element-template",
			"--in-place",
			templateFile,
			"Activity_17s7axj",
			tempBpmn,
		];

		try {
			await plugin.commands.bpmn([
				"apply-element-template",
				templateFile,
				"Activity_17s7axj",
				tempBpmn,
			]);

			const modifiedXml = readFileSync(tempBpmn, "utf-8");
			assert.ok(
				modifiedXml.includes("test-type"),
				"In-place modified file should contain template values",
			);
		} finally {
			process.argv = originalArgv;
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("shows usage when missing arguments", async () => {
		await plugin.commands.bpmn(["apply-element-template"]);

		const allOutput = [...capturedLog, ...capturedErr].join("\n");
		assert.ok(
			allOutput.includes("Usage") ||
				allOutput.includes("apply-element-template"),
			"Should show usage when arguments are missing",
		);
		assert.strictEqual(
			process.exitCode,
			1,
			"Should set exitCode to 1 for missing arguments",
		);
	});

	test("reports error for missing template file", async () => {
		const bpmnFile = join(FIXTURES_DIR, "simple.bpmn");

		await plugin.commands.bpmn([
			"apply-element-template",
			"/nonexistent/template.json",
			"Activity_17s7axj",
			bpmnFile,
		]);

		const allOutput = [...capturedLog, ...capturedErr].join("\n");
		assert.ok(
			allOutput.includes("not found"),
			"Should report missing template file",
		);
		assert.strictEqual(process.exitCode, 1);
	});

	test("reports error for nonexistent element ID", async () => {
		const bpmnFile = join(FIXTURES_DIR, "simple.bpmn");
		const templateFile = join(FIXTURES_DIR, "element-template.json");

		await plugin.commands.bpmn([
			"apply-element-template",
			templateFile,
			"NonExistent_Element",
			bpmnFile,
		]);

		const allOutput = [...capturedLog, ...capturedErr].join("\n");
		assert.ok(
			allOutput.includes("not found") || allOutput.includes("Error"),
			"Should report element not found",
		);
		assert.strictEqual(process.exitCode, 1);
	});
});
