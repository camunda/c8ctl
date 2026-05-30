/**
 * Regression guard: `.gitignore` pattern parity for the ignore module.
 *
 * Background
 * ----------
 * `src/ignore.ts` is the single place that decides which files `deploy` and
 * `watch` skip. It is the project's interpretation of `.gitignore` semantics.
 * This suite pins that interpretation against the canonical gitignore rules so
 * that any reimplementation of the matcher (for example, replacing the
 * `ignore` npm package with a hand-rolled `node:path#matchesGlob` matcher) is
 * forced to preserve the observable contract — or to surface, explicitly and
 * for review, exactly where it diverges.
 *
 * The expected values below were derived from the canonical gitignore
 * reference semantics (as implemented by the `ignore` package) and are encoded
 * here as a fixed, self-contained table. The suite has NO runtime dependency
 * on the `ignore` package, so it keeps working even after that dependency is
 * removed.
 *
 * Two layers are guarded:
 *   1. The raw matcher — `loadIgnoreRules(dir).ignores(relPath)` — across a
 *      broad battery of gitignore constructs (anchoring, directory-only
 *      patterns, globs, globstar, character classes, `?`, negation, comments).
 *   2. The functional contract — `isIgnored(ig, absPath, baseDir)` — for the
 *      file-level outcomes that `deploy`/`watch` actually rely on.
 *
 * Notes on directory-only patterns
 * ---------------------------------
 * A trailing-slash pattern such as `build/` matches a *directory* named
 * `build`. The string matcher cannot know whether the bare path `"build"`
 * refers to a file or a directory, so — like the `ignore` package — it treats
 * a path WITHOUT a trailing slash as a file and does NOT match it against a
 * directory-only pattern. `"build/"` (with the trailing slash) and anything
 * beneath it (`"build/o.js"`) DO match. This is the most subtle area of
 * gitignore parity and is covered explicitly below.
 */

import assert from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { isIgnored, loadIgnoreRules } from "../../src/ignore.ts";

/**
 * A single parity case: a `.c8ignore` rule set plus the expected
 * `ignores()` verdict for a list of relative paths.
 */
interface MatcherCase {
	readonly name: string;
	readonly patterns: readonly string[];
	readonly expect: ReadonlyArray<readonly [path: string, ignored: boolean]>;
}

/**
 * Canonical gitignore expectations. Each tuple is `[relativePath, ignored]`.
 * These values are the reference gitignore semantics and must hold for any
 * matcher implementation that claims `.gitignore` parity.
 */
const MATCHER_CASES: readonly MatcherCase[] = [
	{
		name: "built-in defaults (no .c8ignore file content)",
		patterns: [],
		expect: [
			["node_modules/x", true],
			["target/y", true],
			[".git/HEAD", true],
			["src/a.bpmn", false],
			["a.bpmn", false],
			// Bare directory name without trailing slash is treated as a file.
			["node_modules", false],
			["node_modules/", true],
		],
	},
	{
		name: "directory-only pattern (build/)",
		patterns: ["build/"],
		expect: [
			["build", false],
			["build/", true],
			["build/o.js", true],
			["nested/build", false],
			["nested/build/", true],
			["nested/build/o.js", true],
			// A *file* named build.txt is unrelated to the directory pattern.
			["build.txt", false],
		],
	},
	{
		name: "anchored directory-only pattern (/dist/)",
		patterns: ["/dist/"],
		expect: [
			["dist", false],
			["dist/", true],
			["dist/o.js", true],
			// Anchored: only matches at the root, not in a nested directory.
			["nested/dist", false],
			["nested/dist/", false],
		],
	},
	{
		name: "embedded-slash pattern is anchored (src/build)",
		patterns: ["src/build"],
		expect: [
			["src/build", true],
			["src/build/", true],
			["src/build/o.js", true],
			["nested/src/build", false],
			["x/src/build/o.js", false],
		],
	},
	{
		name: "extension glob (*.log)",
		patterns: ["*.log"],
		expect: [
			["a.log", true],
			["sub/b.log", true],
			["sub/deep/c.log", true],
			["a.txt", false],
		],
	},
	{
		name: "leading globstar (**/temp-*.bpmn)",
		patterns: ["**/temp-*.bpmn"],
		expect: [
			// Leading **/ also matches at zero depth.
			["temp-x.bpmn", true],
			["sub/temp-y.bpmn", true],
			["main.bpmn", false],
		],
	},
	{
		name: "negation re-includes a specific file",
		patterns: ["*.draft.bpmn", "!important.draft.bpmn"],
		expect: [
			["a.draft.bpmn", true],
			["important.draft.bpmn", false],
			["sub/important.draft.bpmn", false],
			["sub/x.draft.bpmn", true],
		],
	},
	{
		name: "negation cannot re-include inside an ignored directory",
		patterns: ["logs/", "!logs/keep.txt"],
		expect: [
			["logs", false],
			["logs/", true],
			["logs/a.txt", true],
			// gitignore rule: a file cannot be re-included if its parent
			// directory is excluded — the negation has no effect here.
			["logs/keep.txt", true],
		],
	},
	{
		name: "single-level wildcard directory (foo/*)",
		patterns: ["foo/*"],
		expect: [
			["foo/a", true],
			["foo/a/b", true],
			["foo", false],
			["foo/", false],
		],
	},
	{
		name: "globstar directory (foo/**)",
		patterns: ["foo/**"],
		expect: [
			["foo/a", true],
			["foo/a/b", true],
			["foo", false],
			["foo/", false],
		],
	},
	{
		name: "middle globstar (a/**/b)",
		patterns: ["a/**/b"],
		expect: [
			["a/b", true],
			["a/x/b", true],
			["a/x/y/b", true],
			// Once a/.../b matches, everything beneath it is ignored too.
			["a/b/c", true],
		],
	},
	{
		name: "single-character wildcard (?oo.bpmn)",
		patterns: ["?oo.bpmn"],
		expect: [
			["foo.bpmn", true],
			// ? matches exactly one character.
			["fooo.bpmn", false],
			["sub/foo.bpmn", true],
		],
	},
	{
		name: "character class ([abc].bpmn)",
		patterns: ["[abc].bpmn"],
		expect: [
			["a.bpmn", true],
			["d.bpmn", false],
			["sub/b.bpmn", true],
		],
	},
	{
		name: "comments and blank lines are ignored",
		patterns: ["#comment", "  ", "real.bpmn"],
		expect: [
			["real.bpmn", true],
			// The "#comment" line is a comment, not a pattern.
			["comment", false],
		],
	},
	{
		name: "non-directory pattern matches files and directories (foo)",
		patterns: ["foo", "!foo/bar"],
		expect: [
			["foo", true],
			["foo/", true],
			// Parent excluded → negation of a child has no effect.
			["foo/bar", true],
			["foo/baz", true],
		],
	},
	{
		name: "bare name matches at any depth, as file or directory (build)",
		patterns: ["build"],
		expect: [
			["build", true],
			["build/", true],
			["build/x", true],
			["x/build", true],
			["x/build/y", true],
			["build.txt", false],
		],
	},
	{
		name: "root-anchored glob (/*.bpmn)",
		patterns: ["/*.bpmn"],
		expect: [
			["a.bpmn", true],
			["sub/b.bpmn", false],
		],
	},
	{
		name: "non-anchored directory-only pattern matches at any depth (sub/)",
		patterns: ["sub/"],
		expect: [
			["sub", false],
			["sub/", true],
			["sub/a", true],
			["x/sub", false],
			["x/sub/", true],
			["x/sub/a", true],
		],
	},
];

