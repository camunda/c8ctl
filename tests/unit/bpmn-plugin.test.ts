/**
 * Behavioural tests for the bpmn commands (src/commands/bpmn.ts)
 *
 * Uses the c8() subprocess helper so every test exercises the full
 * dispatch path: parseArgs → registry → dispatch → defineCommand handler.
 */

import assert from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, test } from "node:test";
import { c8 } from "../utils/cli.ts";
import { asyncSpawn } from "../utils/spawn.ts";

const FIXTURES_DIR = resolve(import.meta.dirname, "..", "fixtures");
const CLI = "src/index.ts";

/**
 * Invoke the CLI in text mode so we can assert on human-readable output.
 */
async function c8text(...args: string[]) {
	const dataDir = mkdtempSync(join(tmpdir(), "c8ctl-bpmn-test-"));
	writeFileSync(
		join(dataDir, "session.json"),
		JSON.stringify({ outputMode: "text" }),
	);
	try {
		return await asyncSpawn(
			"node",
			["--experimental-strip-types", CLI, ...args],
			{
				env: {
					...process.env,
					CAMUNDA_BASE_URL: "http://test-cluster/v2",
					HOME: "/tmp/c8ctl-test-nonexistent-home",
					C8CTL_DATA_DIR: dataDir,
				},
			},
		);
	} finally {
		rmSync(dataDir, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// bpmn verb – resource validation
// ---------------------------------------------------------------------------

describe("CLI behavioural: bpmn verb", () => {
	test("bpmn with no resource shows available resources", async () => {
		const result = await c8text("bpmn");
		assert.strictEqual(result.status, 1, `stdout: ${result.stdout}`);
		const output = result.stdout + result.stderr;
		assert.ok(
			output.includes("lint"),
			"Should list lint as available resource",
		);
		assert.ok(
			output.includes("apply-element-template"),
			"Should list apply-element-template as available resource",
		);
	});
});

// ---------------------------------------------------------------------------
// bpmn lint
// ---------------------------------------------------------------------------

describe("CLI behavioural: bpmn lint", () => {
	test("lint clean file exits 0 with no output", async () => {
		const file = join(FIXTURES_DIR, "simple.bpmn");
		const result = await c8text("bpmn", "lint", file);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
	});

	test("lint file with issues exits 1 and reports errors", async () => {
		const file = join(FIXTURES_DIR, "simple-will-create-incident.bpmn");
		const result = await c8text("bpmn", "lint", file);
		assert.strictEqual(result.status, 1, "Should exit 1 on lint errors");
		const output = result.stdout + result.stderr;
		assert.ok(
			output.includes("label-required"),
			"Should report label-required rule",
		);
		assert.ok(/\d+ problem/.test(output), "Should show problem count summary");
	});

	test("lint file with issues in JSON mode outputs structured result", async () => {
		const file = join(FIXTURES_DIR, "simple-will-create-incident.bpmn");
		const result = await c8("bpmn", "lint", file);
		assert.strictEqual(result.status, 1, "Should exit 1 on lint errors");
		// JSON mode outputs structured data to stdout
		const parsed = JSON.parse(result.stdout);
		assert.ok(Array.isArray(parsed.issues), "Should have issues array");
		assert.ok(parsed.errorCount > 0, "Should have errors");
	});

	test("lint missing file exits 1 with error message", async () => {
		const result = await c8text("bpmn", "lint", "/nonexistent/file.bpmn");
		assert.strictEqual(result.status, 1);
		const output = result.stdout + result.stderr;
		assert.ok(
			output.includes("File not found") ||
				output.includes("Failed to bpmn lint"),
			"Should report file not found",
		);
	});

	test("lint with no file and TTY exits 1 with usage hint", async () => {
		const result = await c8text("bpmn", "lint");
		assert.strictEqual(result.status, 1);
		const output = result.stdout + result.stderr;
		assert.ok(
			output.includes("No BPMN input") ||
				output.includes("Failed to bpmn lint"),
			"Should report missing input",
		);
	});

	test("lint invalid XML exits 1", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "c8ctl-bpmn-test-"));
		const tempFile = join(tempDir, "invalid.bpmn");
		writeFileSync(tempFile, "<not-valid-bpmn>broken</not-valid-bpmn>");
		try {
			const result = await c8text("bpmn", "lint", tempFile);
			assert.strictEqual(result.status, 1, "Should exit 1 for invalid XML");
			const output = result.stdout + result.stderr;
			assert.ok(
				output.includes("parse") || output.includes("Failed"),
				"Should report parse error",
			);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// bpmn apply-element-template
// ---------------------------------------------------------------------------

describe("CLI behavioural: bpmn apply-element-template", () => {
	test("applies template and outputs modified BPMN to stdout", async () => {
		const bpmnFile = join(FIXTURES_DIR, "simple.bpmn");
		const templateFile = join(FIXTURES_DIR, "element-template.json");
		const result = await c8text(
			"bpmn",
			"apply-element-template",
			templateFile,
			"Activity_17s7axj",
			bpmnFile,
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assert.ok(result.stdout.includes("<?xml"), "Should output valid XML");
		assert.ok(
			result.stdout.includes("test-type"),
			"Should include the template's task type value",
		);
	});

	test("applies template in-place", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "c8ctl-bpmn-test-"));
		const tempBpmn = join(tempDir, "test.bpmn");
		writeFileSync(
			tempBpmn,
			readFileSync(join(FIXTURES_DIR, "simple.bpmn"), "utf-8"),
		);
		const templateFile = join(FIXTURES_DIR, "element-template.json");
		try {
			const result = await c8text(
				"bpmn",
				"apply-element-template",
				"--in-place",
				templateFile,
				"Activity_17s7axj",
				tempBpmn,
			);
			assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
			const modified = readFileSync(tempBpmn, "utf-8");
			assert.ok(
				modified.includes("test-type"),
				"In-place file should contain template values",
			);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("missing template file exits 1", async () => {
		const bpmnFile = join(FIXTURES_DIR, "simple.bpmn");
		const result = await c8text(
			"bpmn",
			"apply-element-template",
			"/nonexistent/template.json",
			"Activity_17s7axj",
			bpmnFile,
		);
		assert.strictEqual(result.status, 1);
		const output = result.stdout + result.stderr;
		assert.ok(
			output.includes("not found") || output.includes("Failed"),
			"Should report missing template",
		);
	});

	test("nonexistent element ID exits 1", async () => {
		const bpmnFile = join(FIXTURES_DIR, "simple.bpmn");
		const templateFile = join(FIXTURES_DIR, "element-template.json");
		const result = await c8text(
			"bpmn",
			"apply-element-template",
			templateFile,
			"NonExistent_Element",
			bpmnFile,
		);
		assert.strictEqual(result.status, 1);
		const output = result.stdout + result.stderr;
		assert.ok(
			output.includes("not found") || output.includes("Error"),
			"Should report element not found",
		);
	});

	test("apply-template alias resolves to apply-element-template", async () => {
		const bpmnFile = join(FIXTURES_DIR, "simple.bpmn");
		const templateFile = join(FIXTURES_DIR, "element-template.json");
		const result = await c8text(
			"bpmn",
			"apply-template",
			templateFile,
			"Activity_17s7axj",
			bpmnFile,
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assert.ok(
			result.stdout.includes("<?xml"),
			"Alias should resolve and produce XML output",
		);
	});
});

// ---------------------------------------------------------------------------
// bpmn help
// ---------------------------------------------------------------------------

describe("CLI behavioural: bpmn help", () => {
	test("help bpmn shows lint and apply-element-template", async () => {
		const result = await c8text("help", "bpmn");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const output = result.stdout + result.stderr;
		assert.ok(output.includes("lint"), "Should mention lint");
		assert.ok(
			output.includes("apply-element-template"),
			"Should mention apply-element-template",
		);
	});
});
