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
 * - a timed-out child reports `timedOut: true`, the kill `signal`, and
 *   `status: null` (Node's convention for a signal-terminated child);
 * - stderr carries an explicit "timed out after N ms" note, so any assertion
 *   that prints stderr as its message names the real cause;
 * - a child that exits on its own reports `timedOut: false` and `signal: null`.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { asyncSpawn, asyncSpawnWithStdin } from "../utils/spawn.ts";

// Stays alive until killed; the timeout below is the only thing that ends it.
const HANG = ["-e", "setInterval(() => {}, 1000)"];
const EXIT_ONE = ["-e", "process.stderr.write('own failure'); process.exit(1)"];
const TIMEOUT_MS = 300;

const helpers = {
	asyncSpawn: (args: string[]) =>
		asyncSpawn("node", args, { timeout: TIMEOUT_MS }),
	asyncSpawnWithStdin: (args: string[]) =>
		asyncSpawnWithStdin("node", args, () => {}, { timeout: TIMEOUT_MS }),
};

describe("spawn helpers: timeout reporting (regression guard)", () => {
	for (const [name, run] of Object.entries(helpers)) {
		test(`${name} reports a timed-out child as killed, not as exit code 1`, async () => {
			const result = await run(HANG);
			assert.equal(result.timedOut, true);
			assert.equal(result.signal, "SIGTERM");
			assert.equal(result.status, null);
			assert.match(
				result.stderr,
				new RegExp(`timed out after ${TIMEOUT_MS} ms`),
			);
		});

		test(`${name} reports a child's own non-zero exit unchanged`, async () => {
			const result = await run(EXIT_ONE);
			assert.equal(result.timedOut, false);
			assert.equal(result.signal, null);
			assert.equal(result.status, 1);
			assert.equal(result.stderr, "own failure");
		});
	}
});
