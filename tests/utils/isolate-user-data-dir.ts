/**
 * Test preload (wired via `--import` in the `test:*` npm scripts).
 *
 * Points C8CTL_DATA_DIR at a fresh temp directory before any test module
 * loads, so tests that create, overwrite or delete `profiles.json`,
 * `session.json` or `plugins.json` can never touch the developer's real c8ctl
 * data directory (which would wipe their saved profiles and active-profile
 * selection). An explicitly provided C8CTL_DATA_DIR is respected.
 *
 * `--import` is part of `execArgv`, so `node --test` re-applies this preload in
 * every per-file test subprocess; each gets its own isolated directory.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.C8CTL_DATA_DIR) {
	process.env.C8CTL_DATA_DIR = mkdtempSync(join(tmpdir(), "c8ctl-test-data-"));
}

/**
 * Throw unless C8CTL_DATA_DIR isolates this process from the real user data
 * dir. Call before any test code that deletes or overwrites files in
 * `getUserDataDir()`, so a test run that bypasses the npm scripts (and hence
 * this preload) fails loudly instead of wiping the developer's profiles.
 */
export function assertIsolatedUserDataDir(): void {
	if (!process.env.C8CTL_DATA_DIR) {
		throw new Error(
			"Refusing to modify the real c8ctl user data dir: C8CTL_DATA_DIR is not set. " +
				"Run tests via `npm run test:unit` / `npm run test:integration`, or pass " +
				"`--import ./tests/utils/isolate-user-data-dir.ts`.",
		);
	}
}
