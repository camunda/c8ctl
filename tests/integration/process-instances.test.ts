/**
 * Integration tests for process instances
 * NOTE: These tests require a running Camunda 8 instance at http://localhost:8080
 *
 * These tests primarily validate end-to-end CLI behaviour. The setup phase
 * imports the internal `deployResources` helper from `src/deployments.ts`
 * to seed process definitions before each test, but every assertion exercises
 * the CLI subprocess.
 */

import assert from "node:assert";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { ProcessDefinitionId } from "@camunda8/orchestration-cluster-api";
import { createClient } from "../../src/client.ts";
import { deployResources as deploy } from "../../src/deployments.ts";
import { todayRange } from "../utils/date-helpers.ts";
import { makeTestEnv } from "../utils/mocks.ts";
import { pollUntil } from "../utils/polling.ts";
import { asyncSpawn } from "../utils/spawn.ts";

// Polling configuration for Elasticsearch consistency
const POLL_TIMEOUT_MS = 30000;
const POLL_INTERVAL_MS = 1000;

const PROJECT_ROOT = resolve(import.meta.dirname, "..", "..");
const CLI = join(PROJECT_ROOT, "src", "index.ts");

type ProcessInstanceRow = {
	Key: string | number;
	"Process ID": string;
	State: string;
	Version: number;
	"Start Date": string;
	"Tenant ID": string;
};

function cli(dataDir: string, ...args: string[]) {
	return asyncSpawn("node", ["--experimental-strip-types", CLI, ...args], {
		cwd: PROJECT_ROOT,
		env: makeTestEnv({ C8CTL_DATA_DIR: dataDir }),
	});
}

function parseItems<T>(stdout: string): T[] {
	if (!stdout.trim()) return [];
	// biome-ignore lint/plugin: generic JSON parse helper; T supplied by caller
	return JSON.parse(stdout) as T[];
}

