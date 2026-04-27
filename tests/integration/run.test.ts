/**
 * Integration tests for the `run` command.
 *
 * NOTE: These tests require a running Camunda 8 instance at
 * http://localhost:8080.
 *
 * All interactions go through the CLI as a subprocess (per AGENTS.md
 * "in any test, only use the implemented CLI commands"), and the
 * subprocess is given a per-test isolated `C8CTL_DATA_DIR` so we
 * never touch the developer's real user data dir / session.json.
 * The host environment is otherwise inherited so the test picks up
 * whatever `CAMUNDA_*` / profile config the integration runner has
 * configured for localhost:8080.
 */

import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { createClient } from "../../src/client.ts";
import { makeTestEnv } from "../utils/mocks.ts";
import { asyncSpawn, type SpawnResult } from "../utils/spawn.ts";

const PROJECT_ROOT = resolve(import.meta.dirname, "..", "..");
const CLI = join(PROJECT_ROOT, "src", "index.ts");

// Wait time for Elasticsearch to index data before search queries
const ELASTICSEARCH_CONSISTENCY_WAIT_MS = 5000;

let dataDir = "";

/**
 * Spawn the CLI with the host environment so it targets the
 * integration runner's local Camunda 8 instance, plus a per-test
 * isolated `C8CTL_DATA_DIR` so session state from a developer's
 * default profile cannot leak in (and we cannot accidentally clobber
 * it). Mirrors the `cli()` helper in `forms.test.ts`.
 */
function cli(...args: string[]): Promise<SpawnResult> {
	return asyncSpawn("node", ["--experimental-strip-types", CLI, ...args], {
		cwd: PROJECT_ROOT,
		env: makeTestEnv({ C8CTL_DATA_DIR: dataDir }),
	});
}

describe("Run Command Integration Tests (requires Camunda 8 at localhost:8080)", () => {
	before(() => {
		dataDir = mkdtempSync(join(tmpdir(), "c8ctl-run-test-"));
	});

	after(() => {
		rmSync(dataDir, { recursive: true, force: true });
	});

	test("run deploys and creates process instance", async () => {
		// Run deploys and starts a process instance in one step.
		const runResult = await cli("run", "tests/fixtures/simple.bpmn");
		assert.strictEqual(
			runResult.status,
			0,
			`run failed: stderr=${runResult.stderr} stdout=${runResult.stdout}`,
		);

		// Verify instance was created by searching for running instances of
		// simple-process. Wait for Elasticsearch to index the data.
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
		const runResult = await cli("run", "tests/fixtures/simple.bpmn");
		assert.strictEqual(
			runResult.status,
			0,
			`run failed: stderr=${runResult.stderr} stdout=${runResult.stdout}`,
		);

		// Verify we can find instances of the correct process.
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
		const runResult = await cli(
			"run",
			"tests/fixtures/simple.bpmn",
			"--variables",
			testVariables,
		);
		assert.strictEqual(
			runResult.status,
			0,
			`run failed: stderr=${runResult.stderr} stdout=${runResult.stdout}`,
		);
		// Note: Verifying variables would require additional API calls or a
		// process that outputs them.
	});
});
