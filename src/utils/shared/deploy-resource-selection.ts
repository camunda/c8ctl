/**
 * `deployResources` — descriptor-based selection of a project's resources.
 *
 * The optional top-level `deployResources` array in `camunda.json` selects
 * which project files are deployed (and watched with `watch --project`).
 *
 * Patterns use the same engine and syntax as `.c8ignore` (`parsePattern`
 * from `ignore.ts`, evaluated with `node:path#matchesGlob` relative to the
 * project root with `/` separators), with two deliberate differences:
 *
 * - **Inverted polarity.** Selection starts empty; a positive pattern
 *   selects, a `!` pattern deselects, and the last matching pattern wins
 *   per file.
 * - **Direct descendant selection.** There is no gitignore "excluded
 *   parent" rule: a later positive pattern restores a file below an
 *   earlier excluded directory. The directory walk therefore never prunes
 *   a directory because a negative pattern matched it — it only skips a
 *   directory when no positive pattern can match anything below it.
 *
 * Defaults: `node_modules/`, `target/`, `.git/` and the project-root
 * `camunda.json` are evaluated as implicit leading `!` patterns, so any
 * later positive pattern that matches a file inside them overrides them.
 *
 * Hidden files: the engine's wildcards (`*`, `?`, `**`, `[...]`) never
 * match a path segment that starts with `.`. A pattern selects a
 * dot-prefixed file — or anything inside a dot-prefixed directory — only
 * when it names that segment explicitly (e.g. `resources/.prompt.md`,
 * `.config/**`). The walker still descends into hidden directories so
 * such explicit patterns can reach them.
 */

import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, matchesGlob } from "node:path";
import { isRecord, normalizeToError } from "../../core/index.ts";
import {
	CAMUNDA_PROJECT_FILE,
	type CamundaProject,
	decodeCamundaJson,
	parseCamundaJson,
	readCamundaProject,
} from "./camunda-json.ts";
import {
	matchesParsedPattern,
	type ParsedPattern,
	parsePattern,
} from "./ignore.ts";

/** Name of the descriptor field. */
export const DEPLOY_RESOURCES_FIELD = "deployResources";

/**
 * Default exclusions, applied as implicit leading negations before the
 * user's patterns. The root descriptor is anchored; the directories match
 * at any depth (same as the `.c8ignore` defaults).
 */
export const DEPLOY_RESOURCES_DEFAULT_EXCLUSIONS: readonly string[] = [
	"node_modules/",
	"target/",
	".git/",
	"/camunda.json",
];

/** Tool-agnostic error codes, shared with the parity fixtures. */
export type DeployResourcesErrorCode = "invalid-config" | "empty-selection";

/**
 * Raised for an invalid `deployResources` configuration or an empty final
 * selection. `code` matches the `error` value used by the shared parity
 * fixtures.
 */
export class DeployResourcesError extends Error {
	readonly code: DeployResourcesErrorCode;
	constructor(code: DeployResourcesErrorCode, message: string) {
		super(message);
		this.name = "DeployResourcesError";
		this.code = code;
	}
}

/** Describe why a single pattern is invalid, or `null` when it is valid. */
function patternProblem(pattern: string): string | null {
	// Validate what the matcher sees: `parsePattern` trims trailing
	// whitespace, so `resources/.. ` must be checked as `resources/..`.
	const trimmed = pattern.trimEnd();
	const body = trimmed.startsWith("!") ? trimmed.slice(1) : trimmed;
	if (body.trim() === "") {
		return "patterns must not be empty";
	}
	if (trimmed.startsWith("#")) {
		return "comments are not supported in deployResources";
	}
	// A single leading `/` is the gitignore root anchor (same as .c8ignore),
	// not an absolute path. Absolute paths that cannot be anchors are
	// invalid: a Windows drive letter, a UNC root (`//server`, `\\server`)
	// or any leading backslash.
	if (
		/^[A-Za-z]:/.test(body) ||
		body.startsWith("//") ||
		body.startsWith("\\")
	) {
		return "patterns are relative to the project root; drive-letter, UNC and backslash-rooted paths are not allowed (a leading / anchors the pattern to the project root)";
	}
	if (body.split(/[/\\]/).includes("..")) {
		return "patterns must stay inside the project; '..' is not allowed";
	}
	if (parsePattern(pattern) === null) {
		return "pattern does not select anything";
	}
	return null;
}

/**
 * Validate the raw `deployResources` value read from `camunda.json`.
 *
 * @param value - The raw field value (`CamundaProject.deployResources`).
 * @param source - Descriptor path used in error messages.
 * @returns The validated pattern list (possibly empty).
 * @throws {DeployResourcesError} `invalid-config` when the value is not an
 *   array of valid pattern strings.
 */