describe(".c8ignore — .gitignore matcher parity (regression guard)", () => {
	let workDir: string;

	beforeEach(() => {
		workDir = mkdtempSync(join(tmpdir(), "c8ignore-parity-"));
	});

	afterEach(() => {
		rmSync(workDir, { recursive: true, force: true });
	});

	for (const { name, patterns, expect } of MATCHER_CASES) {
		test(name, () => {
			writeFileSync(
				join(workDir, ".c8ignore"),
				patterns.length > 0 ? `${patterns.join("\n")}\n` : "",
			);
			const ig = loadIgnoreRules(workDir);
			for (const [relPath, ignored] of expect) {
				assert.strictEqual(
					ig.ignores(relPath),
					ignored,
					`patterns ${JSON.stringify(patterns)} → ignores(${JSON.stringify(relPath)}) ` +
						`expected ${ignored} but got ${ig.ignores(relPath)}`,
				);
			}
		});
	}
});

describe(".c8ignore — isIgnored() functional contract for deploy/watch", () => {
	let baseDir: string;

	beforeEach(() => {
		baseDir = mkdtempSync(join(tmpdir(), "c8ignore-iso-"));
		writeFileSync(
			join(baseDir, ".c8ignore"),
			`${["build/", "logs/", "*.log", "!logs/keep.txt"].join("\n")}\n`,
		);
		mkdirSync(join(baseDir, "build"));
		mkdirSync(join(baseDir, "logs"));
		mkdirSync(join(baseDir, "src"));
		mkdirSync(join(baseDir, "node_modules"));
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	/**
	 * Files inside ignored directories, files matched by a glob, and files
	 * that escaped negation are the outcomes `deploy`/`watch` depend on.
	 * These must remain stable across any matcher reimplementation.
	 */
	const fileExpectations: ReadonlyArray<
		readonly [label: string, segments: readonly string[], ignored: boolean]
	> = [
		["file inside build/ is ignored", ["build", "o.js"], true],
		["file inside logs/ is ignored", ["logs", "a.txt"], true],
		["negation blocked by ignored parent dir", ["logs", "keep.txt"], true],
		["glob-matched file is ignored", ["a.log"], true],
		["file inside node_modules/ is ignored", ["node_modules", "x.bpmn"], true],
		["normal source file is not ignored", ["src", "a.bpmn"], false],
	];

	for (const [label, segments, ignored] of fileExpectations) {
		test(label, () => {
			const ig = loadIgnoreRules(baseDir);
			const abs = join(baseDir, ...segments);
			assert.strictEqual(isIgnored(ig, abs, baseDir), ignored);
		});
	}

	test("paths outside the base directory are never ignored", () => {
		const ig = loadIgnoreRules(baseDir);
		assert.strictEqual(
			isIgnored(ig, join(baseDir, "..", "a.log"), baseDir),
			false,
		);
		assert.strictEqual(
			isIgnored(ig, "/some/other/root/build/o.js", baseDir),
			false,
		);
	});

	test("the base directory itself is never ignored", () => {
		const ig = loadIgnoreRules(baseDir);
		assert.strictEqual(isIgnored(ig, baseDir, baseDir), false);
	});
});
