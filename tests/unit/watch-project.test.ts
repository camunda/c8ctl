/**
 * Tests for `watch --project` flag and camunda.json marker support.
 *
 * `--project` is the canonical flag going forward; `--process-application`
 * and `--pa` remain as deprecated aliases during the transition. A
 * `camunda.json` file marks the project root the same way a
 * `.process-application` marker does.
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

function runWatch(args: string[], timeout = 10000) {
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

describe("watch --project", () => {
	test("help watch shows --project flag", () => {
		const result = runWatch(["help", "watch"], 5000);
		assert.ok(
			result.stdout.includes("--project"),
			`help output should include --project flag, got:\n${result.stdout}`,
		);
	});

	test("watch --project works with a camunda.json marker", () => {
		const projectRoot = join(testDir, "my-project");
		mkdirSync(projectRoot, { recursive: true });
		writeFileSync(join(projectRoot, "camunda.json"), "{}");
		writeFileSync(join(projectRoot, "main.bpmn"), "<definitions/>");

		const result = runWatch(["watch", "--project", projectRoot]);

		const output = (result.stdout || "") + (result.stderr || "");
		assert.ok(
			output.includes("Watching for changes"),
			`--project should be accepted and start watching, got:\n${output}`,
		);
	});

	test("watch --project shows project mode message", () => {
		const projectRoot = join(testDir, "my-project");
		mkdirSync(projectRoot, { recursive: true });
		writeFileSync(join(projectRoot, "camunda.json"), "{}");
		writeFileSync(join(projectRoot, "main.bpmn"), "<definitions/>");

		const result = runWatch(["watch", "--project", projectRoot]);

		const output = (result.stdout || "") + (result.stderr || "");
		assert.ok(
			output.includes("Project mode"),
			`Watch should indicate project mode in output, got:\n${output}`,
		);
	});

	test("watch --project expands watch scope to the camunda.json project root", () => {
		const projectRoot = join(testDir, "my-project");
		const subDir = join(projectRoot, "src", "processes");
		mkdirSync(subDir, { recursive: true });
		writeFileSync(join(projectRoot, "camunda.json"), "{}");
		writeFileSync(join(subDir, "main.bpmn"), "<definitions/>");

		const result = runWatch(["watch", "--project", subDir]);

		const output = (result.stdout || "") + (result.stderr || "");
		const watchLine = output
			.split("\n")
			.find((l: string) => l.includes("Watching for changes in:"));
		assert.ok(watchLine, `Expected "Watching for changes in:" line in output`);

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
	});

	test("watch --project errors when no marker found, mentioning camunda.json", () => {
		const dir = join(testDir, "plain");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "main.bpmn"), "<definitions/>");

		const result = runWatch(["watch", "--project", dir], 5000);

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

		const result = runWatch(["watch", "--project", projectRoot], 5000);

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

	test("watch --project works with a legacy .process-application marker", () => {
		const paRoot = join(testDir, "my-app");
		mkdirSync(paRoot, { recursive: true });
		writeFileSync(join(paRoot, ".process-application"), "");
		writeFileSync(join(paRoot, "main.bpmn"), "<definitions/>");

		const result = runWatch(["watch", "--project", paRoot]);

		const output = (result.stdout || "") + (result.stderr || "");
		assert.ok(
			output.includes("Watching for changes"),
			`--project should accept legacy marker, got:\n${output}`,
		);
	});
});
