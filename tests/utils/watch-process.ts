/**
 * Shared helper for spawning the `c8ctl watch` CLI as a subprocess in
 * integration tests.
 *
 * Centralises:
 * - process spawn with combined stdout/stderr capture
 * - signalled shutdown (SIGINT / SIGTERM)
 * - guaranteed cleanup (SIGKILL fallback) so a failed assertion never
 *   leaks a watcher process and hangs the test runner
 *
 * Used by both `tests/integration/watch.test.ts` (deploy behaviours) and
 * `tests/integration/watch-lifecycle.test.ts` (lifecycle guards). Keeping
 * one helper avoids drift between the two surfaces.
 */

import { type ChildProcessByStdio, spawn } from "node:child_process";
import { join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { makeTestEnv } from "./mocks.ts";

const PROJECT_ROOT = resolve(import.meta.dirname, "..", "..");
const CLI = join(PROJECT_ROOT, "src", "index.ts");

/** Default upper bound for waiting on process exit after a signal. */
export const DEFAULT_EXIT_TIMEOUT_MS = 5_000;

export interface StartWatchOptions {
	/** Directory the watcher should observe. */
	watchDir: string;
	/** Profile/data directory passed via `C8CTL_DATA_DIR`. */
	dataDir: string;
	/** Extra CLI args inserted between `watch` and `<watchDir>`. */
	extraArgs?: string[];
	/**
	 * Extra environment variables to merge into the spawn env (after
	 * `makeTestEnv`). Used by tests that need to point the SDK at a mock
	 * server via `CAMUNDA_BASE_URL`.
	 */
	env?: Record<string, string>;
}

export interface WatchProcess {
	readonly child: ChildProcessByStdio<null, Readable, Readable>;
	/** Combined stdout+stderr captured so far. */
	getOutput: () => string;
	/**
	 * Wait for the child to exit, returning its exit code, or `null` if it
	 * had to be SIGKILLed after `timeoutMs`.
	 */
	waitForExit: (timeoutMs?: number) => Promise<number | null>;
	/**
	 * Always-safe cleanup: if the child is still alive, SIGKILL it and
	 * wait for exit. Designed for use in `finally` blocks so a failed
	 * assertion can never leak a watcher process.
	 */
	cleanup: (timeoutMs?: number) => Promise<void>;
	/**
	 * Compatibility helper for the existing deploy-behaviour tests:
	 * SIGTERM the child, then wait briefly for graceful shutdown before
	 * the surrounding `finally` block tears the temp dir down.
	 */
	kill: () => Promise<void>;
}

/**
 * Spawn `node --experimental-strip-types src/index.ts watch [extra] <dir>`
 * and return handles for output, exit, and guaranteed cleanup.
 */
export function startWatchProcess(options: StartWatchOptions): WatchProcess {
	const { watchDir, dataDir, extraArgs = [], env: extraEnv = {} } = options;

	const child = spawn(
		"node",
		["--experimental-strip-types", CLI, "watch", ...extraArgs, watchDir],
		{
			cwd: PROJECT_ROOT,
			env: { ...makeTestEnv({ C8CTL_DATA_DIR: dataDir }), ...extraEnv },
			stdio: ["ignore", "pipe", "pipe"],
		},
	);

	let output = "";
	child.stdout.on("data", (chunk: Buffer) => {
		output += chunk.toString();
	});
	child.stderr.on("data", (chunk: Buffer) => {
		output += chunk.toString();
	});

	const isAlive = () => child.exitCode === null && child.signalCode === null;

	const waitForExit = (
		timeoutMs: number = DEFAULT_EXIT_TIMEOUT_MS,
	): Promise<number | null> =>
		new Promise<number | null>((resolveExit) => {
			if (!isAlive()) {
				resolveExit(child.exitCode);
				return;
			}
			const timer = setTimeout(() => {
				if (isAlive()) {
					child.kill("SIGKILL");
				}
				resolveExit(null);
			}, timeoutMs);
			// Wait for `close` (not `exit`) so stdio streams are fully drained
			// before callers assert on captured output. `exit` can fire before
			// fast failures finish flushing their final line.
			child.once("close", (code) => {
				clearTimeout(timer);
				resolveExit(code);
			});
		});

	const cleanup = async (
		timeoutMs: number = DEFAULT_EXIT_TIMEOUT_MS,
	): Promise<void> => {
		if (!isAlive()) return;
		child.kill("SIGKILL");
		await waitForExit(timeoutMs);
	};

	const kill = async (): Promise<void> => {
		if (isAlive()) {
			child.kill("SIGTERM");
		}
		// Give a moment for graceful shutdown.
		await new Promise<void>((r) => setTimeout(r, 500));
	};

	return {
		child,
		getOutput: () => output,
		waitForExit,
		cleanup,
		kill,
	};
}
