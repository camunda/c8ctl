/**
 * `deployResources` in camunda.json — `c8 watch --project`.
 *
 * Spec, "Watch and live updates": "c8ctl watch --project: watches the
 * resolved selection. Changes to selected files (create, modify, delete,
 * rename) trigger redeployment with the re-resolved set. A camunda.json
 * edit re-resolves the selection and redeploys if the set changed.
 * Invalid configuration or an empty selection surfaces an error; with
 * --force, watching continues."
 *
 * AC: "c8ctl: deploy --dry-run and watch --project reflect the selected
 * set; conflicting CLI selection flags produce actionable errors;
 * watch --force retains its error-continuation behavior."
 *
 * The watcher deploys to a local mock cluster on an ephemeral port, so
 * every assertion checks the file names actually submitted. Readiness
 * and progress are observed through output lines and recorded requests
 * (pollUntil); the deadlines are safety nets, not correctness signals.
 */

import assert from "node:assert";
import { spawnSync } from "node:child_process";
import {
	closeSync,
	mkdtempSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { isRecord } from "../../src/core/index.ts";
import {
	createProject,
	type MockCluster,
	startMockCluster,
	writeProjectFile,
} from "../utils/deploy-resources.ts";
import { pollUntil } from "../utils/polling.ts";
import {
	startWatchProcess,
	type WatchProcess,
} from "../utils/watch-process.ts";

const CLI_ENTRY = join(import.meta.dirname, "..", "..", "src", "index.ts");
const SAFETY_NET_MS = 15_000;
const POLL_MS = 50;

const BPMN = (id: string) =>
	`<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" id="d-${id}"><process id="${id}" isExecutable="true"/></definitions>`;

let tempDir: string;
let dataDir: string;
let mock: MockCluster;
let watcher: WatchProcess | undefined;

beforeEach(async () => {
	tempDir = mkdtempSync(join(tmpdir(), "c8ctl-watch-deploy-resources-"));
	dataDir = mkdtempSync(join(tmpdir(), "c8ctl-watch-deploy-resources-data-"));
	mock = await startMockCluster({ gatewayVersion: "8.8.0" });
});

afterEach(async () => {
	await watcher?.cleanup();
	watcher = undefined;
	await mock.close();
	rmSync(tempDir, { recursive: true, force: true });
	rmSync(dataDir, { recursive: true, force: true });
});

const descriptor = (deployResources: unknown) =>
	JSON.stringify({ deployResources });

/**
 * Rewrite camunda.json in place without truncating it first. A plain
 * truncate-and-write can be observed as an empty descriptor by the
 * watcher's debounced read on a loaded runner, and replacing the file by
 * rename loses the file's watch on Linux (Node 22). Every descriptor is
 * padded to the same size and written with one write at offset 0, so a
 * read sees either the old or the new descriptor and the inode is kept.
 */
const DESCRIPTOR_SIZE = 1024;
function writeDescriptor(root: string, content: string) {
	assert.ok(content.length <= DESCRIPTOR_SIZE, "descriptor too large");
	const fd = openSync(join(root, "camunda.json"), "r+");
	try {
		writeSync(fd, content.padEnd(DESCRIPTOR_SIZE, " "), 0);
	} finally {
		closeSync(fd);
	}
}

function makeProject(): string {
	return createProject(
		join(tempDir, "project"),
		{ deployResources: ["resources/**", "!resources/drafts/"] },
		{
			"resources/main.bpmn": BPMN("main"),
			"resources/prompt.md": "# prompt",
			"resources/drafts/wip.bpmn": BPMN("wip"),
			"README.md": "# readme",
		},
	);
}

async function startWatch(
	root: string,
	extraArgs: string[] = [],
	{ settled = true }: { settled?: boolean } = {},
) {
	watcher = startWatchProcess({
		watchDir: root,
		dataDir,
		extraArgs: ["--project", ...extraArgs],
		env: { CAMUNDA_BASE_URL: mock.baseUrl },
	});
	const w = watcher;
	const ready = await pollUntil(
		async () => w.getOutput().includes("Press Ctrl+C to stop watching"),
		SAFETY_NET_MS,
		POLL_MS,
	);
	assert.ok(ready, `watch did not start:\n${w.getOutput()}`);
	const baseline = settled ? await settle(w, root) : 0;
	return { w, baseline };
}

/** Output lines proving a descriptor edit was processed. */
const DESCRIPTOR_PROCESSED =
	/Change detected: [^\n]*camunda\.json|selected resources are unchanged/g;
const countMatches = (w: WatchProcess, pattern: RegExp) =>
	(w.getOutput().match(pattern) ?? []).length;

/**
 * Flush the file-system event stream. Some platforms (macOS FSEvents)
 * may deliver events for the project files created just before the
 * watcher started. We append an unmatched pattern to camunda.json (the
 * selected set is unchanged), wait until that edit is processed, then
 * wait for any deployment that window triggered to reach the mock.
 * Returns the deployment count to use as the test's baseline.
 */
async function settle(w: WatchProcess, root: string): Promise<number> {
	const file = join(root, "camunda.json");
	const parsed: unknown = JSON.parse(readFileSync(file, "utf-8"));
	assert.ok(isRecord(parsed) && Array.isArray(parsed.deployResources));
	const before = countMatches(w, DESCRIPTOR_PROCESSED);
	writeDescriptor(
		root,
		descriptor([...parsed.deployResources, `settle-${before}/**`]),
	);
	await waitUntil(() => countMatches(w, DESCRIPTOR_PROCESSED) > before, w);
	await waitUntil(
		() => mock.deployments.length >= countMatches(w, /Change detected/g),
		w,
	);
	return mock.deployments.length;
}

async function waitUntil(condition: () => boolean, w: WatchProcess) {
	const ok = await pollUntil(async () => condition(), SAFETY_NET_MS, POLL_MS);
	assert.ok(
		ok,
		`condition not met; deployments ${JSON.stringify(mock.deployments)}:\n${w.getOutput()}`,
	);
}

/** Wait until a deployment after `baseline` submitted exactly `expected`. */
async function waitForDeploymentOf(
	expected: string[],
	baseline: number,
	w: WatchProcess,
) {
	await waitUntil(
		() =>
			mock.deployments
				.slice(baseline)
				.some((names) => JSON.stringify(names) === JSON.stringify(expected)),
		w,
	);
}

async function waitForOutput(pattern: RegExp, w: WatchProcess) {
	await waitUntil(() => pattern.test(w.getOutput()), w);
}

describe('Spec: Watch and live updates — "c8ctl watch --project: watches the resolved selection"', () => {
	test('".c8ignore … do not apply" — a directory named .c8ignore does not prevent watching', async () => {
		const root = makeProject();
		writeProjectFile(root, ".c8ignore/placeholder.txt", "");
		const { w, baseline } = await startWatch(root);
		writeFileSync(join(root, "resources", "prompt.md"), "# edited");
		await waitForDeploymentOf(["main.bpmn", "prompt.md"], baseline, w);
	});

	test("the banner reports the selected set and no server version check is made", async () => {
		const { w } = await startWatch(makeProject(), [], { settled: false });
		assert.match(
			w.getOutput(),
			/Monitoring 2 resource\(s\) selected by "deployResources"/,
		);
		assert.strictEqual(mock.topologyCalls(), 0);
	});

	test('"Changes to selected files (… modify …) trigger redeployment with the re-resolved set"', async () => {
		const root = makeProject();
		const { w, baseline } = await startWatch(root);
		writeFileSync(join(root, "resources", "prompt.md"), "# edited prompt");
		await waitForDeploymentOf(["main.bpmn", "prompt.md"], baseline, w);
	});

	test('"Changes to selected files (create …)" — a new file matching the patterns is deployed with the set', async () => {
		const root = makeProject();
		const { w, baseline } = await startWatch(root);
		writeProjectFile(root, "resources/sub/new-task.md", "# new");
		await waitForDeploymentOf(
			["main.bpmn", "new-task.md", "prompt.md"],
			baseline,
			w,
		);
	});

	test('"Changes to selected files (… delete …)" — the set is redeployed without the deleted file', async () => {
		const root = makeProject();
		const { w, baseline } = await startWatch(root);
		unlinkSync(join(root, "resources", "prompt.md"));
		await waitForDeploymentOf(["main.bpmn"], baseline, w);
	});

	test('"Changes to selected files (… rename)" — renaming a selected file out of the selection redeploys without it', async () => {
		const root = makeProject();
		const { w, baseline } = await startWatch(root);
		renameSync(
			join(root, "resources", "prompt.md"),
			join(root, "resources", "drafts", "prompt.md"),
		);
		await waitForDeploymentOf(["main.bpmn"], baseline, w);
	});

	test("deployments never overlap: a change during an in-flight deploy is deployed after it, so the newest content lands last", async () => {
		const root = makeProject();
		const { w, baseline } = await startWatch(root);
		const release = mock.holdNextDeployment();
		writeFileSync(join(root, "resources", "prompt.md"), "# version-one");
		await waitUntil(() => mock.deployments.length === baseline + 1, w);
		writeFileSync(join(root, "resources", "prompt.md"), "# version-two");
		await waitForOutput(/Waiting for the in-flight deployment/, w);
		assert.strictEqual(
			mock.deployments.length,
			baseline + 1,
			"no second deployment while the first is in flight",
		);
		release();
		await waitUntil(() => mock.deployments.length === baseline + 2, w);
		assert.match(mock.deploymentBodies[baseline], /version-one/);
		assert.match(mock.deploymentBodies[baseline + 1], /version-two/);
	});

	test("changes to files outside the selection do not redeploy", async () => {
		const root = makeProject();
		const { w, baseline } = await startWatch(root);
		writeFileSync(join(root, "README.md"), "# edited readme");
		writeFileSync(join(root, "resources", "drafts", "wip.bpmn"), BPMN("wip2"));
		// Events arrive in order, so once a later descriptor edit is
		// processed, the earlier changes have been handled too.
		await settle(w, root);
		assert.strictEqual(mock.deployments.length, baseline);
	});

	test('".c8ignore cannot change descriptor-based selection" — a change to a selected file listed in .c8ignore still redeploys', async () => {
		const root = makeProject();
		writeFileSync(join(root, ".c8ignore"), "resources/prompt.md\n");
		const { w, baseline } = await startWatch(root);
		writeFileSync(join(root, "resources", "prompt.md"), "# edited");
		await waitForDeploymentOf(["main.bpmn", "prompt.md"], baseline, w);
	});

	test('"A camunda.json edit re-resolves the selection and redeploys if the set changed"', async () => {
		const root = makeProject();
		const { w, baseline } = await startWatch(root);
		writeDescriptor(root, descriptor(["resources/**"]));
		await waitForDeploymentOf(
			["main.bpmn", "prompt.md", "wip.bpmn"],
			baseline,
			w,
		);
	});

	test('"A camunda.json edit re-resolves the selection and redeploys if the set changed" — successive editor-style saves (write a temp file, then rename over camunda.json) keep being detected', async () => {
		const root = makeProject();
		const { w, baseline } = await startWatch(root);
		const saveAtomically = (patterns: string[]) => {
			const temp = join(root, ".camunda.json.swp");
			writeFileSync(temp, descriptor(patterns));
			renameSync(temp, join(root, "camunda.json"));
		};
		saveAtomically(["resources/**"]);
		await waitForDeploymentOf(
			["main.bpmn", "prompt.md", "wip.bpmn"],
			baseline,
			w,
		);
		saveAtomically(["resources/*.md"]);
		await waitForDeploymentOf(["prompt.md"], baseline, w);
		saveAtomically(["resources/*.bpmn"]);
		await waitForDeploymentOf(["main.bpmn"], baseline, w);
	});

	test('"A camunda.json edit … redeploys if the set changed" — an edit that keeps the set does not redeploy', async () => {
		const root = makeProject();
		const { w, baseline } = await startWatch(root);
		const before = countMatches(w, /selected resources are unchanged/g);
		writeDescriptor(
			root,
			descriptor(["!README.md", "resources/**", "!resources/drafts/"]),
		);
		await waitUntil(
			() => countMatches(w, /selected resources are unchanged/g) > before,
			w,
		);
		assert.strictEqual(mock.deployments.length, baseline);
	});
});

describe('Spec: Watch and live updates — "Invalid configuration or an empty selection surfaces an error; with --force, watching continues"', () => {
	test("an invalid deployResources edit without --force surfaces the error and stops watching", async () => {
		const root = makeProject();
		const { w, baseline } = await startWatch(root);
		writeDescriptor(root, descriptor("resources/**"));
		const code = await w.waitForExit(SAFETY_NET_MS);
		// `null` would mean the watcher had to be killed: it must exit on its own.
		assert.strictEqual(code, 1, w.getOutput());
		assert.match(w.getOutput(), /Invalid "deployResources"/);
		assert.strictEqual(mock.deployments.length, baseline);
	});

	test("an empty-selection edit without --force surfaces the error and stops watching", async () => {
		const root = makeProject();
		const { w, baseline } = await startWatch(root);
		writeDescriptor(root, descriptor(["nothing/**"]));
		const code = await w.waitForExit(SAFETY_NET_MS);
		// `null` would mean the watcher had to be killed: it must exit on its own.
		assert.strictEqual(code, 1, w.getOutput());
		assert.match(w.getOutput(), /No deployable files found/);
		assert.strictEqual(mock.deployments.length, baseline);
	});

	test("with --force, an invalid edit is reported, watching continues, and the fixed descriptor redeploys", async () => {
		const root = makeProject();
		const { w, baseline } = await startWatch(root, ["--force"]);
		writeDescriptor(root, descriptor([42]));
		await waitForOutput(/Invalid "deployResources"/, w);
		await waitForOutput(/Continuing to watch \(--force\)/, w);
		writeDescriptor(root, descriptor(["resources/*.md"]));
		await waitForDeploymentOf(["prompt.md"], baseline, w);
	});

	test("with --force, an empty selection is reported and watching continues", async () => {
		const root = makeProject();
		const { w, baseline } = await startWatch(root, ["--force"]);
		writeDescriptor(root, descriptor(["nothing/**"]));
		await waitForOutput(/No deployable files found/, w);
		writeProjectFile(root, "nothing/now-something.bpmn", BPMN("n"));
		await waitForDeploymentOf(["now-something.bpmn"], baseline, w);
	});

	test("with --force, file changes made while the descriptor is invalid are deployed once it is fixed", async () => {
		const root = makeProject();
		const { w, baseline } = await startWatch(root, ["--force"]);
		const continuing = /Continuing to watch \(--force\)/g;
		writeDescriptor(root, descriptor([42]));
		await waitUntil(() => countMatches(w, continuing) >= 1, w);
		writeFileSync(
			join(root, "resources", "prompt.md"),
			"# edited while broken",
		);
		// The edit is processed (and still blocked) by a second resolution.
		await waitUntil(() => countMatches(w, continuing) >= 2, w);
		// Restoring a descriptor with the same selected set must still
		// deploy the edit that happened during recovery.
		writeDescriptor(root, descriptor(["resources/**", "!resources/drafts/"]));
		await waitForDeploymentOf(["main.bpmn", "prompt.md"], baseline, w);
	});

	test("an invalid descriptor at startup fails without --force", () => {
		const root = createProject(
			join(tempDir, "bad"),
			{ deployResources: ["../outside/**"] },
			{ "main.bpmn": BPMN("main") },
		);
		const result = runWatch([root, "--project"]);
		assert.notStrictEqual(result.status, 0);
		assert.match(result.stderr + result.stdout, /'\.\.' is not allowed/);
	});

	test("an empty selection at startup with --force is reported and watching starts", async () => {
		const root = createProject(
			join(tempDir, "empty"),
			{ deployResources: [] },
			{ "main.bpmn": BPMN("main") },
		);
		const { w } = await startWatch(root, ["--force"], { settled: false });
		assert.match(w.getOutput(), /No deployable files found/);
		writeDescriptor(root, descriptor(["*.bpmn"]));
		await waitForDeploymentOf(["main.bpmn"], 0, w);
	});
});

describe('Spec: Descriptor precedence — "c8 watch --project --force keeps its separate meaning of continuing after deployment errors; it is not a resource-selection override"', () => {
	for (const flag of ["--extensions=.md", "--all-extensions"]) {
		test(`watch --project ${flag} is rejected with an actionable message`, () => {
			const result = runWatch([makeProject(), "--project", flag]);
			assert.notStrictEqual(result.status, 0);
			const output = result.stderr + result.stdout;
			assert.match(output, new RegExp(`${flag.split("=")[0]} cannot be used`));
			assert.match(output, /deployResources/);
		});
	}

	test("watch --project --force is accepted and announces error continuation", async () => {
		const { w } = await startWatch(makeProject(), ["--force"], {
			settled: false,
		});
		assert.match(
			w.getOutput(),
			/Force mode: will continue watching after deployment errors/,
		);
	});
});

describe('Spec: "When deployResources is absent, the existing scan rules apply"', () => {
	test("watch --project without deployResources keeps monitoring by extension", async () => {
		const root = createProject(
			join(tempDir, "plain"),
			{},
			{
				"main.bpmn": BPMN("main"),
			},
		);
		const { w } = await startWatch(root, [], { settled: false });
		assert.match(w.getOutput(), /Monitoring extensions: \.bpmn, \.dmn, \.form/);
	});
});

function runWatch(args: string[]) {
	return spawnSync(
		"node",
		["--experimental-strip-types", CLI_ENTRY, "watch", ...args],
		{
			encoding: "utf-8",
			timeout: SAFETY_NET_MS,
			env: {
				...process.env,
				C8CTL_DATA_DIR: dataDir,
				CAMUNDA_BASE_URL: mock.baseUrl,
			},
		},
	);
}
