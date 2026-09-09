/**
 * Run the unit suite (tests/unit/*.test.ts) with an oversubscribed
 * --test-concurrency.
 *
 * The unit tests are dominated by cases that drive the CLI through the `c8()`
 * subprocess helper, so each test spends most of its wall-clock *waiting* on a
 * spawned child process rather than burning a CPU. `node:test` defaults its
 * file-level concurrency to `os.availableParallelism()` (4 on the standard
 * GitHub-hosted runners), which leaves those cores idle while files block on
 * their children. Measured on a 4-core box, raising concurrency from 4 → 8 cut
 * the suite ~17%; that win lands on every unit matrix leg, including the
 * Windows legs that gate the whole CI run's wall-clock.
 *
 * We oversubscribe to 2× the core count, capped at 12. The cap bounds two
 * things: peak memory (each file runs in its own subprocess under the default
 * per-file isolation) and the number of concurrent per-file IPC channels — the
 * latter is the surface of the intermittent Node deserialize bug documented in
 * AGENTS.md (nodejs/node#56802), so we deliberately do not fan out without
 * bound. The floor of 4 preserves Node's default on single/low-core machines.
 *
 * `node --test` expands the glob pattern itself (Node 21+), so we pass
 * `tests/unit/*.test.ts` literally rather than relying on shell expansion —
 * this keeps the command identical on Windows `cmd`, which does not glob.
 */

import { spawnSync } from "node:child_process";
import { availableParallelism } from "node:os";

const concurrency = Math.min(Math.max(availableParallelism() * 2, 4), 12);

const result = spawnSync(
	process.execPath,
	[
		"--experimental-strip-types",
		"--test",
		`--test-concurrency=${concurrency}`,
		"tests/unit/*.test.ts",
	],
	{ stdio: "inherit" },
);

if (result.error) {
	throw result.error;
}

process.exit(result.status ?? 1);