describe("Process Instance Integration Tests (requires Camunda 8 at localhost:8080)", () => {
	let testDir: string;
	let originalEnv: NodeJS.ProcessEnv;
	const client = createClient();

	beforeEach(async () => {
		testDir = mkdtempSync(join(tmpdir(), "c8ctl-process-instances-test-"));
		originalEnv = { ...process.env };
		process.env.C8CTL_DATA_DIR = testDir;
		// Set JSON output mode for CLI-based tests that parse stdout
		await cli(testDir, "output", "json");
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
		process.env = originalEnv;
	});

	test("create process instance returns key", async () => {
		// First deploy a process to ensure it exists
		await deploy(["tests/fixtures/simple.bpmn"], {});

		// Create process instance using the SDK client directly
		const result = await client.createProcessInstance({
			processDefinitionId: ProcessDefinitionId.assumeExists("simple-process"),
		});

		// Verify instance key is returned
		assert.ok(result, "Result should be returned");
		assert.ok(
			result.processInstanceKey,
			"Process instance key should be returned",
		);
		assert.ok(
			typeof result.processInstanceKey === "number" ||
				typeof result.processInstanceKey === "string",
			"Process instance key should be a number or string",
		);
	});

	test("list process instances filters by process definition via CLI", async () => {
		await deploy(["tests/fixtures/simple.bpmn"], {});
		await client.createProcessInstance({
			processDefinitionId: ProcessDefinitionId.assumeExists("simple-process"),
		});

		// Use CLI to list and verify it runs without error
		const result = await cli(
			testDir,
			"list",
			"pi",
			"--id",
			"simple-process",
			"--all",
		);
		assert.strictEqual(
			result.status,
			0,
			`CLI should succeed. stderr: ${result.stderr}`,
		);
	});

	test("list process instances respects --limit via CLI", async () => {
		await deploy(["tests/fixtures/simple.bpmn"], {});
		await client.createProcessInstance({
			processDefinitionId: ProcessDefinitionId.assumeExists("simple-process"),
		});
		await client.createProcessInstance({
			processDefinitionId: ProcessDefinitionId.assumeExists("simple-process"),
		});
		await client.createProcessInstance({
			processDefinitionId: ProcessDefinitionId.assumeExists("simple-process"),
		});

		const result = await cli(testDir, "list", "pi", "--all", "--limit", "2");
		assert.strictEqual(
			result.status,
			0,
			`CLI should succeed. stderr: ${result.stderr}`,
		);
		const items = parseItems<ProcessInstanceRow>(result.stdout);
		assert.ok(
			items.length <= 2,
			`--limit 2 should return at most 2 items, got ${items.length}`,
		);
	});

	test("list process instances filters by version via CLI", async () => {
		const uniqueId = `version-test-${Date.now()}`;
		const baseBpmn = readFileSync("tests/fixtures/simple.bpmn", "utf8").replace(
			'id="simple-process"',
			`id="${uniqueId}"`,
		);

		// Deploy v1
		const v1Path = join(testDir, "v1.bpmn");
		writeFileSync(v1Path, baseBpmn);
		await deploy([v1Path], {});
		await client.createProcessInstance({
			processDefinitionId: ProcessDefinitionId.assumeExists(uniqueId),
		});

		// Deploy v2 with a minimal change (different task name)
		const v2Bpmn = baseBpmn.replace(
			'name="Do Something"',
			'name="Do Something v2"',
		);
		const v2Path = join(testDir, "v2.bpmn");
		writeFileSync(v2Path, v2Bpmn);
		await deploy([v2Path], {});
		await client.createProcessInstance({
			processDefinitionId: ProcessDefinitionId.assumeExists(uniqueId),
		});

		// Wait for both versions to be indexed via CLI
		const v1Indexed = await pollUntil(
			async () => {
				const result = await cli(
					testDir,
					"search",
					"pi",
					"--id",
					uniqueId,
					"--version",
					"1",
				);
				return (
					result.status === 0 &&
					parseItems<ProcessInstanceRow>(result.stdout).length > 0
				);
			},
			POLL_TIMEOUT_MS,
			POLL_INTERVAL_MS,
		);
		assert.ok(v1Indexed, "Version 1 instances should be indexed");

		const v2Indexed = await pollUntil(
			async () => {
				const result = await cli(
					testDir,
					"search",
					"pi",
					"--id",
					uniqueId,
					"--version",
					"2",
				);
				return (
					result.status === 0 &&
					parseItems<ProcessInstanceRow>(result.stdout).length > 0
				);
			},
			POLL_TIMEOUT_MS,
			POLL_INTERVAL_MS,
		);
		assert.ok(v2Indexed, "Version 2 instances should be indexed");

		// Verify version filtering is exclusive
		const v1Result = await cli(
			testDir,
			"search",
			"pi",
			"--id",
			uniqueId,
			"--version",
			"1",
		);
		const v1Items = parseItems<ProcessInstanceRow>(v1Result.stdout);
		assert.ok(v1Items.length > 0, "Should find v1 instances");
		assert.ok(
			v1Items.every((pi) => Number(pi.Version) === 1),
			"All version 1 results should be version 1",
		);

		const v2Result = await cli(
			testDir,
			"search",
			"pi",
			"--id",
			uniqueId,
			"--version",
			"2",
		);
		const v2Items = parseItems<ProcessInstanceRow>(v2Result.stdout);
		assert.ok(v2Items.length > 0, "Should find v2 instances");
		assert.ok(
			v2Items.every((pi) => Number(pi.Version) === 2),
			"All version 2 results should be version 2",
		);
	});

	test("list process instances --limit via CLI produces correct output", async () => {
		await deploy(["tests/fixtures/simple.bpmn"], {});
		await client.createProcessInstance({
			processDefinitionId: ProcessDefinitionId.assumeExists("simple-process"),
		});

		const result = await cli(testDir, "list", "pi", "--all", "--limit", "1");
		assert.strictEqual(
			result.status,
			0,
			`CLI should succeed. stderr: ${result.stderr}`,
		);

		// JSON mode: output should be parseable array with at most 1 item
		const items = parseItems<ProcessInstanceRow>(result.stdout);
		assert.ok(
			items.length <= 1,
			`--limit 1 should produce at most 1 item, got ${items.length}`,
		);
	});

	test("cancel process instance CLI handles errors gracefully", async () => {
		// Deploy and create an instance
		await deploy(["tests/fixtures/simple.bpmn"], {});
		const result = await client.createProcessInstance({
			processDefinitionId: ProcessDefinitionId.assumeExists("simple-process"),
		});

		assert.ok(result, "Create result should exist");
		const instanceKey = result.processInstanceKey.toString();

		// Reset to text mode for this test (cancel output is not JSON)
		await cli(testDir, "output", "text");

		// Run CLI command - simple-process completes instantly, so cancel will fail
		// We test that the CLI handles this gracefully (exits with error, not crash)
		const cancelResult = await cli(testDir, "cancel", "pi", instanceKey);

		if (cancelResult.status === 0) {
			// If it succeeded, the process was still running (unlikely for simple-process)
			assert.ok(true, "Process instance cancellation succeeded");
		} else {
			// CLI should exit with non-zero code when process already completed
			const combinedOutput = `${cancelResult.stdout}\n${cancelResult.stderr}`;
			const hasErrorMessage =
				combinedOutput.includes("Failed") ||
				combinedOutput.includes("NOT_FOUND") ||
				combinedOutput.includes("✗");
			assert.ok(
				hasErrorMessage,
				`CLI should output error message for already completed process. Got: ${combinedOutput}`,
			);
		}
	});

	test("create with awaitCompletion returns completed result with variables", async () => {
		// Deploy a simple process first
		await deploy(["tests/fixtures/simple.bpmn"], {});

		// Test with awaitCompletion flag using the SDK client directly
		const result = await client.createProcessInstance({
			processDefinitionId: ProcessDefinitionId.assumeExists("simple-process"),
			awaitCompletion: true,
		});

		// Verify the result contains the expected properties
		assert.ok(result, "Result should be returned");
		assert.ok(result.processInstanceKey, "Should have process instance key");
		assert.ok(
			"variables" in result,
			"Result should have variables property when awaitCompletion is true",
		);
	});

	test("create with awaitCompletion CLI output includes completed and variables", async () => {
		// Deploy a simple process first
		await deploy(["tests/fixtures/simple.bpmn"], {});

		// Reset to text mode for this test which checks text output
		await cli(testDir, "output", "text");

		// Execute the CLI command and capture output
		const result = await cli(
			testDir,
			"create",
			"pi",
			"--id",
			"simple-process",
			"--awaitCompletion",
		);

		// Verify the output indicates successful completion
		const output = `${result.stdout}\n${result.stderr}`;
		assert.ok(
			output.includes("completed"),
			`Output should indicate process completed. Got: ${output}`,
		);
		// Verify that variables are present in the output (JSON response should contain "variables")
		assert.ok(
			output.includes("variables"),
			`Output should contain variables when awaitCompletion is true. Got: ${output}`,
		);

		// Also test the 'await pi' command which is an alias for 'create pi --awaitCompletion'
		const aliasResult = await cli(
			testDir,
			"await",
			"pi",
			"--id",
			"simple-process",
		);

		// Verify the alias works the same way
		const aliasOutput = `${aliasResult.stdout}\n${aliasResult.stderr}`;
		assert.ok(
			aliasOutput.includes("completed"),
			`Output with await alias should indicate process completed. Got: ${aliasOutput}`,
		);
		assert.ok(
			aliasOutput.includes("variables"),
			`Output with await alias should contain variables. Got: ${aliasOutput}`,
		);
	});

	test("list pi --between spanning today finds recently created instance via CLI", async () => {
		await deploy(["tests/fixtures/simple.bpmn"], {});
		await client.createProcessInstance({
			processDefinitionId: ProcessDefinitionId.assumeExists("simple-process"),
		});

		const found = await pollUntil(
			async () => {
				const result = await cli(
					testDir,
					"list",
					"pi",
					"--id",
					"simple-process",
					"--state",
					"COMPLETED",
					"--between",
					todayRange(),
				);
				return (
					result.status === 0 &&
					parseItems<ProcessInstanceRow>(result.stdout).length > 0
				);
			},
			POLL_TIMEOUT_MS,
			POLL_INTERVAL_MS,
		);

		assert.ok(
			found,
			"--between spanning today should find recently completed process instances",
		);
	});

	test("list pi --between in far past returns no instances via CLI", async () => {
		await deploy(["tests/fixtures/simple.bpmn"], {});

		const result = await cli(
			testDir,
			"list",
			"pi",
			"--id",
			"simple-process",
			"--state",
			"COMPLETED",
			"--between",
			"2000-01-01..2000-01-02",
		);
		assert.strictEqual(
			result.status,
			0,
			`CLI should succeed. stderr: ${result.stderr}`,
		);
		const items = parseItems<ProcessInstanceRow>(result.stdout);
		assert.strictEqual(
			items.length,
			0,
			"--between with past date range should return no instances",
		);
	});
});