export function parseDeployResources(
	value: unknown,
	source = "camunda.json",
): string[] {
	if (!Array.isArray(value)) {
		throw new DeployResourcesError(
			"invalid-config",
			`Invalid "${DEPLOY_RESOURCES_FIELD}" in ${source}: expected an array of glob strings, ` +
				`got ${value === null ? "null" : typeof value}. ` +
				`Example: "${DEPLOY_RESOURCES_FIELD}": ["resources/**"]`,
		);
	}
	return value.map((entry, index) => {
		if (typeof entry !== "string") {
			throw new DeployResourcesError(
				"invalid-config",
				`Invalid "${DEPLOY_RESOURCES_FIELD}" in ${source}: entry ${index} must be a string, ` +
					`got ${entry === null ? "null" : typeof entry}`,
			);
		}
		const problem = patternProblem(entry);
		if (problem) {
			throw new DeployResourcesError(
				"invalid-config",
				`Invalid "${DEPLOY_RESOURCES_FIELD}" pattern ${JSON.stringify(entry)} in ${source}: ${problem}`,
			);
		}
		return entry;
	});
}

/**
 * Strictly read the `camunda.json` descriptor of a directory that is being
 * resolved for deployment or watching.
 *
 * Unlike `readCamundaProject` (lenient marker detection), a descriptor
 * that exists but cannot be read — a directory named `camunda.json`, no
 * permission, an I/O error — is an `invalid-config` error. Degrading to
 * "no descriptor" would silently fall back to the default scan and
 * bypass a `deployResources` allowlist.
 *
 * @returns The parsed descriptor, or `null` only when no `camunda.json`
 *   exists.
 * @throws {DeployResourcesError} `invalid-config` when the file exists but
 *   cannot be read.
 * @throws {Error} When `camunda.json` is not valid JSON.
 */
export function readProjectDescriptor(dirPath: string): CamundaProject | null {
	const file = join(dirPath, CAMUNDA_PROJECT_FILE);
	let buffer: Buffer;
	try {
		buffer = readFileSync(file);
	} catch (error) {
		const code = isRecord(error) ? error.code : undefined;
		if (code === "ENOENT" || code === "ENOTDIR") return null;
		throw new DeployResourcesError(
			"invalid-config",
			`Failed to read ${file}: ${normalizeToError(error).message}`,
		);
	}
	return parseCamundaJson(decodeCamundaJson(buffer), file);
}

/** Outcome of reading a project's `deployResources` configuration. */
export type DeployResourcesState =
	| { kind: "no-descriptor" }
	| { kind: "no-field" }
	| { kind: "patterns"; patterns: string[] };

/**
 * Read a project's `deployResources` state, distinguishing a missing
 * descriptor from a descriptor without the field.
 *
 * @throws {DeployResourcesError} `invalid-config` when the descriptor
 *   cannot be read or the field is invalid.
 * @throws {Error} When `camunda.json` is not valid JSON.
 */
export function readDeployResourcesState(
	projectRoot: string,
): DeployResourcesState {
	const project = readProjectDescriptor(projectRoot);
	if (!project) return { kind: "no-descriptor" };
	if (!Object.hasOwn(project, DEPLOY_RESOURCES_FIELD)) {
		return { kind: "no-field" };
	}
	return {
		kind: "patterns",
		patterns: parseDeployResources(
			project.deployResources,
			join(projectRoot, CAMUNDA_PROJECT_FILE),
		),
	};
}

/**
 * Read the validated `deployResources` patterns of the project rooted at
 * `projectRoot`.
 *
 * @returns The patterns, or `null` when there is no descriptor or the
 *   descriptor has no `deployResources` key (default scan applies).
 * @throws {Error} When `camunda.json` is not valid JSON.
 * @throws {DeployResourcesError} `invalid-config` when the descriptor
 *   cannot be read or the field is invalid.
 */
export function readDeployResources(projectRoot: string): string[] | null {
	const state = readDeployResourcesState(projectRoot);
	return state.kind === "patterns" ? state.patterns : null;
}

/**
 * Lenient presence check: whether the project's descriptor declares a
 * `deployResources` key at all, without validating it. Never throws.
 */
export function declaresDeployResources(projectRoot: string): boolean {
	try {
		const project = readCamundaProject(projectRoot);
		return project !== null && Object.hasOwn(project, DEPLOY_RESOURCES_FIELD);
	} catch {
		return false;
	}
}

/** A compiled `deployResources` pattern list. */
export interface ResourceSelector {
	/** The user's patterns, in order. */
	readonly patterns: readonly string[];
	/** Whether the project-relative file path is selected. */
	selects(relPath: string): boolean;
	/**
	 * Whether any file below the project-relative directory could be
	 * selected. Conservative: `true` whenever a positive pattern might
	 * match below `relDir`. Used only to skip walking directories that can
	 * never contribute (e.g. `.git/` under `["**\/*"]`).
	 */
	couldSelectUnder(relDir: string): boolean;
}

/**
 * Whether glob `segments` could match some path strictly below the
 * directory `dirSegments`. Mirrors the engine's segment semantics: `**`
 * spans zero or more segments but never a dot-prefixed one.
 */
