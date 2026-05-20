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
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import ignore, { type Ignore } from "ignore";

const DEFAULT_PATTERNS = ["node_modules/", "target/", ".git/"];

const C8IGNORE_FILENAME = ".c8ignore";

/**
 * Load ignore rules from the `.c8ignore` file in `baseDir` (if present)
 * merged with built-in default patterns.
 */
export function loadIgnoreRules(baseDir: string): Ignore {
	const ig = ignore().add(DEFAULT_PATTERNS);

	const ignoreFilePath = join(baseDir, C8IGNORE_FILENAME);
	if (existsSync(ignoreFilePath)) {
		const content = readFileSync(ignoreFilePath, "utf-8");
		ig.add(content);
	}

	return ig;
}

/**
 * Load deploy-always rules from `.c8ignore` negation patterns.
 *
 * Lines starting with `!` in `.c8ignore` are treated as "always deploy"
 * overrides. When a file would normally be skipped by extension filtering,
 * it is included if it matches one of these negated patterns.
 *
 * Returns an `Ignore` instance built from the negated patterns (with `!`
 * stripped), so callers can check `deployAlways.ignores(rel)` to see if
 * a file should bypass extension filtering.
 * Returns `null` when no negation patterns exist.
 */
export function loadDeployAlwaysRules(baseDir: string): Ignore | null {
	const ignoreFilePath = join(baseDir, C8IGNORE_FILENAME);
	if (!existsSync(ignoreFilePath)) return null;

	const content = readFileSync(ignoreFilePath, "utf-8");
	const patterns: string[] = [];

	for (const raw of content.split("\n")) {
		const line = raw.trim();
		if (line.startsWith("!") && line.length > 1) {
			// Strip the `!` prefix — the remaining pattern is used to
			// match files that should always be deployed.
			patterns.push(line.slice(1));
		}
	}

	if (patterns.length === 0) return null;
	return ignore().add(patterns);
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
