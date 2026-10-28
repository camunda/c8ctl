/**
 * Test preload (wired via `--import` in the `test:*` npm scripts).
 *
 * Points C8CTL_DATA_DIR at a fresh temp directory before any test module
 * loads, so tests that create, overwrite or delete `profiles.json`,
 * `session.json` or `plugins.json` can never touch the developer's real c8ctl
 * data directory (which would wipe their saved profiles and active-profile
 * selection). An inherited C8CTL_DATA_DIR is deliberately overridden: a
 * developer may export it pointing at their persistent c8ctl directory, and
 * honouring it would let destructive test hooks wipe real state.
 *
 * `--import` is part of `execArgv`, so `node --test` re-applies this preload in
 * every per-file test subprocess; each gets its own isolated directory.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

process.env.C8CTL_DATA_DIR = mkdtempSync(join(tmpdir(), "c8ctl-test-data-"));

/**
 * Throw unless C8CTL_DATA_DIR isolates this process from the real user data
 * dir. Call before any test code that deletes or overwrites files in
 * `getUserDataDir()`, so a test run that bypasses the npm scripts (and hence
 * this preload) fails loudly instead of wiping the developer's profiles.
 */
export function assertIsolatedUserDataDir(): void {
	const dir = process.env.C8CTL_DATA_DIR;
	const rel = dir ? relative(resolve(tmpdir()), resolve(dir)) : "";
	if (!dir || rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
		throw new Error(
			`Refusing to modify the c8ctl user data dir: C8CTL_DATA_DIR (${dir ?? "unset"}) ` +
				"is not a directory under the OS temp dir. Run tests via `npm run test:unit` / " +
				"`npm run test:integration`, or pass `--import ./tests/utils/isolate-user-data-dir.ts`.",
		);
	}
}
