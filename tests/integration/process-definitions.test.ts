/**
 * Integration tests for process definitions
 * NOTE: These tests require a running Camunda 8 instance at http://localhost:8080
 */

import assert from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { makeTestEnv } from "../utils/mocks.ts";
import { pollUntil } from "../utils/polling.ts";
import { asyncSpawn } from "../utils/spawn.ts";

// Wait time for Elasticsearch to index data before search queries
const ELASTICSEARCH_CONSISTENCY_WAIT_MS = 8000;
const PROJECT_ROOT = resolve(import.meta.dirname, "..", "..");
const CLI = join(PROJECT_ROOT, "src", "index.ts");
const POLL_TIMEOUT_MS = ELASTICSEARCH_CONSISTENCY_WAIT_MS + 10_000;
const POLL_INTERVAL_MS = 2_000;

const camundaVersion = process.env.CAMUNDA_VERSION;
const pdSuspendResumeSkip =
	camundaVersion?.startsWith("8.8") === true ||
	camundaVersion?.startsWith("8.9") === true ||
	camundaVersion?.startsWith("8.10") === true
		? `Process definition suspend/resume requires Camunda 8.11+ (CAMUNDA_VERSION=${camundaVersion})`
		: false;

let dataDir = "";

type ProcessDefinition = {
	Key: string | number;
	"Process ID": string;
	Version?: number;
};

type RawProcessDefinition = {
	processDefinitionKey: string | number;
	processDefinitionId: string;
	version?: number;
};

function cli(...args: string[]) {
	return asyncSpawn("node", ["--experimental-strip-types", CLI, ...args], {
		cwd: PROJECT_ROOT,
		env: makeTestEnv({ C8CTL_DATA_DIR: dataDir }),
	});
}

function parseJsonOutput<T>(output: string): T {
	try {
		// biome-ignore lint/plugin: generic JSON parse helper; T supplied by caller
		return JSON.parse(output) as T;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		assert.fail(`Expected valid JSON output (${message}), got:\n${output}`);
	}
}

async function deployAndGetProcessDefinitionKey() {
	const deployResult = await cli("deploy", "tests/fixtures/simple.bpmn");
	assert.strictEqual(
		deployResult.status,
		0,
		`Deploy should exit 0. stderr: ${deployResult.stderr}`,
	);

	const outputResult = await cli("output", "json");
	assert.strictEqual(
		outputResult.status,
		0,
		`Setting output mode should exit 0. stderr: ${outputResult.stderr}`,
	);

	let latestItems: ProcessDefinition[] = [];
	await pollUntil(
		async () => {
			const searchResult = await cli("search", "pd", "--id=simple-process");
			if (searchResult.status !== 0) return false;
			try {
				latestItems = parseJsonOutput<ProcessDefinition[]>(searchResult.stdout);
				return latestItems.length > 0;
			} catch {
				return false;
			}
		},
		POLL_TIMEOUT_MS,
		POLL_INTERVAL_MS,
	);

	assert.ok(
		latestItems.length > 0,
		"Should have at least one process definition",
	);
	return String(latestItems[0].Key);
}

describe("Process Definition Integration Tests (requires Camunda 8 at localhost:8080)", () => {
	before(() => {
		dataDir = mkdtempSync(join(tmpdir(), "c8ctl-pd-test-"));
	});

	beforeEach(() => {
		rmSync(join(dataDir, "session.json"), { force: true });
	});

	after(() => {
		rmSync(dataDir, { recursive: true, force: true });
	});

	test("list process definitions returns deployed processes", async () => {
		const processDefinitionKey = await deployAndGetProcessDefinitionKey();

		const searchResult = await cli("search", "pd", "--id=simple-process");
		assert.strictEqual(
			searchResult.status,
			0,
			`Search should exit 0. stderr: ${searchResult.stderr}`,
		);
		const items = parseJsonOutput<ProcessDefinition[]>(searchResult.stdout);
		const firstItem = items.find(
			(item) => String(item.Key) === processDefinitionKey,
		);
		assert.ok(
			firstItem,
			`Expected to find process definition ${processDefinitionKey}`,
		);

		assert.ok(firstItem.Key, "Process definition should have a key");
		assert.ok(firstItem["Process ID"], "Process definition should have an ID");
		assert.ok(
			firstItem.Version !== undefined,
			"Process definition should have a version",
		);
	});

	test("get process definition by key returns definition details", async () => {
		const processDefinitionKey = await deployAndGetProcessDefinitionKey();

		const getResult = await cli("get", "pd", processDefinitionKey);
		assert.strictEqual(
			getResult.status,
			0,
			`Get should exit 0. stderr: ${getResult.stderr}`,
		);
		const definition = parseJsonOutput<RawProcessDefinition>(getResult.stdout);

		assert.ok(definition, "Process definition should be returned");
		assert.strictEqual(
			String(definition.processDefinitionKey),
			processDefinitionKey,
			"Keys should match",
		);
		assert.strictEqual(
			definition.processDefinitionId,
			"simple-process",
			"IDs should match",
		);
	});

	test("get process definition XML returns BPMN content", async () => {
		const processDefinitionKey = await deployAndGetProcessDefinitionKey();

		const getXmlResult = await cli("get", "pd", processDefinitionKey, "--xml");
		assert.strictEqual(
			getXmlResult.status,
			0,
			`Get XML should exit 0. stderr: ${getXmlResult.stderr}`,
		);

		assert.ok(getXmlResult.stdout, "XML should be returned");
		assert.ok(
			typeof getXmlResult.stdout === "string",
			"XML should be a string",
		);
		assert.ok(
			getXmlResult.stdout.includes("bpmn:"),
			"XML should contain BPMN namespace",
		);
		assert.ok(
			getXmlResult.stdout.includes("simple-process"),
			"XML should contain the process ID",
		);
	});
});

