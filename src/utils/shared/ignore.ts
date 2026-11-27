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
 * and supports the subset of gitignore-style rules documented below.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import nodePath, {
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
	sep,
} from "node:path";

const DEFAULT_PATTERNS = ["node_modules/", "target/", ".git/"];

const C8IGNORE_FILENAME = ".c8ignore";

/** A compiled set of .c8ignore / default patterns. */
export interface Ignore {
	ignores(path: string): boolean;
}

/** A single gitignore-style line compiled into `path.matchesGlob` globs. */
export interface ParsedPattern {
	negate: boolean;
	globs: string[];
	/** Match only this path entry, not descendants inherited from a directory. */
	entryGlobs: string[];
}

/**
 * Translate a single gitignore-style line into one or more glob patterns
 * suitable for `path.matchesGlob`.
 *
 * Rules applied (subset of gitignore spec). These mirror the behaviour of the
 * `ignore` npm package — see the `c8ignore-parity` regression guard:
 * - Lines starting with `#` and blank lines are skipped.
 * - A leading `!` negates the pattern.
 * - A trailing `/` restricts matching to directories: the pattern matches the
 *   directory entry (a path queried *with* a trailing slash, e.g. `build/`)
 *   and its contents, but NOT a bare path of the same name (`build`), which
 *   gitignore would treat as a file. The directory walker queries directory
 *   entries with a trailing slash, so traversal pruning still works.
 * - A trailing `/**` (e.g. `foo/**`) matches everything *inside* the directory
 *   but not the directory entry itself.
 * - A leading `/` or an embedded `/` anchors the pattern to the base dir.
 * - Otherwise the pattern matches at any depth.
 */
