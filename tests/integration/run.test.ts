/**
 * Integration tests for run command
 * NOTE: These tests require a running Camunda 8 instance at http://localhost:8080
 */

import assert from "node:assert";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, test } from "node:test";
import { createClient } from "../../src/client.ts";
import { getUserDataDir } from "../../src/config.ts";
import { c8 } from "../utils/cli.ts";

// Wait time for Elasticsearch to index data before search queries
const ELASTICSEARCH_CONSISTENCY_WAIT_MS = 5000;

describe("Run Command Integration Tests (requires Camunda 8 at localhost:8080)", () => {
	beforeEach(() => {
		// Clear session state before each test to ensure clean tenant resolution
		const sessionPath = join(getUserDataDir(), "session.json");
		if (existsSync(sessionPath)) {
			unlinkSync(sessionPath);
		}
	});

	test("run deploys and creates process instance", async () => {
		// Run deploys and starts a process instance in one step.
		// Per AGENTS.md, exercise the CLI subprocess rather than the
		// internal handler — this keeps the test resilient to the
		// command-framework refactors planned in #288.
		const runResult = await c8("run", "tests/fixtures/simple.bpmn");
		assert.strictEqual(
			runResult.status,
			0,
			`run failed: stderr=${runResult.stderr} stdout=${runResult.stdout}`,
		);

		// Verify instance was created by searching for running instances of simple-process
		// Wait for Elasticsearch to index the data
		const client = createClient();
		const search = await client.searchProcessInstances(
			{
				filter: {
					processDefinitionId: "simple-process",
				},
			},
			{ consistency: { waitUpToMs: ELASTICSEARCH_CONSISTENCY_WAIT_MS } },
		);

		assert.ok(
			search.items && search.items.length > 0,
			"Process instance should exist",
		);
	});

	test("run extracts correct process ID from BPMN", async () => {
		// Run with a BPMN file and verify the correct process ID was used.
		// The simple.bpmn file has process id "simple-process".
		const runResult = await c8("run", "tests/fixtures/simple.bpmn");
		assert.strictEqual(
			runResult.status,
			0,
			`run failed: stderr=${runResult.stderr} stdout=${runResult.stdout}`,
		);

		// Verify we can find instances of the correct process
		// Wait for Elasticsearch to index the data
		const client = createClient();
		const search = await client.searchProcessInstances(
			{
				filter: {
					processDefinitionId: "simple-process",
				},
			},
			{ consistency: { waitUpToMs: ELASTICSEARCH_CONSISTENCY_WAIT_MS } },
		);

		// Should have at least one instance with the correct process ID
		assert.ok(
			search.items && search.items.length > 0,
			"Should find instances with extracted process ID",
		);
		assert.strictEqual(
			search.items[0].processDefinitionId,
			"simple-process",
			"Process ID should match BPMN definition",
		);
	});

	test("run passes variables to process instance", async () => {
		// Run with variables and verify they are passed.
		const testVariables = JSON.stringify({ testKey: "testValue", count: 42 });
		const result = await c8(
			"run",
			"tests/fixtures/simple.bpmn",
			"--variables",
			testVariables,
		);
		assert.strictEqual(
			result.status,
			0,
			`run failed: stderr=${result.stderr} stdout=${result.stdout}`,
		);
		// Note: Verifying variables would require additional API calls or a
		// process that outputs them.
	});
});
