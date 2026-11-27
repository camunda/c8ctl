/**
 * Unit tests for watch --force mode
 */

import assert from "node:assert";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { c8WithOptions } from "../utils/cli.ts";
import { pollUntil } from "../utils/polling.ts";
import {
	startWatchProcess,
	type WatchProcess,
} from "../utils/watch-process.ts";

const WATCH_READY_MESSAGE = "Press Ctrl+C to stop watching";
// The banner is the readiness signal; this deadline only guards against a
// process that never starts under runner load.
const WATCH_STARTUP_SAFETY_NET_MS = 15_000;
const POLL_INTERVAL_MS = 50;

describe("Watch Force Mode", () => {
	let testDir: string;
	let watcher: WatchProcess | undefined;

	beforeEach(() => {
		testDir = join(tmpdir(), `c8ctl-watch-force-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(async () => {
		await watcher?.cleanup();
		watcher = undefined;
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	async function startWatch(force: boolean): Promise<WatchProcess> {
		const watchDir = join(testDir, "watch-test");
		mkdirSync(watchDir, { recursive: true });
		writeFileSync(join(watchDir, "test.bpmn"), "<definitions/>");

		const watch = startWatchProcess({
			watchDir,
			dataDir: testDir,
			extraArgs: force ? ["--force"] : [],
		});
		watcher = watch;

		const ready = await pollUntil(
			async () => watch.getOutput().includes(WATCH_READY_MESSAGE),
			WATCH_STARTUP_SAFETY_NET_MS,
			POLL_INTERVAL_MS,
		);
		assert.ok(
			ready,
			`watch did not reach readiness within ${WATCH_STARTUP_SAFETY_NET_MS}ms. Output:\n${watch.getOutput()}`,
		);
		return watch;
	}

	test("help watch shows --force flag", async () => {
		const result = await c8WithOptions(
			{ env: { C8CTL_DATA_DIR: testDir } },
			"help",
			"watch",
		);

		assert.ok(
			result.stdout.includes("--force"),
			"help output should include --force flag",
		);
		assert.ok(
			result.stdout.includes("Continue watching after all deployment errors"),
			"help output should describe --force purpose",
		);
	});

	test("help watch alias w shows --force flag", async () => {
		const result = await c8WithOptions(
			{ env: { C8CTL_DATA_DIR: testDir } },
			"help",
			"w",
		);

		assert.ok(
			result.stdout.includes("--force"),
			"help output for alias w should include --force flag",
		);
	});

	test("watch --force shows force mode message", async () => {
		const watch = await startWatch(true);
		assert.ok(
			watch.getOutput().includes("Force mode"),
			"watch --force should display force mode message",
		);
	});

	test("watch without --force does not show force mode message", async () => {
		const watch = await startWatch(false);

		assert.ok(
			!watch.getOutput().includes("Force mode"),
			"watch without --force should NOT display force mode message",
		);
	});
});
