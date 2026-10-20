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
 * - a child that exits on its own reports `timedOut: false` and `signal: null`;
 * - a maxBuffer overflow kills the child without the deadline expiring, so it
 *   reports `timedOut: false` and keeps its own
 *   `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` diagnostic rather than a spurious
 *   "timed out" note.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { describe, test } from "node:test";
import { asyncSpawn, asyncSpawnWithStdin } from "../utils/spawn.ts";

// Stays alive until killed; the timeout below is the only thing that ends it.
const HANG = ["-e", "setInterval(() => {}, 1000)"];
const EXIT_ONE = ["-e", "process.stderr.write('own failure'); process.exit(1)"];
// Install a SIGTERM handler, signal readiness on stdout, then stay alive until
// the timeout's SIGTERM lands — at which point the handler fires and the child
// exits 0/1 on its own terms. The close event then carries that exit code and a
// null signal (the graceful-shutdown shape, e.g. mcp-proxy) that must still be
// reported as a timeout. The readiness print lets the helper arm the kill timer
// only after the handler is installed, so slow CI startup can't turn the kill
// into an unhandled SIGTERM.
const HANDLED_SIGTERM_EXIT_ZERO = [
	"-e",
	"process.on('SIGTERM', () => process.exit(0)); process.stdout.write('READY\\n'); setInterval(() => {}, 1000)",
];
const HANDLED_SIGTERM_EXIT_ONE = [
	"-e",
	"process.on('SIGTERM', () => process.exit(1)); process.stdout.write('READY\\n'); setInterval(() => {}, 1000)",
];
// Emits more than asyncSpawn's 10 MiB maxBuffer, triggering a buffer-overflow
// kill (ERR_CHILD_PROCESS_STDIO_MAXBUFFER) that sets child.killed without any
// deadline expiring — must NOT be reported as a timeout.
const MAXBUFFER_OVERFLOW = [
	"-e",
	"process.stdout.write('x'.repeat(11 * 1024 * 1024))",
];
// Short deadline for the kill timer once a child is known to be alive; keep it
// small so the hang/handled-SIGTERM cases end quickly.
const TIMEOUT_MS = 300;
// Generous deadline for children that must start a fresh Node process and run
// user code before the helper acts: the ordinary-exit control (write stderr,
// exit 1) and the handled-SIGTERM fixtures (install the handler, print READY).
// Sharing the short HANG deadline would let CI load kill a correct child before
// it is ready and corrupt these guards, so they get their own headroom. This is
// a safety net, not the signal under test — the kill timer is the short one.
const GENEROUS_TIMEOUT_MS = 30_000;

const helpers = {
	asyncSpawn: (args: string[], timeout: number) =>
		asyncSpawn("node", args, { timeout }),
	asyncSpawnWithStdin: (args: string[], timeout: number) =>
		asyncSpawnWithStdin("node", args, () => {}, { timeout }),
};

// Native Windows cannot deliver a POSIX SIGTERM to a child's JS handler:
// `child.kill('SIGTERM')` forcibly terminates the process, so the
// handled-SIGTERM fixtures can never produce the expected graceful exit there.
// The unhandled-timeout and own-exit cases remain meaningful on Windows.
const ON_WINDOWS = process.platform === "win32";

/**
 * Wait until a handled-SIGTERM fixture has installed its signal handler.
 *
 * The fixture prints READY on stdout immediately after `process.on('SIGTERM')`.
 * Spawning a throwaway streaming probe lets us observe that line (the buffered
 * `asyncSpawn` cannot), so the kill deadline we then hand the helper is armed
 * only once the handler exists — a slow CI start can't fire the timeout before
 * the handler is installed and turn the kill into an unhandled SIGTERM. The
 * probe is killed once READY arrives; it exists only to synchronise timing.
 */
function waitForHandlerReady(args: string[]): Promise<void> {
	return new Promise((resolvePromise, rejectPromise) => {
		const probe = spawn("node", args, { stdio: ["ignore", "pipe", "pipe"] });
		let buf = "";
		const done = () => {
			probe.kill("SIGKILL");
			resolvePromise();
		};
		probe.stdout?.setEncoding("utf-8");
		probe.stdout?.on("data", (chunk: string) => {
			buf += chunk;
			if (buf.includes("READY")) done();
		});
		probe.on("error", rejectPromise);
		// Safety net: a fixture that never prints READY must fail, not hang.
		setTimeout(
			() => rejectPromise(new Error("fixture never signalled READY")),
			GENEROUS_TIMEOUT_MS,
		).unref();
	});
}

/**
 * Run a handled-SIGTERM fixture through a spawn helper with a readiness
 * handshake: confirm the handler is installed (probe), then run the helper with
 * the short kill deadline. Because readiness precedes the real run, the short
 * deadline is measured against a child whose handler is already in place.
 */
async function runHandledSigterm(
	name: string,
	args: string[],
): Promise<{
	timedOut: boolean;
	signal: string | null;
	status: number | null;
	stderr: string;
}> {
	await waitForHandlerReady(args);
	if (name === "asyncSpawnWithStdin") {
		return await asyncSpawnWithStdin("node", args, () => {}, {
			timeout: TIMEOUT_MS,
		});
	}
	return await asyncSpawn("node", args, { timeout: TIMEOUT_MS });
}

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

		test(`${name} reports a handled SIGTERM that exits 0 as a timeout`, async (t) => {
			if (ON_WINDOWS) {
				t.skip(
					"Windows child.kill emulates termination, not POSIX signal delivery",
				);
				return;
			}
			const result = await runHandledSigterm(name, HANDLED_SIGTERM_EXIT_ZERO);
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

		test(`${name} reports a handled SIGTERM that exits 1 as a timeout`, async (t) => {
			if (ON_WINDOWS) {
				t.skip(
					"Windows child.kill emulates termination, not POSIX signal delivery",
				);
				return;
			}
			const result = await runHandledSigterm(name, HANDLED_SIGTERM_EXIT_ONE);
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

	test("asyncSpawn reports a maxBuffer overflow as a buffer error, not a timeout", async () => {
		const result = await asyncSpawn("node", MAXBUFFER_OVERFLOW, {
			timeout: GENEROUS_TIMEOUT_MS,
		});
		assert.equal(result.timedOut, false);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /maxBuffer length exceeded/);
		assert.doesNotMatch(result.stderr, /timed out/);
	});
});
