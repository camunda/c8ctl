/**
 * Guard for how the test spawn helpers report a child they killed on timeout.
 *
 * Regression context: when a spawned CLI exceeded its `timeout`, the helpers
 * killed it and reported a plain `status: 1` with whatever stderr had been
 * captured (often nothing). A hung command was then indistinguishable from a
 * command that exited 1 on its own, so a CI failure read as a bare
 * `1 !== 0` with no hint that the deadline — not the CLI — ended the run.
 *
 * The contract pinned here, for every spawn helper:
 * - a timed-out child reports `timedOut: true`, carries an explicit "timed out
 *   after N ms" note in stderr naming the signal sent, and preserves the
 *   child's actual exit status/signal — even when the child handles the
 *   timeout's SIGTERM and exits 0 or 1 on its own (then `signal` is null and
 *   `status` is that exit code, but `timedOut` is still true);
 * - an unhandled timeout kill reports `signal: SIGTERM` and `status: null`
 *   (Node's convention for a signal-terminated child);
 * - a child that exits on its own reports `timedOut: false` and `signal: null`.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { asyncSpawn, asyncSpawnWithStdin } from "../utils/spawn.ts";

// Stays alive until killed; the timeout below is the only thing that ends it.
const HANG = ["-e", "setInterval(() => {}, 1000)"];
const EXIT_ONE = ["-e", "process.stderr.write('own failure'); process.exit(1)"];
// Install a SIGTERM handler and exit on our own terms, so the timeout's kill
// lands (child.killed is true) but the close event carries exit code 0/1 and a
// null signal — the graceful-shutdown shape (e.g. mcp-proxy) that must still be
// reported as a timeout.
const HANDLED_SIGTERM_EXIT_ZERO = [
	"-e",
	"process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)",
];
const HANDLED_SIGTERM_EXIT_ONE = [
	"-e",
	"process.on('SIGTERM', () => process.exit(1)); setInterval(() => {}, 1000)",
];
// Short deadline for children the timeout must kill; keep it small so the
// hang/handled-SIGTERM cases end quickly.
const TIMEOUT_MS = 300;
// Generous deadline for the ordinary-exit control: it must start a fresh Node
// process, write stderr, and exit 1 of its own accord. Sharing the short HANG
// deadline would let CI load kill a correct child before it exits and corrupt
// this guard, so it gets its own headroom.
const GENEROUS_TIMEOUT_MS = 30_000;

const helpers = {
	asyncSpawn: (args: string[], timeout: number) =>
		asyncSpawn("node", args, { timeout }),
	asyncSpawnWithStdin: (args: string[], timeout: number) =>
		asyncSpawnWithStdin("node", args, () => {}, { timeout }),
};

describe("spawn helpers: timeout reporting (regression guard)", () => {
	for (const [name, run] of Object.entries(helpers)) {
		test(`${name} reports a timed-out child as killed, not as exit code 1`, async () => {
			const result = await run(HANG, TIMEOUT_MS);
			assert.equal(result.timedOut, true);
			assert.equal(result.signal, "SIGTERM");
			assert.equal(result.status, null);
			assert.match(
				result.stderr,
				new RegExp(`timed out after ${TIMEOUT_MS} ms`),
			);
		});

		test(`${name} reports a handled SIGTERM that exits 0 as a timeout`, async () => {
			const result = await run(HANDLED_SIGTERM_EXIT_ZERO, TIMEOUT_MS);
			assert.equal(result.timedOut, true);
			assert.equal(result.signal, null);
			assert.equal(result.status, 0);
			assert.match(
				result.stderr,
				new RegExp(
					`timed out after ${TIMEOUT_MS} ms and was killed with SIGTERM`,
				),
			);
		});

		test(`${name} reports a handled SIGTERM that exits 1 as a timeout`, async () => {
			const result = await run(HANDLED_SIGTERM_EXIT_ONE, TIMEOUT_MS);
			assert.equal(result.timedOut, true);
			assert.equal(result.signal, null);
			assert.equal(result.status, 1);
			assert.match(
				result.stderr,
				new RegExp(
					`timed out after ${TIMEOUT_MS} ms and was killed with SIGTERM`,
				),
			);
		});

		test(`${name} reports a child's own non-zero exit unchanged`, async () => {
			const result = await run(EXIT_ONE, GENEROUS_TIMEOUT_MS);
			assert.equal(result.timedOut, false);
			assert.equal(result.signal, null);
			assert.equal(result.status, 1);
			assert.equal(result.stderr, "own failure");
		});
	}
});