function globCouldMatchBelow(
	dirSegments: readonly string[],
	globSegments: readonly string[],
): boolean {
	const step = (d: number, g: number): boolean => {
		if (d === dirSegments.length) return g < globSegments.length;
		if (g === globSegments.length) return false;
		const seg = globSegments[g];
		if (seg === "**") {
			return (
				step(d, g + 1) || (!dirSegments[d].startsWith(".") && step(d + 1, g))
			);
		}
		return matchesGlob(dirSegments[d], seg) && step(d + 1, g + 1);
	};
	return step(0, 0);
}

/**
 * Compile validated `deployResources` patterns into a selector.
 * Call {@link parseDeployResources} first to validate raw input.
 */
export function compileDeployResources(
	patterns: readonly string[],
): ResourceSelector {
	const defaults = DEPLOY_RESOURCES_DEFAULT_EXCLUSIONS.map((p) =>
		parsePattern(`!${p}`),
	).filter((p): p is ParsedPattern => p !== null);
	const user = patterns
		.map(parsePattern)
		.filter((p): p is ParsedPattern => p !== null);
	const ordered = [...defaults, ...user];
	const positiveGlobs = user.filter((p) => !p.negate).flatMap((p) => p.globs);

	return {
		patterns: [...patterns],
		selects: (relPath) =>
			ordered.reduce<boolean>(
				(selected, p) =>
					matchesParsedPattern(relPath, p) ? !p.negate : selected,
				false,
			),
		couldSelectUnder: (relDir) => {
			const dirSegments = relDir.split("/").filter(Boolean);
			return positiveGlobs.some(
				(glob) =>
					// Braces and extglobs can hide a `/` inside a group, so a
					// per-segment check is not reliable — walk conservatively.
					/[{}()]/.test(glob) ||
					// Empty (`a//b`) and `.` (`a/./b`) segments are dropped, as
					// the native matcher collapses them. Dropping more than the
					// matcher does only makes pruning more conservative.
					globCouldMatchBelow(
						dirSegments,
						glob.split("/").filter((seg) => seg !== "" && seg !== "."),
					),
			);
		},
	};
}

/**
 * Walk `projectRoot` and return the project-relative (`/`-separated)
 * paths of every file the selector selects, sorted.
 *
 * - Symlinks are followed (same as the default deploy discovery). A
 *   directory reachable under several project-relative paths (a symlink
 *   alias and its real path) is walked under each of them, because
 *   patterns are evaluated against the project-relative path. Cycles are
 *   cut by skipping a directory whose real path is already on the
 *   current descent (an active ancestor). Files that resolve to the same
 *   real path are kept once (first path in sorted order wins).
 * - Hidden files and directories are not skipped by the walker — the
 *   pattern engine decides (see module docs).
 * - Nested `camunda.json` folders are ordinary folders here: nested
 *   projects are unsupported and are not excluded from the selection.
 */
export function selectProjectFiles(
	projectRoot: string,
	selector: ResourceSelector,
): string[] {
	const selected: string[] = [];
	// Real paths of the directories on the current descent.
	const activeAncestors = new Set<string>();

	const visit = (dirAbs: string, relDir: string): void => {
		let real = dirAbs;
		try {
			real = realpathSync(dirAbs);
		} catch {
			return;
		}
		if (activeAncestors.has(real)) return;
		activeAncestors.add(real);

		for (const entry of readdirSync(dirAbs).sort()) {
			const abs = join(dirAbs, entry);
			const rel = relDir ? `${relDir}/${entry}` : entry;
			let stat: ReturnType<typeof statSync>;
			try {
				stat = statSync(abs);
			} catch {
				// Broken symlink or a file removed mid-walk.
				continue;
			}
			if (stat.isDirectory()) {
				if (selector.couldSelectUnder(rel)) visit(abs, rel);
			} else if (stat.isFile() && selector.selects(rel)) {
				selected.push(rel);
			}
		}
		activeAncestors.delete(real);
	};
	visit(projectRoot, "");

	const seenReal = new Set<string>();
	return selected.sort().filter((rel) => {
		let key = rel;
		try {
			key = realpathSync(join(projectRoot, rel));
		} catch {
			// Best effort: fall back to the relative path.
		}
		if (seenReal.has(key)) return false;
		seenReal.add(key);
		return true;
	});
}

/**
 * Resolve the deployed resource set of a project from its validated
 * `deployResources` patterns.
 *
 * @throws {DeployResourcesError} `empty-selection` when nothing is
 *   selected (an unmatched pattern alone is silently ignored).
 */
export function resolveDeployResources(
	projectRoot: string,
	patterns: readonly string[],
): string[] {
	const files = selectProjectFiles(
		projectRoot,
		compileDeployResources(patterns),
	);
	if (files.length === 0) {
		throw new DeployResourcesError(
			"empty-selection",
			`No deployable files found: "${DEPLOY_RESOURCES_FIELD}" in ${join(projectRoot, CAMUNDA_PROJECT_FILE)} ` +
				"selects no files. Adjust the patterns so they match at least one project file.",
		);
	}
	return files;
}
