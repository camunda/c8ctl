/**
 * Behavioural regression guards for the watch command's lifecycle:
 *
 * 1. Missing-path → non-zero exit with a clear "Path does not exist" message.
 * 2. SIGINT during normal operation → clean shutdown (exit 0, "bottoms up.").
 *
 * These tests are scoped to the *defect class* "long-running handlers must
 * exit cleanly via process signals and validate inputs at the boundary",
 * not just the specific instances. They lock in the canonical lifecycle
 * shape for `defineCommand` handlers that return `{ kind: "never" }`.
 *
 * No cluster required: the watcher initializes and waits for filesystem
 * events; we send SIGINT before any deploy is triggered.
 */

import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { pollUntil } from "../utils/polling.ts";
import { startWatchProcess } from "../utils/watch-process.ts";

const POLL_INTERVAL_MS = 100;
const STARTUP_TIMEOUT_MS = 5_000;
const EXIT_TIMEOUT_MS = 5_000;

describe("watch command lifecycle", () => {
	let dataDir: string;

	before(() => {
		dataDir = mkdtempSync(join(tmpdir(), "c8ctl-watch-lifecycle-"));
	});

	after(() => {
		rmSync(dataDir, { recursive: true, force: true });
	});

	test("exits non-zero with a clear message when the path does not exist", async () => {
		const missingPath = join(tmpdir(), `c8ctl-watch-missing-${Date.now()}`);
		const watch = startWatchProcess({ watchDir: missingPath, dataDir });

		try {
			const exitCode = await watch.waitForExit(EXIT_TIMEOUT_MS);
			const output = watch.getOutput();

			assert.notStrictEqual(
				exitCode,
				0,
				`watch with a missing path should exit non-zero. Output:\n${output}`,
			);
			assert.notStrictEqual(
				exitCode,
				null,
				`watch should exit promptly on a missing path. Output:\n${output}`,
			);
			assert.ok(
				output.includes("Path does not exist") || output.includes(missingPath),
				`Expected a clear missing-path error. Output:\n${output}`,
			);
		} finally {
			await watch.cleanup(EXIT_TIMEOUT_MS);
		}
	});

	test("SIGINT shuts down cleanly with exit code 0 and the goodbye message", async () => {
		const watchDir = mkdtempSync(join(tmpdir(), "c8ctl-watch-sigint-"));
		const watch = startWatchProcess({ watchDir, dataDir });

		try {
			// Wait for the watcher to be ready before sending the signal.
			const ready = await pollUntil(
				async () => watch.getOutput().includes("Watching for changes"),
				STARTUP_TIMEOUT_MS,
				POLL_INTERVAL_MS,
			);
			assert.ok(
				ready,
				`watch did not start within ${STARTUP_TIMEOUT_MS}ms. Output:\n${watch.getOutput()}`,
			);

			watch.child.kill("SIGINT");
			const exitCode = await watch.waitForExit(EXIT_TIMEOUT_MS);
			const output = watch.getOutput();

			assert.strictEqual(
				exitCode,
				0,
				`watch should exit 0 on SIGINT. Got: ${exitCode}. Output:\n${output}`,
			);
			assert.ok(
				output.includes("bottoms up"),
				`Expected the SIGINT goodbye message. Output:\n${output}`,
			);
		} finally {
			await watch.cleanup(EXIT_TIMEOUT_MS);
			rmSync(watchDir, { recursive: true, force: true });
		}
	});
});
