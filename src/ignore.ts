/**
 * .c8ignore support — filter files/directories using .gitignore-style patterns.
 *
 * Default ignore patterns (always active):
 *   node_modules/
 *   target/
 *   .git/
 *
 * The `.c8ignore` file is resolved from the deploy/watch target directory
 * (via `resolveIgnoreBaseDir`), falling back to `process.cwd()` when no
 * target is specified. See #258.
 *
 * Pattern matching is implemented using `node:path#matchesGlob` (Node ≥ 21)
 * with the same semantics as the gitignore spec, removing the need for the
 * `ignore` npm package.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, matchesGlob, relative, resolve, sep } from "node:path";

const DEFAULT_PATTERNS = ["node_modules/", "target/", ".git/"];

const C8IGNORE_FILENAME = ".c8ignore";

/** A compiled set of .c8ignore / default patterns. */
export interface Ignore {
	ignores(path: string): boolean;
}

interface ParsedPattern {
	negate: boolean;
	globs: string[];
}

/**
 * Translate a single gitignore-style line into one or more glob patterns
 * suitable for `path.matchesGlob`.
 *
 * Rules applied (subset of gitignore spec):
 * - Lines starting with `#` and blank lines are skipped.
 * - A leading `!` negates the pattern.
 * - A trailing `/` restricts matching to directory contents only
 *   (the directory entry itself is not matched — consistent with how the
 *   deploy/watch scanner calls `isIgnored` with trailing-slash paths that
 *   are then stripped by `path.relative`).
 * - A leading `/` or an embedded `/` anchors the pattern to the base dir.
 * - Otherwise the pattern matches at any depth.
 */
function parsePattern(raw: string): ParsedPattern | null {
	// Trim trailing whitespace (leading whitespace is significant in gitignore,
	// but trailing spaces are ignored unless escaped — we just trimEnd).
	let pattern = raw.trimEnd();
	if (!pattern || pattern.startsWith("#")) return null;

	const negate = pattern.startsWith("!");
	if (negate) pattern = pattern.slice(1);
	if (!pattern) return null;

	// Trailing slash: match only contents, not the directory entry itself.
	const trailingSlash = pattern.endsWith("/");
	if (trailingSlash) pattern = pattern.slice(0, -1);
	if (!pattern) return null;

	// Leading slash: pattern is anchored to the base directory.
	const leadingSlash = pattern.startsWith("/");
	if (leadingSlash) pattern = pattern.slice(1);

	const hasEmbeddedSlash = pattern.includes("/");

	let globs: string[];
	if (leadingSlash || hasEmbeddedSlash) {
		// Anchored to root.
		if (trailingSlash) {
			// e.g. `/dist/` → only contents of root `dist/`
			globs = [`${pattern}/**`];
		} else {
			// e.g. `/src` or `src/build` → the entry itself and its contents
			globs = [pattern, `${pattern}/**`];
		}
	} else {
		// Not anchored: match at any depth.
		if (trailingSlash) {
			// e.g. `node_modules/` → contents of any `node_modules` dir, not
			// the directory entry itself (mirrors `ignore` package behaviour).
			globs = [`${pattern}/**`, `**/${pattern}/**`];
		} else {
			// e.g. `*.log` or `target` → the entry and its contents at any depth
			globs = [pattern, `**/${pattern}`, `${pattern}/**`, `**/${pattern}/**`];
		}
	}

	return { negate, globs };
}

function buildIgnoreChecker(
	patterns: ParsedPattern[],
): (path: string) => boolean {
	return function ignoresPath(rel: string): boolean {
		let ignored = false;
		for (const { negate, globs } of patterns) {
			if (globs.some((g) => matchesGlob(rel, g))) {
				ignored = !negate;
			}
		}
		return ignored;
	};
}

/**
 * Load ignore rules from the `.c8ignore` file in `baseDir` (if present)
 * merged with built-in default patterns.
 */
export function loadIgnoreRules(baseDir: string): Ignore {
	const lines = [...DEFAULT_PATTERNS];

	const ignoreFilePath = join(baseDir, C8IGNORE_FILENAME);
	if (existsSync(ignoreFilePath)) {
		const content = readFileSync(ignoreFilePath, "utf-8");
		lines.push(...content.split("\n"));
	}

	const patterns = lines
		.map(parsePattern)
		.filter((p): p is ParsedPattern => p !== null);

	return { ignores: buildIgnoreChecker(patterns) };
}

/**
 * Check whether a path should be ignored.
 *
 * `filePath` must be an absolute path.
 * `baseDir` is the root directory the ignore rules are relative to.
 *
 * Returns `true` when the path matches an ignore rule.
 */
export function isIgnored(
	ig: Ignore,
	filePath: string,
	baseDir: string,
): boolean {
	let rel = relative(baseDir, filePath);
	// `ignore` expects forward-slash separators
	if (sep !== "/") {
		rel = rel.split(sep).join("/");
	}
	// Paths outside baseDir can't be ignored
	if (rel === "" || rel === ".." || rel.startsWith("../")) {
		return false;
	}
	return ig.ignores(rel);
}

/**
 * Determine the base directory for `.c8ignore` lookup from the paths the
 * user passed to `deploy` or `watch`.
 *
 * - Single directory path → use that directory.
 * - Single file path → use its parent directory.
 * - Multiple paths → deepest common ancestor directory.
 * - No paths → fall back to `process.cwd()`.
 *
 * When no target is specified the CLI defaults to `["."]`, so
 * `resolve(".")` === `process.cwd()` — backward-compatible.
 */
export function resolveIgnoreBaseDir(paths: string[]): string {
	if (paths.length === 0) return resolve(process.cwd());

	const dirs = paths.map((p) => {
		const abs = resolve(p);
		try {
			return statSync(abs).isDirectory() ? abs : dirname(abs);
		} catch {
			// Path may not exist yet; use parent directory
			return dirname(abs);
		}
	});

	if (dirs.length === 1) return dirs[0];

	// Multiple paths: find deepest common ancestor.
	// On Windows, drive letters are case-insensitive (c:\ === C:\),
	// so we compare segments case-insensitively on win32.
	const caseFold =
		process.platform === "win32"
			? (s: string) => s.toLowerCase()
			: (s: string) => s;
	const segments = dirs.map((d) => d.split(sep));
	const minLen = Math.min(...segments.map((s) => s.length));
	const common: string[] = [];
	for (let i = 0; i < minLen; i++) {
		if (segments.every((s) => caseFold(s[i]) === caseFold(segments[0][i]))) {
			common.push(segments[0][i]);
		} else {
			break;
		}
	}

	if (common.length === 0) return resolve(process.cwd());

	// Normalize filesystem root: on POSIX [''] → '/', on Windows ['C:'] → 'C:\'
	const joined = common.join(sep);
	return joined === "" || joined.endsWith(":") ? resolve(joined + sep) : joined;
}