type SuspensionRow = {
	processDefinitionKey: string | number;
	version: number;
	outcome: string;
	batchOperationKey: string | number | null;
};

describe("suspend/resume process-definition", () => {
	const touchedProcessIds: string[] = [];

	before(async () => {
		dataDir = mkdtempSync(join(tmpdir(), "c8ctl-pd-suspend-test-"));
		const outputResult = await cli("output", "json");
		assert.strictEqual(outputResult.status, 0, outputResult.stderr);
	});

	after(async () => {
		// Resume everything we suspended so later tests see active definitions.
		for (const processId of touchedProcessIds) {
			const result = await cli(
				"resume",
				"pd",
				`--processDefinitionId=${processId}`,
			);
			assert.strictEqual(
				result.status,
				0,
				`Cleanup resume of ${processId} failed: ${result.stderr}`,
			);
		}
		rmSync(dataDir, { recursive: true, force: true });
	});

	/** Deploy a user-task process under a unique ID; each call with a new `revision` is a new version. */
	async function deployVersion({
		processId,
		revision,
	}: {
		processId: string;
		revision: number;
	}) {
		const template = readFileSync(
			join(PROJECT_ROOT, "tests/fixtures/simple-user-task.bpmn"),
			"utf8",
		);
		const xml = template
			.replaceAll("simple-user-task", processId)
			.replace(
				"<bpmn:process ",
				`<!-- revision ${revision} -->\n  <bpmn:process `,
			);
		const file = join(dataDir, `${processId}-${revision}.bpmn`);
		writeFileSync(file, xml);
		const result = await cli("deploy", file);
		assert.strictEqual(result.status, 0, `Deploy failed: ${result.stderr}`);
		if (!touchedProcessIds.includes(processId))
			touchedProcessIds.push(processId);
	}

	async function waitForVersionCount({
		processId,
		count,
	}: {
		processId: string;
		count: number;
	}) {
		let items: ProcessDefinition[] = [];
		const reached = await pollUntil(
			async () => {
				const result = await cli("search", "pd", `--id=${processId}`);
				if (result.status !== 0) return false;
				try {
					items = parseJsonOutput<ProcessDefinition[]>(result.stdout);
				} catch {
					return false;
				}
				return items.length >= count;
			},
			POLL_TIMEOUT_MS,
			POLL_INTERVAL_MS,
		);
		assert.ok(reached, `Expected ${count} versions of ${processId}`);
		return items;
	}

	async function runRows(...args: string[]) {
		const result = await cli(...args);
		assert.strictEqual(
			result.status,
			0,
			`${args.join(" ")} should exit 0. stderr: ${result.stderr}`,
		);
		return parseJsonOutput<SuspensionRow[]>(result.stdout);
	}

	test("suspend by key, repeat the suspend, then resume by key", {
		skip: pdSuspendResumeSkip,
	}, async () => {
		const processId = `pd-suspend-key-${Date.now()}`;
		await deployVersion({ processId, revision: 1 });
		const [definition] = await waitForVersionCount({ processId, count: 1 });
		const key = String(definition.Key);

		const suspended = await runRows("suspend", "pd", key);
		assert.strictEqual(suspended.length, 1);
		assert.strictEqual(String(suspended[0].processDefinitionKey), key);
		assert.strictEqual(suspended[0].outcome, "SUSPENDED");

		const repeated = await runRows("suspend", "pd", key);
		assert.strictEqual(repeated.length, 1);
		assert.strictEqual(repeated[0].outcome, "ALREADY_SUSPENDED");

		const resumed = await runRows("resume", "pd", key);
		assert.strictEqual(resumed.length, 1);
		assert.strictEqual(resumed[0].outcome, "RESUMED");
	});

	test("suspend by ID affects all versions without --version and one version with --version", {
		skip: pdSuspendResumeSkip,
	}, async () => {
		const processId = `pd-suspend-id-${Date.now()}`;
		await deployVersion({ processId, revision: 1 });
		await deployVersion({ processId, revision: 2 });
		await waitForVersionCount({ processId, count: 2 });

		const one = await runRows(
			"suspend",
			"pd",
			`--processDefinitionId=${processId}`,
			"--version=1",
		);
		assert.strictEqual(one.length, 1, "--version should affect a single row");
		assert.strictEqual(one[0].version, 1);
		assert.strictEqual(one[0].outcome, "SUSPENDED");

		const all = await runRows(
			"suspend",
			"pd",
			`--processDefinitionId=${processId}`,
		);
		assert.strictEqual(
			all.length,
			2,
			"no --version should affect every version",
		);
		const byVersion = new Map(all.map((row) => [row.version, row.outcome]));
		assert.strictEqual(byVersion.get(1), "ALREADY_SUSPENDED");
		assert.strictEqual(byVersion.get(2), "SUSPENDED");
	});

	test("suspend with includeProcessInstances returns a batch operation key", {
		skip: pdSuspendResumeSkip,
	}, async () => {
		const processId = `pd-suspend-batch-${Date.now()}`;
		await deployVersion({ processId, revision: 1 });
		const [definition] = await waitForVersionCount({ processId, count: 1 });
		const key = String(definition.Key);

		const created = await cli("create", "pi", `--id=${processId}`);
		assert.strictEqual(created.status, 0, created.stderr);

		const rows = await runRows(
			"suspend",
			"pd",
			key,
			"--includeProcessInstances",
		);
		assert.strictEqual(rows.length, 1);
		assert.match(
			String(rows[0].batchOperationKey),
			/^\d+$/,
			`Expected a numeric batch operation key, got ${rows[0].batchOperationKey}`,
		);

		const resumed = await runRows(
			"resume",
			"pd",
			key,
			"--includeProcessInstances",
		);
		assert.strictEqual(resumed.length, 1);
		assert.strictEqual(resumed[0].outcome, "RESUMED");
		assert.match(
			String(resumed[0].batchOperationKey),
			/^\d+$/,
			`Expected a numeric batch operation key on resume, got ${resumed[0].batchOperationKey}`,
		);
	});

	test("suspend and resume by ID plus version with includeProcessInstances return a batch operation key", {
		skip: pdSuspendResumeSkip,
	}, async () => {
		const processId = `pd-batch-id-${Date.now()}`;
		await deployVersion({ processId, revision: 1 });
		await waitForVersionCount({ processId, count: 1 });

		const created = await cli("create", "pi", `--id=${processId}`);
		assert.strictEqual(created.status, 0, created.stderr);

		const idArgs = [`--processDefinitionId=${processId}`, "--version=1"];
		const suspended = await runRows(
			"suspend",
			"pd",
			...idArgs,
			"--includeProcessInstances",
		);
		assert.strictEqual(suspended.length, 1);
		assert.match(String(suspended[0].batchOperationKey), /^\d+$/);

		const resumed = await runRows(
			"resume",
			"pd",
			...idArgs,
			"--includeProcessInstances",
		);
		assert.strictEqual(resumed.length, 1);
		assert.match(String(resumed[0].batchOperationKey), /^\d+$/);
	});

	test("resume by ID and by ID plus version", {
		skip: pdSuspendResumeSkip,
	}, async () => {
		const processId = `pd-resume-id-${Date.now()}`;
		await deployVersion({ processId, revision: 1 });
		await deployVersion({ processId, revision: 2 });
		await waitForVersionCount({ processId, count: 2 });

		await runRows("suspend", "pd", `--processDefinitionId=${processId}`);

		const one = await runRows(
			"resume",
			"pd",
			`--processDefinitionId=${processId}`,
			"--version=1",
		);
		assert.strictEqual(one.length, 1, "--version should affect a single row");
		assert.strictEqual(one[0].version, 1);
		assert.strictEqual(one[0].outcome, "RESUMED");

		const all = await runRows(
			"resume",
			"pd",
			`--processDefinitionId=${processId}`,
		);
		assert.strictEqual(all.length, 2);
		const byVersion = new Map(all.map((row) => [row.version, row.outcome]));
		assert.strictEqual(byVersion.get(1), "ALREADY_RESUMED");
		assert.strictEqual(byVersion.get(2), "RESUMED");
	});
});
