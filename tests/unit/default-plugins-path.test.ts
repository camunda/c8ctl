/**
 * Regression guard: default-plugins directory resolution (issue #414 fallout).
 *
 * The plugin loader lives at `src/framework/plugin-loader.ts` (dev) and
 * `dist/framework/plugin-loader.js` (production). It must resolve the
 * bundled default plugins relative to its own location:
 *
 *   - dev  (`src/framework/`)  → `<repo>/default-plugins`      (two levels up)
 *   - prod (`dist/framework/`) → `<repo>/dist/default-plugins` (one level up)
 *
 * The unit + integration suites always run from the TS sources (dev
 * layout), so a wrong *production* depth would never surface at test
 * time — only in a published `dist/` run, where the TS `default-plugins/`
 * sources are not shipped. This test pins the production-layout result
 * explicitly so the depth cannot silently regress again.
 */

import assert from "node:assert";
import { join } from "node:path";
import { describe, test } from "node:test";
import { defaultPluginsCandidateDirs } from "../../src/framework/plugin-loader.ts";

describe("default-plugins path resolution", () => {
	test("production layout resolves into dist/default-plugins", () => {
		const distLoaderDir = join("/opt", "app", "dist", "framework");
		const candidates = defaultPluginsCandidateDirs(distLoaderDir);

		const expected = join("/opt", "app", "dist", "default-plugins");
		assert.ok(
			candidates.includes(expected),
			`Production candidates must include ${expected}; got ${JSON.stringify(candidates)}`,
		);
		// The first (production) candidate must be the dist path, and must
		// NOT collapse to <repo>/default-plugins (the dev/source location
		// that is absent from a published package).
		assert.strictEqual(candidates[0], expected);
		assert.notStrictEqual(
			candidates[0],
			join("/opt", "app", "default-plugins"),
		);
	});

	test("development layout resolves into <repo>/default-plugins", () => {
		const srcLoaderDir = join("/opt", "app", "src", "framework");
		const candidates = defaultPluginsCandidateDirs(srcLoaderDir);

		const expected = join("/opt", "app", "default-plugins");
		assert.ok(
			candidates.includes(expected),
			`Development candidates must include ${expected}; got ${JSON.stringify(candidates)}`,
		);
	});

	test("returns production candidate before development candidate", () => {
		const distLoaderDir = join("/opt", "app", "dist", "framework");
		const candidates = defaultPluginsCandidateDirs(distLoaderDir);

		assert.strictEqual(candidates.length, 2);
		assert.strictEqual(
			candidates[0],
			join("/opt", "app", "dist", "default-plugins"),
		);
		assert.strictEqual(candidates[1], join("/opt", "app", "default-plugins"));
	});
});
