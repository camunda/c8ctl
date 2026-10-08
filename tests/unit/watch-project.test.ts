/**
 * Tests for `watch --project` flag and camunda.json marker support.
 *
 * `--project` is the canonical flag going forward; `--process-application`
 * and `--pa` remain as deprecated aliases during the transition. A
 * `camunda.json` file marks the project root the same way a
 * `.process-application` marker does.
 *
 * Long-running watch invocations never exit on their own, so they are
 * spawned via tests/utils/watch-process.ts and polled for their readiness
 * banner instead of relying on a spawn timeout. Error cases exit on their
 * own and use a plain synchronous spawn.
 */

import assert from "node:assert";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { pollUntil } from "../utils/polling.ts";
import { startWatchProcess } from "../utils/watch-process.ts";

const CLI_ENTRY = join(process.cwd(), "src", "index.ts");

let testDir: string;

beforeEach(() => {
	testDir = mkdtempSync(join(tmpdir(), "c8ctl-watch-project-"));
});

afterEach(() => {
	if (existsSync(testDir)) {
		rmSync(testDir, { recursive: true, force: true });
	}
});

/** Run a c8ctl invocation expected to exit on its own (errors, help). */
function runCli(args: string[], timeout = 5000) {
	return spawnSync("node", ["--experimental-strip-types", CLI_ENTRY, ...args], {
		encoding: "utf-8",
		stdio: "pipe",
		timeout,
		env: {
			...process.env,
			C8CTL_DATA_DIR: testDir,
		},
	});
}

/**
 * Start `c8 watch` and wait for the readiness banner, so the assertion
 * fires as soon as the watcher is up instead of after a fixed timeout.
 */
async function watchUntilReady(extraArgs: string[], watchDir: string) {
	const watch = startWatchProcess({
		watchDir,
		dataDir: testDir,
		extraArgs,
	});
	const ready = await pollUntil(
		async () => watch.getOutput().includes("Watching for changes"),
		10000,
		100,
	);
	return { watch, ready };
}

describe("watch --project", () => {
	test("help watch shows --project flag", () => {
		const result = runCli(["help", "watch"]);
		assert.ok(
			result.stdout.includes("--project"),
			`help output should include --project flag, got:\n${result.stdout}`,
		);
	});

	test("watch --project works with a camunda.json marker", async () => {
		const projectRoot = join(testDir, "my-project");
		mkdirSync(projectRoot, { recursive: true });
		writeFileSync(join(projectRoot, "camunda.json"), "{}");
		writeFileSync(join(projectRoot, "main.bpmn"), "<definitions/>");

		const { watch, ready } = await watchUntilReady(["--project"], projectRoot);
		try {
			assert.ok(
				ready,
				`--project should be accepted and start watching, got:\n${watch.getOutput()}`,
			);
		} finally {
			await watch.cleanup();
		}
	});

	test("watch --project shows project mode message", async () => {
		const projectRoot = join(testDir, "my-project");
		mkdirSync(projectRoot, { recursive: true });
		writeFileSync(join(projectRoot, "camunda.json"), "{}");
		writeFileSync(join(projectRoot, "main.bpmn"), "<definitions/>");

		const { watch, ready } = await watchUntilReady(["--project"], projectRoot);
		try {
			assert.ok(
				ready,
				`Watch should reach readiness, got:\n${watch.getOutput()}`,
			);
			assert.ok(
				watch.getOutput().includes("Project mode"),
				`Watch should indicate project mode in output, got:\n${watch.getOutput()}`,
			);
		} finally {
			await watch.cleanup();
		}
	});

	test("watch --project expands watch scope to the camunda.json project root", async () => {
		const projectRoot = join(testDir, "my-project");
		const subDir = join(projectRoot, "src", "processes");
		mkdirSync(subDir, { recursive: true });
		writeFileSync(join(projectRoot, "camunda.json"), "{}");
		writeFileSync(join(subDir, "main.bpmn"), "<definitions/>");

		const { watch, ready } = await watchUntilReady(["--project"], subDir);
		try {
			assert.ok(
				ready,
				`Watch should reach readiness, got:\n${watch.getOutput()}`,
			);
			const watchLine = watch
				.getOutput()
				.split("\n")
				.find((l: string) => l.includes("Watching for changes in:"));
			assert.ok(
				watchLine,
				`Expected "Watching for changes in:" line in output`,
			);

			const normalizedWatchLine = watchLine.replace(/\\/g, "/");
			const normalizedRoot = projectRoot.replace(/\\/g, "/");
			const normalizedSubDir = subDir.replace(/\\/g, "/");

			assert.ok(
				normalizedWatchLine.includes(normalizedRoot),
				`Watch scope should include project root "${normalizedRoot}", got: ${normalizedWatchLine}`,
			);
			assert.ok(
				!normalizedWatchLine.includes(normalizedSubDir),
				`Watch scope should not include subdirectory "${normalizedSubDir}", got: ${normalizedWatchLine}`,
			);
		} finally {
			await watch.cleanup();
		}
	});

	test("watch --project works with a legacy .process-application marker", async () => {
		const paRoot = join(testDir, "my-app");
		mkdirSync(paRoot, { recursive: true });
		writeFileSync(join(paRoot, ".process-application"), "");
		writeFileSync(join(paRoot, "main.bpmn"), "<definitions/>");

		const { watch, ready } = await watchUntilReady(["--project"], paRoot);
		try {
			assert.ok(
				ready,
				`--project should accept legacy marker, got:\n${watch.getOutput()}`,
			);
		} finally {
			await watch.cleanup();
		}
	});

	test("watch --project errors when no marker found, mentioning camunda.json", () => {
		const dir = join(testDir, "plain");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "main.bpmn"), "<definitions/>");

		const result = runCli(["watch", "--project", dir]);

		assert.notStrictEqual(result.status, 0, "Should fail without a marker");
		const output = (result.stdout || "") + (result.stderr || "");
		assert.ok(
			output.includes("camunda.json"),
			`Error message should mention camunda.json, got:\n${output}`,
		);
	});

	test("watch --project fails on invalid camunda.json", () => {
		const projectRoot = join(testDir, "broken-project");
		mkdirSync(projectRoot, { recursive: true });
		writeFileSync(join(projectRoot, "camunda.json"), "{ broken");
		writeFileSync(join(projectRoot, "main.bpmn"), "<definitions/>");

		const result = runCli(["watch", "--project", projectRoot]);

		assert.notStrictEqual(
			result.status,
			0,
			"Invalid camunda.json must not silently count as a marker",
		);
		const output = (result.stdout || "") + (result.stderr || "");
		assert.ok(
			/invalid JSON/i.test(output),
			`Error should mention invalid JSON, got:\n${output}`,
		);
	});
});
