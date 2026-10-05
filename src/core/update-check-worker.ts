/**
 * Detached update-check worker, spawned by `startUpdateCheck()`.
 *
 * Usage: node update-check-worker.js <channel>
 *
 * Exits after the check, or at the hard deadline: a DNS lookup or connect
 * that never answers can't be cancelled, so the deadline is what bounds the
 * worker's lifetime. Nothing waits on this process, so exiting is safe.
 */

import { runUpdateCheck, WORKER_FETCH_TIMEOUT_MS } from "./update-check.ts";

setTimeout(() => process.exit(0), WORKER_FETCH_TIMEOUT_MS + 1000);

const channel = process.argv[2];
if (channel) await runUpdateCheck(channel).catch(() => {});
process.exit(0);
