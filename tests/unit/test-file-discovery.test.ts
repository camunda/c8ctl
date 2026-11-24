import assert from "node:assert/strict";
import type { Dirent } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, test } from "node:test";
import { listTestFiles } from "../utils/test-files.ts";

const TESTS_DIR = resolve("synthetic-tests");
type Entry = Pick<Dirent, "name" | "isDirectory" | "isFile">;

function entry(name: string, kind: "directory" | "file" | "symlink"): Entry {
	return {
		name,
		isDirectory: () => kind === "directory",
		isFile: () => kind === "file",
	};
}

function syntheticTree(tree: Record<string, Entry[]>) {
	const visited: string[] = [];
	return {
		visited,
		readDirectory(dir: string): Entry[] {
			const path = relative(TESTS_DIR, dir).split(/[\\/]/).join("/");
			visited.push(path);
			const entries = tree[path];
			if (!entries) {
				throw Object.assign(new Error(`Directory does not exist: ${path}`), {
					code: "ENOENT",
				});
			}
			return [...entries];
		},
	};
}

describe("architectural guard test-file discovery", () => {
	test("preserves sorted discovery of real tests at every depth", () => {
		const { readDirectory } = syntheticTree({
			"": [
				entry("unit", "directory"),
				entry("root.test.ts", "file"),
				entry("integration", "directory"),
				entry("fixtures", "directory"),
				entry(".tmp-root.test.ts", "file"),
			],
			unit: [
				entry("z.test.ts", "file"),
				entry("nested", "directory"),
				entry("helper.ts", "file"),
				entry("linked", "symlink"),
				entry(".tmp-tracked", "directory"),
			],
			"unit/.tmp-tracked": [entry("real.test.ts", "file")],
			"unit/nested": [entry("deep", "directory"), entry("a.test.ts", "file")],
			"unit/nested/deep": [entry("b.test.ts", "file")],
			integration: [entry("nested", "directory")],
			"integration/nested": [entry("api.test.ts", "file")],
			fixtures: [
				entry("example.test.ts", "file"),
				entry("process.bpmn", "file"),
			],
		});

		assert.deepEqual(
			listTestFiles({ testsDir: TESTS_DIR, readDirectory }),
			[
				".tmp-root.test.ts",
				"fixtures/example.test.ts",
				"integration/nested/api.test.ts",
				"root.test.ts",
				"unit/.tmp-tracked/real.test.ts",
				"unit/nested/a.test.ts",
				"unit/nested/deep/b.test.ts",
				"unit/z.test.ts",
			].map((path) => join(TESTS_DIR, path)),
		);
	});

	test("does not traverse any root .tmp-* staging tree", () => {
		const { readDirectory, visited } = syntheticTree({
			"": [
				entry(".tmp-hostver-123", "directory"),
				entry(".tmp-plugin-456", "directory"),
				entry(".tmp-other-789", "directory"),
				entry("unit", "directory"),
				entry("integration", "directory"),
			],
			".tmp-hostver-123": [entry("copied.test.ts", "file")],
			".tmp-plugin-456": [entry("nested", "directory")],
			".tmp-plugin-456/nested": [entry("copied.test.ts", "file")],
			".tmp-other-789": [],
			unit: [entry("real.test.ts", "file")],
			integration: [entry("real.test.ts", "file")],
		});

		assert.deepEqual(listTestFiles({ testsDir: TESTS_DIR, readDirectory }), [
			join(TESTS_DIR, "integration", "real.test.ts"),
			join(TESTS_DIR, "unit", "real.test.ts"),
		]);
		assert.deepEqual(visited, ["", "integration", "unit"]);
	});

	test("ignores staging trees already removed after the root listing", () => {
		const { readDirectory, visited } = syntheticTree({
			"": [
				entry(".tmp-hostver-removed", "directory"),
				entry("unit", "directory"),
			],
			unit: [entry("real.test.ts", "file")],
		});

		assert.deepEqual(listTestFiles({ testsDir: TESTS_DIR, readDirectory }), [
			join(TESTS_DIR, "unit", "real.test.ts"),
		]);
		assert.deepEqual(visited, ["", "unit"]);
	});

	test("still propagates discovery errors in real source directories", () => {
		const { readDirectory } = syntheticTree({
			"": [entry("unit", "directory")],
			unit: [entry("missing", "directory")],
		});

		assert.throws(() => listTestFiles({ testsDir: TESTS_DIR, readDirectory }), {
			code: "ENOENT",
		});
	});
});
