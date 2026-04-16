/**
 * Integration tests for output mode switching
 * Tests that --output json / --output text produce the expected format via CLI
 */

import assert from "node:assert";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { createClient } from "../../src/client.ts";
import { pollUntil } from "../utils/polling.ts";
import { asyncSpawn } from "../utils/spawn.ts";

const PROJECT_ROOT = resolve(import.meta.dirname, "..", "..");
const CLI = join(PROJECT_ROOT, "src", "index.ts");

function cli(dataDir: string, ...args: string[]) {
	return asyncSpawn("node", ["--experimental-strip-types", CLI, ...args], {
		cwd: PROJECT_ROOT,
		env: { ...process.env, C8CTL_DATA_DIR: dataDir } as NodeJS.ProcessEnv,
	});
}

describe("Output Mode Integration Tests", () => {
	let testDir: string;
	let originalEnv: NodeJS.ProcessEnv;

	beforeEach(async () => {
		testDir = join(tmpdir(), `c8ctl-output-mode-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
		originalEnv = { ...process.env };
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
		process.env = originalEnv;
	});

	test("output mode changes are reflected in list process instances", async () => {
		// Deploy the test process and create an instance
		await cli(testDir, "deploy", "tests/fixtures/list-pis/min-usertask.bpmn");

		const client = createClient();
		await client.createProcessInstance({
			processDefinitionId: "Process_0t60ay7",
		});

		// Set JSON output mode for indexing poll
		await cli(testDir, "output", "json");

		// Wait for indexing
		const instanceFound = await pollUntil(
			async () => {
				const result = await cli(
					testDir,
					"list",
					"pi",
					"--id",
					"Process_0t60ay7",
					"--all",
				);
				return result.status === 0 && result.stdout.trim().length > 2;
			},
			10000,
			200,
		);
		assert.ok(
			instanceFound,
			"Process instance should be indexed within 10 seconds",
		);

		// Test 1: JSON mode produces valid JSON
		await cli(testDir, "output", "json");
		const jsonResult = await cli(
			testDir,
			"list",
			"pi",
			"--id",
			"Process_0t60ay7",
			"--all",
		);
		assert.strictEqual(
			jsonResult.status,
			0,
			`JSON mode should succeed. stderr: ${jsonResult.stderr}`,
		);
		const jsonOutput = jsonResult.stdout.trim();
		assert.ok(jsonOutput.length > 0, "Should have output");

		let foundValidJson = false;
		try {
			JSON.parse(jsonOutput);
			foundValidJson = true;
		} catch {
			// not valid JSON
		}
		assert.ok(foundValidJson, `Should produce valid JSON. Got: ${jsonOutput}`);

		// Test 2: text mode produces table output
		await cli(testDir, "output", "text");
		const textResult = await cli(
			testDir,
			"list",
			"pi",
			"--id",
			"Process_0t60ay7",
			"--all",
		);
		assert.strictEqual(
			textResult.status,
			0,
			`Text mode should succeed. stderr: ${textResult.stderr}`,
		);
		const textOutput = textResult.stdout.trim();
		assert.ok(textOutput.length > 0, "Should have output");

		const hasTableFormat =
			textOutput.includes("|") || textOutput.includes("---");
		assert.ok(
			hasTableFormat,
			`Output should be text table format. Got: ${textOutput}`,
		);
	});
});