export function parsePattern(raw: string): ParsedPattern | null {
	// Trim trailing whitespace. The full gitignore spec allows a trailing `\ `
	// to preserve spaces, but that edge case is not needed here — we
	// deliberately omit it for simplicity.
	const trimmed = raw.trimEnd();
	if (!trimmed || trimmed.startsWith("#")) return null;

	const negate = trimmed.startsWith("!");
	const withoutNegate = negate ? trimmed.slice(1) : trimmed;

	// A trailing slash restricts the pattern to directories.
	const dirOnly = withoutNegate.endsWith("/");
	const withoutTrailing = withoutNegate.replace(/\/$/, "");
	// A leading / anchors the pattern to the base directory — the slash is a
	// positional marker, not part of the glob itself.
	const pattern = withoutTrailing.replace(/^\//, "");
	if (!pattern) return null;

	// Anchored: a leading slash, or any embedded slash, pins the pattern to the
	// base directory. Otherwise it matches at any depth.
	const anchored = withoutNegate.startsWith("/") || pattern.includes("/");

	let globs: string[];
	let entryGlobs: string[];
	if (dirOnly) {
		// Directory-only (`dir/`): match the directory entry (queried with a
		// trailing slash) and everything under it, but NOT a bare path of the
		// same name. `dir/**` matches `dir/` and `dir/child`, never bare `dir`.
		globs = anchored
			? [`${pattern}/**`]
			: [`${pattern}/**`, `**/${pattern}/**`];
		entryGlobs = anchored
			? [`${pattern}/`]
			: [`${pattern}/`, `**/${pattern}/`];
	} else if (pattern.endsWith("/**")) {
		// Contents-only (`dir/**`): match everything inside the directory but
		// not the directory entry itself.
		const core = pattern.slice(0, -3);
		globs = [`${core}/*`, `${core}/*/**`];
		entryGlobs = [`${core}/*`, `${core}/*/`];
	} else if (anchored) {
		// Anchored entry: match the entry itself (file or directory) and its
		// contents. e.g. `/src`, `src/build`.
		globs = [pattern, `${pattern}/**`];
		entryGlobs = [pattern, `${pattern}/`];
	} else {
		// Unanchored entry: match as a file or directory at any depth.
		// e.g. `*.log` or `target` → the entry and its contents at any depth.
		globs = [pattern, `**/${pattern}`, `${pattern}/**`, `**/${pattern}/**`];
		entryGlobs = [
			pattern,
			`${pattern}/`,
			`**/${pattern}`,
			`**/${pattern}/`,
		];
	}

	return { negate, globs, entryGlobs };
}

/** Whether a project-relative, `/`-separated path matches a parsed pattern. */
export function matchesParsedPattern(
	path: string,
	{ globs }: ParsedPattern,
): boolean {
	return globs.some((g) => matchesGlob(path, g));
}

function matchesPatternEntry(
	path: string,
	{ entryGlobs }: ParsedPattern,
): boolean {
	return entryGlobs.some((g) => matchesGlob(path, g));
}

/**
 * `path.matchesGlob`, looked up at call time. A named import would make Node.js
 * releases without it (<20.17, 22.0–22.4) fail to load the whole CLI, before
 * the unsupported-Node.js warning can print.
 */
export function matchesGlob(path: string, pattern: string): boolean {
	return nodePath.matchesGlob(path, pattern);
}

function buildIgnoreChecker(
	patterns: ParsedPattern[],
): (path: string) => boolean {
	const matchesEntry = matchesPatternEntry;

	// gitignore rule: you cannot re-include a file if a parent directory of
	// that file is excluded. Returns true when any parent directory of `rel` is
	// ignored by the first `upTo` patterns (last-match-wins for ancestors).
	// Ancestors are directories, so they are queried with a trailing slash —
	// otherwise directory-only patterns (`dir/`) would not match them.
	const ancestorIgnored = (rel: string, upTo: number): boolean => {
		const pathSegments = rel.split("/");
		const directorySegments =
			pathSegments.at(-1) === "" ? pathSegments.slice(0, -1) : pathSegments;

		return directorySegments.slice(0, -1).some((_, depth) => {
			const ancestor = `${directorySegments.slice(0, depth + 1).join("/")}/`;
			return patterns
				.slice(0, upTo)
				.reduce(
					(ignored, p) => (matchesEntry(ancestor, p) ? !p.negate : ignored),
					false,
				);
		});
	};

	return (rel: string): boolean => {
		const entryIgnored = patterns.reduce<boolean>((ignored, p, i) => {
			if (!matchesEntry(rel, p)) return ignored;
			if (p.negate) {
				// A negation can only un-ignore a path if no parent directory is
				// currently excluded.
				return ancestorIgnored(rel, i) ? ignored : false;
			}
			return true;
		}, false);

		return entryIgnored || ancestorIgnored(rel, patterns.length);
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
	// Paths outside baseDir can't be ignored.
	// On Windows, when filePath is on a different drive than baseDir,
	// `relative()` returns the absolute path unchanged. `isAbsolute` catches
	// that case alongside the regular "../" guard.
	if (rel === "" || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
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

	const toDir = (p: string): string => {
		const abs = resolve(p);
		try {
			return statSync(abs).isDirectory() ? abs : dirname(abs);
		} catch {
			// Path may not exist yet; use parent directory
			return dirname(abs);
		}
	};

	const dirs = paths.map(toDir);
	if (dirs.length === 1) return dirs[0];

	// Multiple paths: find deepest common ancestor.
	// On Windows, drive letters are case-insensitive (c:\ === C:\),
	// so we compare segments case-insensitively on win32.
	const caseFold =
		process.platform === "win32"
			? (s: string) => s.toLowerCase()
			: (s: string) => s;
	const segments = dirs.map((d) => d.split(sep));

	const common: string[] = [];
	const maxCommonLength = Math.min(...segments.map((s) => s.length));
	for (let i = 0; i < maxCommonLength; i++) {
		const seg = segments[0][i];
		if (!segments.every((s) => caseFold(s[i]) === caseFold(seg))) {
			break;
		}
		common.push(seg);
	}

	if (common.length === 0) return resolve(process.cwd());

	// Normalize filesystem root: on POSIX [''] → '/', on Windows ['C:'] → 'C:\'
	const joined = common.join(sep);
	return joined === "" || joined.endsWith(":") ? resolve(joined + sep) : joined;
}

/**
 * Load "deploy-always" rules from a `.c8ignore` file.
 *
 * Reads only the negation patterns (`!pattern`) and builds a positive
 * matcher from them — stripping the `!` prefix. The resulting `Ignore`
 * matches files that should always be deployed (regardless of the
 * extension allow-list) because the user negated them in `.c8ignore`.
 *
 * Returns `null` when no `.c8ignore` exists or it contains no negation
 * patterns.
 */
export function loadDeployAlwaysRules(baseDir: string): Ignore | null {
	const ignoreFilePath = join(baseDir, C8IGNORE_FILENAME);
	if (!existsSync(ignoreFilePath)) return null;

	const content = readFileSync(ignoreFilePath, "utf-8");
	const positivePatterns: ParsedPattern[] = [];

	for (const raw of content.split("\n")) {
		const trimmed = raw.trimEnd();
		// Parse the full line so `parsePattern` handles comment detection,
		// negation stripping, and anchoring correctly. A manual `!` strip
		// before parsing would mis-classify patterns like `!#file` (the `#`
		// would be treated as a comment after the `!` is removed).
		const parsed = parsePattern(trimmed);
		if (parsed?.negate) {
			positivePatterns.push({ ...parsed, negate: false });
		}
	}

	if (positivePatterns.length === 0) return null;
	return { ignores: buildIgnoreChecker(positivePatterns) };
}
