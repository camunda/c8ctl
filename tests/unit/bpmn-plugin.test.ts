/**
 * Behavioural tests for the bpmn commands (src/commands/bpmn.ts)
 */

import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, test } from "node:test";
import { c8 } from "../utils/cli.ts";
import { asyncSpawn } from "../utils/spawn.ts";

const FIXTURES_DIR = resolve(import.meta.dirname, "..", "fixtures");
const CLI = "src/index.ts";

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
	test("bpmn with no subcommand shows usage", async () => {
		const result = await c8text("bpmn");
		const output = result.stdout + result.stderr;
		assert.ok(
			output.includes("lint"),
			"Should list lint as available subcommand",
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
