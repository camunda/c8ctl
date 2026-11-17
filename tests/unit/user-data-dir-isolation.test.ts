/**
 * Guard: the test suites must never touch the developer's real c8ctl data
 * directory. Several tests (and the suite setup) create, overwrite and delete
 * `profiles.json`, `session.json` and `plugins.json`. Without isolation these
 * operations hit the real per-user directory and silently wipe saved profiles
 * and the active-profile selection on any machine that runs `npm test`.
 *
 * The test scripts preload `tests/utils/isolate-user-data-dir.ts`, which points
 * C8CTL_DATA_DIR at a throwaway temp directory. This guard fails if that
 * preload is ever dropped from a test script.
 */

import assert from "node:assert";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, relative } from "node:path";
import { describe, test } from "node:test";
import { getUserDataDir } from "../../src/core/config.ts";

const isInside = (child: string, parent: string): boolean => {
	const rel = relative(realpathSync(parent), realpathSync(child));
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

describe("test-suite user data dir isolation", () => {
	test("C8CTL_DATA_DIR is set for the test process", () => {
		assert.ok(
			process.env.C8CTL_DATA_DIR,
			"C8CTL_DATA_DIR must be set by the test preload so tests cannot touch the real user data dir",
		);
	});

	test("the resolved user data dir is a fresh preload-created temp dir", () => {
		const dir = getUserDataDir();
		// Only the temp-dir containment is checked (not "outside home"): on
		// Windows the OS temp dir normally lives under the user's home.
		assert.ok(
			isInside(dir, tmpdir()),
			`user data dir ${dir} must live under ${tmpdir()}`,
		);
		assert.ok(
			basename(dir).startsWith("c8ctl-test-data-"),
			`user data dir ${dir} must be the preload-created dir, not an inherited override`,
		);
	});
});
