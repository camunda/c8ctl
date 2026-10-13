/**
 * Guard for scripts/shard-test-files.ts, which splits the integration suite
 * across CI jobs: every test file must run in exactly one shard, otherwise a
 * test would silently never run (or run twice).
 */

import assert from "node:assert";
import { resolve } from "node:path";
import { describe, test } from "node:test";
import { assignShards, listTestFiles } from "../../scripts/shard-test-files.ts";

const INTEGRATION_DIR = resolve(import.meta.dirname, "..", "integration");

describe("shard-test-files", () => {
	const files = listTestFiles(INTEGRATION_DIR);

	test("finds the integration test files", () => {
		assert.ok(files.length > 0);
		assert.ok(files.every((name) => name.endsWith(".test.ts")));
	});

	for (const total of [1, 2, 3, 4]) {
		test(`${total} shard(s) cover every file exactly once`, () => {
			const shards = assignShards(files, total);
			assert.strictEqual(shards.length, total);
			assert.deepStrictEqual([...shards.flat()].sort(), files);
		});
	}

	test("assignment is deterministic", () => {
		assert.deepStrictEqual(assignShards(files, 3), assignShards(files, 3));
	});

	test("an unweighted new file is assigned to exactly one shard", () => {
		const withNew = [...files, "brand-new-feature.test.ts"];
		const shards = assignShards(withNew, 3);
		assert.strictEqual(
			shards.filter((shard) => shard.includes("brand-new-feature.test.ts"))
				.length,
			1,
		);
	});
});
