/**
 * Regression guard for the test harness itself: `makeTestEnv` must isolate
 * `C8CTL_MODELER_DIR` so ambient Camunda Desktop Modeler connections cannot
 * leak into hermetic tests.
 *
 * Failure mode this guards: on a developer machine with Desktop Modeler
 * installed, `getAllProfiles()` merged the real machine-global Modeler
 * connections (e.g. `modeler:c8run`) into every integration test's temp data
 * dir, silently adding a second profile that broke profile-sensitive commands
 * like `deploy` locally while passing in CI (no Modeler installed).
 */

import assert from "node:assert";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { loadModelerConnections } from "../../src/core/config.ts";
import { makeTestEnv } from "../utils/mocks.ts";

describe("makeTestEnv Modeler isolation", () => {
	const original = process.env.C8CTL_MODELER_DIR;

	afterEach(() => {
		if (original === undefined) {
			delete process.env.C8CTL_MODELER_DIR;
		} else {
			process.env.C8CTL_MODELER_DIR = original;
		}
	});

	test("defaults C8CTL_MODELER_DIR to an isolated dir with no settings.json", () => {
		const env = makeTestEnv();
		const dir = env.C8CTL_MODELER_DIR;
		assert.ok(dir, "C8CTL_MODELER_DIR should be set by default");
		assert.ok(existsSync(dir), "the isolated Modeler dir should exist");
		assert.ok(
			!existsSync(join(dir, "settings.json")),
			"the isolated Modeler dir must not contain a Modeler settings.json",
		);
	});

	test("the isolated dir yields zero Modeler connections", () => {
		process.env.C8CTL_MODELER_DIR = makeTestEnv().C8CTL_MODELER_DIR;
		assert.deepStrictEqual(
			loadModelerConnections(),
			[],
			"no ambient Modeler connections may leak through the isolated dir",
		);
	});

	test("an explicit override wins over the isolated default", () => {
		const env = makeTestEnv({ C8CTL_MODELER_DIR: "/custom/modeler/path" });
		assert.strictEqual(env.C8CTL_MODELER_DIR, "/custom/modeler/path");
	});

	test("a pre-set process.env value wins over the isolated default", () => {
		process.env.C8CTL_MODELER_DIR = "/ambient/modeler/path";
		const env = makeTestEnv();
		assert.strictEqual(env.C8CTL_MODELER_DIR, "/ambient/modeler/path");
	});
});
