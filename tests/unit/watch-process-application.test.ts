/**
 * Tests for `watch --process-application` flag.
 *
 * When `--process-application` (or `--pa`) is passed to `c8 watch`, the watch
 * scope expands to the process application root (nearest ancestor directory
 * containing `.process-application`) and each change triggers a full PA deploy
 * instead of a single-file deploy.
 *
 * @see https://github.com/camunda/c8ctl/issues/227
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
	testDir = mkdtempSync(join(tmpdir(), "c8ctl-watch-pa-"));
});

afterEach(() => {
	if (existsSync(testDir)) {
		rmSync(testDir, { recursive: true, force: true });
	}
});

describe("watch --process-application (#227)", () => {
	test("help watch shows --process-application flag", () => {
		const result = spawnSync(
			"node",
			["--experimental-strip-types", CLI_ENTRY, "help", "watch"],
			{
				encoding: "utf-8",
				stdio: "pipe",
				timeout: 5000,
				env: {
					...process.env,
					C8CTL_DATA_DIR: testDir,
				},
			},
		);

		assert.ok(
			result.stdout.includes("--process-application"),
			"help output should include --process-application flag",
		);
	});

	test("watch --pa is accepted as alias", () => {
		// Create a PA with a bpmn file
		const paRoot = join(testDir, "my-app");
		mkdirSync(paRoot, { recursive: true });
		writeFileSync(join(paRoot, ".process-application"), "");
		writeFileSync(join(paRoot, "main.bpmn"), "<definitions/>");

		// Start watch --pa and let it time out — just verify it starts OK
		const result = spawnSync(
			"node",
			["--experimental-strip-types", CLI_ENTRY, "watch", "--pa", paRoot],
			{
				encoding: "utf-8",
				stdio: "pipe",
				timeout: 10000,
				env: {
					...process.env,
					C8CTL_DATA_DIR: testDir,
				},
			},
		);

		const output = (result.stdout || "") + (result.stderr || "");
		assert.ok(
			output.includes("Watching for changes"),
			`--pa should be accepted and start watching, got:\n${output}`,
		);
	});

	test("watch --process-application shows PA mode message", () => {
		const paRoot = join(testDir, "my-app");
		mkdirSync(paRoot, { recursive: true });
		writeFileSync(join(paRoot, ".process-application"), "");
		writeFileSync(join(paRoot, "main.bpmn"), "<definitions/>");

		const result = spawnSync(
			"node",
			[
				"--experimental-strip-types",
				CLI_ENTRY,
				"watch",
				"--process-application",
				paRoot,
			],
			{
				encoding: "utf-8",
				stdio: "pipe",
				timeout: 10000,
				env: {
					...process.env,
					C8CTL_DATA_DIR: testDir,
				},
			},
		);

		const output = (result.stdout || "") + (result.stderr || "");
		assert.ok(
			output.includes("Process application mode"),
			`Watch should indicate PA mode in output, got:\n${output}`,
		);
	});

	test("watch --process-application errors when no .process-application found", () => {
		// Plain directory with no marker
		const dir = join(testDir, "plain");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "main.bpmn"), "<definitions/>");

		const result = spawnSync(
			"node",
			[
				"--experimental-strip-types",
				CLI_ENTRY,
				"watch",
				"--process-application",
				dir,
			],
			{
				encoding: "utf-8",
				stdio: "pipe",
				timeout: 5000,
				env: {
					...process.env,
					C8CTL_DATA_DIR: testDir,
				},
			},
		);

		assert.notStrictEqual(
			result.status,
			0,
			"Should fail when --process-application is set but no marker found",
		);
		const output = (result.stdout || "") + (result.stderr || "");
		assert.ok(
			output.includes(".process-application"),
			`Error message should mention .process-application, got:\n${output}`,
		);
	});

	test("watch --process-application expands watch scope to PA root", () => {
		// PA root with marker, and a subdirectory beneath it
		const paRoot = join(testDir, "my-app");
		const subDir = join(paRoot, "src", "processes");
		mkdirSync(subDir, { recursive: true });
		writeFileSync(join(paRoot, ".process-application"), "");
		writeFileSync(join(subDir, "main.bpmn"), "<definitions/>");

		// Watch the subdirectory with --process-application
		const result = spawnSync(
			"node",
			[
				"--experimental-strip-types",
				CLI_ENTRY,
				"watch",
				"--process-application",
				subDir,
			],
			{
				encoding: "utf-8",
				stdio: "pipe",
				// Generous timeout — a safety net for slow CI runners, not a
				// correctness signal. The assertion fires as soon as the
				// banner is emitted; the timeout only caps how long we wait.
				timeout: 10000,
				env: {
					...process.env,
					C8CTL_DATA_DIR: testDir,
				},
			},
		);

		const output = (result.stdout || "") + (result.stderr || "");

		// The "Watching for changes in:" line should show the PA root,
		// not the subdirectory that was passed on the command line.
		const watchLine = output
			.split("\n")
			.find((l: string) => l.includes("Watching for changes in:"));
		assert.ok(watchLine, `Expected "Watching for changes in:" line in output`);

		const normalizedWatchLine = watchLine.replace(/\\/g, "/");
		const normalizedPaRoot = paRoot.replace(/\\/g, "/");
		const normalizedSubDir = subDir.replace(/\\/g, "/");

		assert.ok(
			normalizedWatchLine.includes(normalizedPaRoot),
			`Watch scope should include PA root "${normalizedPaRoot}", got: ${normalizedWatchLine}`,
		);
		// The subdirectory path should NOT appear (it was expanded to the PA root)
		assert.ok(
			!normalizedWatchLine.includes(normalizedSubDir),
			`Watch scope should not include subdirectory "${normalizedSubDir}", got: ${normalizedWatchLine}`,
		);
	});

	test("watch --process-application rejects paths from different PAs", () => {
		// Two separate process applications
		const pa1 = join(testDir, "app-a");
		const pa2 = join(testDir, "app-b");
		mkdirSync(pa1, { recursive: true });
		mkdirSync(pa2, { recursive: true });
		writeFileSync(join(pa1, ".process-application"), "");
		writeFileSync(join(pa2, ".process-application"), "");
		writeFileSync(join(pa1, "a.bpmn"), "<definitions/>");
		writeFileSync(join(pa2, "b.bpmn"), "<definitions/>");

		const result = spawnSync(
			"node",
			[
				"--experimental-strip-types",
				CLI_ENTRY,
				"watch",
				"--process-application",
				pa1,
				pa2,
			],
			{
				encoding: "utf-8",
				stdio: "pipe",
				timeout: 5000,
				env: {
					...process.env,
					C8CTL_DATA_DIR: testDir,
				},
			},
		);

		assert.notStrictEqual(
			result.status,
			0,
			"Should fail when paths belong to different process applications",
		);
		const output = (result.stdout || "") + (result.stderr || "");
		assert.ok(
			output.includes("same process application"),
			`Error should mention same process application, got:\n${output}`,
		);
	});
});
