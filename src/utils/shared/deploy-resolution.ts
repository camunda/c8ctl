/**
 * Deploy resource resolution: which files a deploy of the given paths
 * sends. Every host (CLI `deploy` and `watch`, embedders) resolves the same
 * set through these functions.
 *
 * Reads no runtime state and writes no output. Messages for the user go
 * through the `notify` callback; errors are `C8ctlError`s.
 */

import {
	existsSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
} from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { C8ctlError } from "../../core/index.ts";
import {
	CAMUNDA_PROJECT_FILE,
	type CamundaProject,
	PROCESS_APPLICATION_FILE,
	readCamundaProject,
} from "./camunda-json.ts";
import {
	DEPLOY_RESOURCES_FIELD,
	deployResourcesStateOf,
	readProjectDescriptor,
	resolveDeployResources,
	unreadablePath,
} from "./deploy-resource-selection.ts";
import {
	type Ignore,
	isIgnored,
	loadDeployAlwaysRules,
	loadIgnoreRules,
	resolveIgnoreBaseDir,
} from "./ignore.ts";
import { DEPLOYABLE_EXTENSIONS } from "./resource-extensions.ts";

/** Receives a message for the user (the CLI prints it to stderr). */
export type Notify = (message: string) => void;

const ignoreNotice: Notify = () => {};

/**
 * Extract process/decision IDs from BPMN/DMN files to detect duplicates
 */
export function extractDefinitionId(
	content: Buffer,
	extension: string,
): string | null {
	const text = content.toString("utf-8");

	if (extension === ".bpmn") {
		// Extract bpmn:process id attribute
		const match = text.match(/<bpmn\d?:process[^>]+id="([^"]+)"/);
		return match ? match[1] : null;
	} else if (extension === ".dmn") {
		// Extract decision id attribute
		const match = text.match(/<decision[^>]+id="([^"]+)"/);
		return match ? match[1] : null;
	} else if (extension === ".form") {
		// Forms are identified by filename, not internal ID
		return null;
	}

	return null;
}

export interface ResourceFile {
	path: string;
	name: string;
	content: Buffer;
	isBuildingBlock: boolean;
	isProcessApplication: boolean;
	groupPath?: string; // Path to the root of the group (BB or PA folder)
	relativePath?: string;
}

/**
 * Check if a path is a building block folder (contains _bb- in name)
 */
function isBuildingBlockFolder(path: string): boolean {
	return basename(path).includes("_bb-");
}

/**
 * Per-invocation cache for project-marker checks. The marker predicate
 * reads (and parses) `camunda.json`, and `findGroupRoot` runs once per
 * collected file — without a cache the descriptor would be read and
 * parsed again for every resource in the project.
 */
export type ProjectMarkerCache = Map<string, boolean>;

/**
 * Check if a directory contains a .process-application file
 */
function hasProcessApplicationFile(dirPath: string): boolean {
	const paFilePath = join(dirPath, PROCESS_APPLICATION_FILE);
	try {
		return statSync(paFilePath).isFile();
	} catch {
		return false;
	}
}

/**
 * Check if a directory is a Camunda project root — it contains a
 * `camunda.json` descriptor or a legacy `.process-application` marker.
 *
 * The descriptor is read once: a present `camunda.json` is parsed and
 * validated, so malformed JSON is a hard error (the file must never
 * silently count as a project marker). In lenient mode (display tagging,
 * nested-project checks) an unreadable descriptor does not select this
 * directory as a root; in strict mode (resolving the project root to
 * deploy or watch) it is an `invalid-config` error. Results
 * are memoized in `cache` when one is provided.
 */
function hasProjectMarker(
	dirPath: string,
	cache?: ProjectMarkerCache,
	{
		strict = false,
		descriptors,
	}: {
		strict?: boolean;
		/** Collects the descriptor read for each folder checked (strict). */
		descriptors?: Map<string, CamundaProject>;
	} = {},
): boolean {
	const cached = cache?.get(dirPath);
	if (cached !== undefined) {
		return cached;
	}
	// Strict (project-root resolution for deploy/watch): a camunda.json
	// that exists but cannot be read is an error, never "not a project" —
	// that would fall back to the default scan and bypass deployResources.
	const descriptor = strict
		? readProjectDescriptor(dirPath)
		: readCamundaProject(dirPath);
	if (descriptor) descriptors?.set(dirPath, descriptor);
	const result = descriptor ? true : hasProcessApplicationFile(dirPath);
	cache?.set(dirPath, result);
	return result;
}

/**
 * Find the root building block or Camunda project folder by traversing up the path
 * Returns the path to the group root, or null if not in a group
 */
function findGroupRoot(
	filePath: string,
	basePath: string,
	cache?: ProjectMarkerCache,
):
	| { type: "bb"; root: string }
	| { type: "pa"; root: string }
	| { type: null; root: null } {
	let currentDir = dirname(filePath);

	// Traverse up the directory tree until we reach or go outside basePath
	while (true) {
		// Check if this directory is a building block
		if (isBuildingBlockFolder(currentDir)) {
			return { type: "bb", root: currentDir };
		}

		// Check if this directory is a Camunda project root
		// (camunda.json or legacy .process-application marker). Display
		// tagging only: it runs after the plan was resolved, so a
		// descriptor that changed or broke meanwhile must not fail the run
		// (it cannot change what is deployed either).
		let isProjectRoot = false;
		try {
			isProjectRoot = hasProjectMarker(currentDir, cache);
		} catch {
			isProjectRoot = false;
		}
		if (isProjectRoot) {
			return { type: "pa", root: currentDir };
		}

		// Check if we've reached or gone outside the basePath
		const rel = relative(basePath, currentDir);
		if (rel.startsWith("..") || rel === "") {
			break;
		}

		// Move up one level
		const parentDir = dirname(currentDir);
		if (parentDir === currentDir) break; // Reached filesystem root
		currentDir = parentDir;
	}

	return { type: null, root: null };
}

/**
 * Walk up from `startDir` looking for a project marker — a `camunda.json`
 * descriptor or a legacy `.process-application` file. Returns the
 * directory that contains the marker, or `null` if none is found before
 * reaching the filesystem root. Throws when a `camunda.json` exists but
 * contains invalid JSON.
 *
 * `startDir` may be a file path — the walk starts from its parent
 * directory in that case (the initial `hasProjectMarker` call
 * harmlessly returns false for non-directories).
 *
 * Unlike `findGroupRoot()` (which tags individual files for display),
 * this function determines the *deploy scope*: when a project root is
 * found, `collectResourcesForPaths` expands the input to the project
 * root so that the entire project is deployed.
 */
export function findProjectRoot(
	startDir: string,
	cache?: ProjectMarkerCache,
	/** When given, receives the descriptor read for the returned root, so
	 *  callers can use that single read instead of reading it again. */
	descriptors?: Map<string, CamundaProject>,
): string | null {
	let currentDir = resolve(startDir);

	while (true) {
		if (hasProjectMarker(currentDir, cache, { strict: true, descriptors })) {
			return currentDir;
		}

		const parentDir = dirname(currentDir);
		if (parentDir === currentDir) break; // Reached filesystem root
		currentDir = parentDir;
	}

	return null;
}

/**
 * Recursively collect resource files from a directory.
 *
 * @param extensionList - The active allow-list of extensions. Only used
 *   during directory walks; explicit file paths bypass this check (the
 *   caller's intent is unambiguous). Pass `undefined` to skip extension
 *   filtering entirely (equivalent to `--force`).
 * @param skippedExtensions - Mutable set that accumulates extensions
 *   skipped during directory walks, so the caller can log them.
 */
function collectResourceFiles(
	dirPath: string,
	collected: ResourceFile[] = [],
	basePath?: string,
	ig?: Ignore,
	ignoreBaseDir?: string,
	force?: boolean,
	extensionList?: readonly string[],
	skippedExtensions?: Set<string>,
	skippedFiles?: string[],
	deployAlways?: Ignore,
	markerCache?: ProjectMarkerCache,
	notify: Notify = ignoreNotice,
): ResourceFile[] {
	if (!existsSync(dirPath)) {
		return collected;
	}

	const stat = statSync(dirPath);

	// Set basePath to a directory on first call — when the initial input
	// is a file, use its parent so findGroupRoot can walk up correctly.
	if (!basePath) {
		basePath = stat.isFile() ? dirname(dirPath) : dirPath;
	}

	if (stat.isFile()) {
		// The camunda.json project descriptor is metadata, never a
		// deployable resource — even when named explicitly.
		if (basename(dirPath) === CAMUNDA_PROJECT_FILE) {
			return collected;
		}
		if (ig && ignoreBaseDir && isIgnored(ig, dirPath, ignoreBaseDir)) {
			return collected;
		}
		// Explicit file paths always pass through — the user named the
		// file directly, so their intent is unambiguous. Extension
		// filtering only applies during directory discovery (below).
		const groupInfo = findGroupRoot(dirPath, basePath, markerCache);
		collected.push({
			path: dirPath,
			name: basename(dirPath),
			content: readFileSync(dirPath),
			isBuildingBlock: groupInfo.type === "bb",
			isProcessApplication: groupInfo.type === "pa",
			groupPath: groupInfo.root || undefined,
		});
		return collected;
	}

	if (stat.isDirectory()) {
		// Skip entire directory if it matches an ignore rule
		if (ig && ignoreBaseDir && isIgnored(ig, `${dirPath}/`, ignoreBaseDir)) {
			return collected;
		}

		const entries = readdirSync(dirPath);

		// Separate building block folders from regular ones
		const bbFolders: string[] = [];
		const regularFolders: string[] = [];
		const files: string[] = [];

		entries.forEach((entry) => {
			const fullPath = join(dirPath, entry);
			const entryStat = statSync(fullPath);

			if (entryStat.isDirectory()) {
				// Skip ignored directories early to avoid descending into them
				if (
					ig &&
					ignoreBaseDir &&
					isIgnored(ig, `${fullPath}/`, ignoreBaseDir)
				) {
					return;
				}
				if (isBuildingBlockFolder(entry)) {
					bbFolders.push(fullPath);
				} else if (
					basePath !== undefined &&
					hasProjectMarker(basePath, markerCache) &&
					hasProjectMarker(fullPath, markerCache)
				) {
					// A nested project marker inside a project is a boundary —
					// Camunda projects do not nest. The subtree is a separate
					// project and is excluded from this walk. (Markerless roots
					// — e.g. a monorepo folder — still deploy sibling projects.)
					notify(`Skipping nested Camunda project at ${fullPath}`);
					return;
				} else {
					regularFolders.push(fullPath);
				}
			} else if (entryStat.isFile()) {
				// Skip hidden files (e.g. .c8ignore, .process-application) and
				// the camunda.json project descriptor — it is metadata, never
				// a deployable resource.
				if (entry.startsWith(".") || entry === CAMUNDA_PROJECT_FILE) {
					return;
				}
				// Skip ignored files
				if (ig && ignoreBaseDir && isIgnored(ig, fullPath, ignoreBaseDir)) {
					return;
				}
				// Unless --force, only collect files with known deployable extensions
				if (
					!force &&
					extensionList &&
					!extensionList.includes(extname(fullPath))
				) {
					// Check deploy-always negation rules from .c8ignore
					if (
						deployAlways &&
						ignoreBaseDir &&
						isIgnored(deployAlways, fullPath, ignoreBaseDir)
					) {
						// File matches a !path negation — include it
						files.push(fullPath);
						return;
					}
					if (skippedExtensions) {
						const ext = extname(fullPath);
						skippedExtensions.add(ext || "<no extension>");
					}
					if (skippedFiles) {
						skippedFiles.push(fullPath);
					}
					return;
				}
				files.push(fullPath);
			}
		});

		// Process files in current directory first
		files.forEach((file) => {
			const groupInfo = findGroupRoot(file, basePath, markerCache);
			collected.push({
				path: file,
				name: basename(file),
				content: readFileSync(file),
				isBuildingBlock: groupInfo.type === "bb",
				isProcessApplication: groupInfo.type === "pa",
				groupPath: groupInfo.root || undefined,
			});
		});

		// Process building block folders first (prioritized)
		bbFolders.forEach((bbFolder) => {
			collectResourceFiles(
				bbFolder,
				collected,
				basePath,
				ig,
				ignoreBaseDir,
				force,
				extensionList,
				skippedExtensions,
				skippedFiles,
				deployAlways,
				markerCache,
				notify,
			);
		});

		// Then process regular folders
		regularFolders.forEach((regularFolder) => {
			collectResourceFiles(
				regularFolder,
				collected,
				basePath,
				ig,
				ignoreBaseDir,
				force,
				extensionList,
				skippedExtensions,
				skippedFiles,
				deployAlways,
				markerCache,
				notify,
			);
		});
	}

	return collected;
}

/**
 * Find duplicate process/decision IDs across resources
 */
export function findDuplicateDefinitionIds(
	resources: ResourceFile[],
): Map<string, string[]> {
	const idMap = resources.reduce((map, r) => {
		const ext = extname(r.path);
		if (ext === ".bpmn" || ext === ".dmn") {
			const defId = extractDefinitionId(r.content, ext);
			if (defId) map.set(defId, [...(map.get(defId) ?? []), r.path]);
		}
		return map;
	}, new Map<string, string[]>());

	return new Map([...idMap].filter(([, paths]) => paths.length > 1));
}

/**
 * How one deploy/watch input path is collected.
 *
 * - `file`: an explicitly named file — deployed regardless of extension
 *   and of `deployResources`. `inDescriptorProject` is set when the file
 *   lives in a project that declares `deployResources`, in which case
 *   `.c8ignore` is not consulted either.
 * - `scan`: a directory scanned with the default extension allow-list
 *   filtered by `.c8ignore` (possibly expanded to its project root).
 * - `descriptor`: a project root whose `camunda.json` declares
 *   `deployResources`; the descriptor alone selects the files.
 */
export type DeployPathPlan =
	| { kind: "file"; path: string; inDescriptorProject: boolean }
	| { kind: "scan"; path: string }
	| { kind: "descriptor"; path: string; patterns: string[] };

/**
 * Resolve the input paths of `deploy` / `watch` into a collection plan:
 * directories expand to their Camunda project root (deduplicated), and a
 * root whose descriptor declares `deployResources` is selected by that
 * field. Explicit files are never expanded.
 *
 * Descriptor read discipline: this is the single place where a deploy run
 * reads `camunda.json` to decide what gets deployed. Each descriptor is
 * read once (while finding the project root) and every decision of the
 * run — project mode, `deployResources` patterns, whether `.c8ignore`
 * applies to an explicitly named file — derives from that snapshot. Later
 * steps (dry-run preview, collection, deployment) receive the plan and
 * must not read the descriptor again. `watch --project` follows the same
 * rule per redeploy (see `watch.ts`). Other reads of `camunda.json`
 * (display tagging and the nested-project skip of a default scan) only
 * affect default-scan entries, never a `deployResources` selection.
 *
 * @throws {Error} When a project's `camunda.json` is invalid JSON or its
 *   `deployResources` field is invalid (`DeployResourcesError`).
 */
export function planDeployPaths(
	paths: string[],
	{
		markerCache = new Map(),
		announce = true,
		notify = ignoreNotice,
	}: {
		markerCache?: ProjectMarkerCache;
		/** Notify when a directory expands to an enclosing project root. */
		announce?: boolean;
		notify?: Notify;
	} = {},
): DeployPathPlan[] {
	// ── Project auto-detection ─────────────────────────────────────────
	// For each directory path, walk up looking for a project marker
	// (camunda.json or legacy .process-application). If found, expand to
	// the project root so the entire project is deployed — matching
	// Desktop Modeler behaviour.
	// File paths are NOT expanded so that watch-mode single-file deploys
	// remain scoped to the changed file.
	const plan: DeployPathPlan[] = [];
	// The snapshot: the descriptor read for each project root found.
	const descriptors = new Map<string, CamundaProject>();
	const seenRoots = new Set<string>();
	for (const p of paths) {
		const abs = resolve(p);
		let isFile = false;
		try {
			isFile = statSync(abs).isFile();
		} catch {
			// Path does not exist — skip project detection and keep the
			// absolute path so collectResourceFiles (which silently
			// skips missing paths) falls through to the "No deployable
			// files found" guard.
			plan.push({ kind: "scan", path: abs });
			continue;
		}

		if (isFile) {
			plan.push({
				kind: "file",
				path: abs,
				inDescriptorProject: fileInDescriptorProject(
					abs,
					markerCache,
					descriptors,
				),
			});
			continue;
		}

		const projectRoot = findProjectRoot(abs, markerCache, descriptors);
		if (!projectRoot) {
			plan.push({ kind: "scan", path: abs });
			continue;
		}
		// Deduplicate: multiple input dirs inside the same project
		// should only trigger one resource walk from the project root.
		// Use realpathSync for the dedup key to handle symlinks/case.
		let canonical = projectRoot;
		try {
			canonical = realpathSync(projectRoot);
		} catch {
			// Best-effort fallback.
		}
		if (seenRoots.has(canonical)) continue;
		seenRoots.add(canonical);
		// Tell the user when the deploy scope widened beyond the
		// paths they named — a stray marker in a parent directory
		// should never silently expand the deploy.
		if (announce && projectRoot !== abs) {
			notify(`📦 Deploying Camunda project at ${projectRoot}`);
		}
		const state = deployResourcesStateOf(
			descriptors.get(projectRoot) ?? null,
			projectRoot,
		);
		plan.push(
			state.kind === "patterns"
				? { kind: "descriptor", path: projectRoot, patterns: state.patterns }
				: { kind: "scan", path: projectRoot },
		);
	}
	return plan;
}

/**
 * Reject resource-selection flags when an input path expands to a project
 * that selects its resources with `deployResources`: the descriptor is the
 * single source of truth for the project's resource set.
 *
 * `force` is only passed by `deploy`, where it bypasses extension
 * filtering. `watch --project --force` keeps its separate meaning
 * (continue after deployment errors) and is never rejected.
 */
export function rejectSelectionFlagsForDescriptor({
	descriptorRoots,
	extensions,
	allExtensions,
	force,
}: {
	descriptorRoots: readonly string[];
	extensions?: string;
	allExtensions?: boolean;
	force?: boolean;
}): void {
	if (descriptorRoots.length === 0) return;
	const conflicting = [
		extensions !== undefined ? "--extensions" : null,
		allExtensions ? "--all-extensions" : null,
		force ? "--force" : null,
	].filter((flag): flag is string => flag !== null);
	if (conflicting.length === 0) return;
	const descriptor = join(descriptorRoots[0], CAMUNDA_PROJECT_FILE);
	throw new C8ctlError(
		"invalid-input",
		`${conflicting.join(", ")} cannot be used with a project that selects its resources ` +
			`with "deployResources" (${descriptor}). ` +
			`The descriptor defines which files deploy: add or adjust patterns in "deployResources" instead, ` +
			"or name files explicitly on the command line (explicitly named files always deploy).",
		{ details: { conflicting } },
	);
}

/**
 * Whether an explicitly named file lives inside a project whose
 * descriptor declares `deployResources`. Lenient: a broken descriptor
 * never blocks an explicit file (explicit files deploy regardless of
 * `deployResources`).
 */
function fileInDescriptorProject(
	file: string,
	markerCache: ProjectMarkerCache,
	descriptors: Map<string, CamundaProject>,
): boolean {
	try {
		const root = findProjectRoot(dirname(file), markerCache, descriptors);
		const descriptor = root === null ? undefined : descriptors.get(root);
		return (
			descriptor !== undefined &&
			Object.hasOwn(descriptor, DEPLOY_RESOURCES_FIELD)
		);
	} catch {
		return false;
	}
}

/**
 * Result of collecting deployable resources, including any extensions
 * that were skipped during directory walks (for user feedback).
 */
export interface CollectResult {
	resources: ResourceFile[];
	skippedExtensions: Set<string>;
	skippedFiles: string[];
	/** Resolved base paths used for resource collection and display.
	 *  When PA detection fires, these are expanded to the PA root(s)
	 *  rather than the user-supplied input paths. Used downstream for
	 *  `ignoreBaseDir` resolution and `basePaths` in `deployResources`. */
	effectivePaths: string[];
	/** Project roots whose resources were selected by `deployResources`. */
	descriptorRoots: string[];
	/** Directory whose `.c8ignore` was consulted, or `null` when no entry
	 *  needed `.c8ignore` (only `deployResources` projects). Interactive
	 *  "always" choices must write `.c8ignore` here. */
	ignoreBaseDir: string | null;
}

/**
 * Collect deployable resources from the given paths, applying `.c8ignore`
 * rules. Throws on the two pre-API guard failures so callers (deploy
 * handler, watch, dry-run preview) all surface the same errors with the
 * same wording.
 *
 * Shared between `deployCommand` (used for both the dry-run preview and
 * the execute path via `deployResources`) and `deployResources` itself.
 *
 * @param extensionList - Active allow-list for directory discovery.
 *   Defaults to `DEPLOYABLE_EXTENSIONS` (.bpmn, .dmn, .form).
 */
export function collectResourcesForPaths(
	paths: string[],
	force?: boolean,
	extensionList: readonly string[] = DEPLOYABLE_EXTENSIONS,
	/** When false, skip loading deploy-always negation rules from .c8ignore.
	 *  Used to suppress them on servers <8.10 that don't support extended extensions. */
	loadDeployAlways = true,
	/** A plan resolved earlier in the same invocation. When given, the
	 *  descriptors are not read again, so an edit that lands mid-command
	 *  can never switch a `deployResources` project to the default scan. */
	pinnedPlan?: DeployPathPlan[],
	notify: Notify = ignoreNotice,
): CollectResult {
	if (paths.length === 0) {
		throw new C8ctlError(
			"invalid-input",
			"No paths provided. Use: c8 deploy <path> or c8 deploy (for current directory)",
			{ field: "paths" },
		);
	}

	// Memoizes marker checks across the scope walk and the per-file
	// display tagging below — the descriptor would otherwise be read and
	// parsed once per collected file.
	const markerCache: ProjectMarkerCache = new Map();
	const plan = pinnedPlan ?? planDeployPaths(paths, { markerCache, notify });
	const effectivePaths = plan.map((entry) => entry.path);

	// Load .c8ignore rules from the effective target directory (which may
	// be the project root) so that `c8 deploy <target>` picks up the
	// .c8ignore inside the target. (#258) Only default scans and explicit
	// files outside `deployResources` projects consult .c8ignore, so only
	// they take part in the base-dir resolution — and when none does, the
	// file is not read at all (a descriptor-only deploy must not fail on an
	// unreadable .c8ignore it ignores anyway).
	const ignorePaths = plan
		.filter(
			(entry) =>
				entry.kind === "scan" ||
				(entry.kind === "file" && !entry.inDescriptorProject),
		)
		.map((entry) => entry.path);
	const ignoreBaseDir = resolveIgnoreBaseDir(
		ignorePaths.length > 0 ? ignorePaths : effectivePaths,
	);
	const ig =
		ignorePaths.length > 0 ? loadIgnoreRules(ignoreBaseDir) : undefined;

	// Load !path negation patterns from .c8ignore. Files matching a
	// negation bypass extension filtering ("deploy them always").
	// Skipped on servers <8.10 where extended extensions aren't supported.
	const deployAlways =
		loadDeployAlways && ignorePaths.length > 0
			? loadDeployAlwaysRules(ignoreBaseDir)
			: null;

	const resources: ResourceFile[] = [];
	const skippedExtensions = new Set<string>();
	const skippedFiles: string[] = [];
	for (const entry of plan) {
		if (entry.kind === "descriptor") {
			// `deployResources` is an allowlist: the descriptor alone selects
			// the files — no extension filter, no .c8ignore, no hidden-file
			// pre-skip, no nested-project boundary.
			for (const rel of resolveDeployResources(entry.path, entry.patterns)) {
				const file = join(entry.path, ...rel.split("/"));
				// All contents are read before any request is sent, so a read
				// failure aborts the whole deployment (never a partial one).
				let content: Buffer;
				try {
					content = readFileSync(file);
				} catch (error) {
					throw unreadablePath(file, error);
				}
				resources.push({
					path: file,
					name: basename(file),
					content,
					isBuildingBlock: false,
					isProcessApplication: true,
					groupPath: entry.path,
				});
			}
			continue;
		}
		const bypassIgnore = entry.kind === "file" && entry.inDescriptorProject;
		collectResourceFiles(
			entry.path,
			resources,
			undefined,
			bypassIgnore ? undefined : ig,
			ignoreBaseDir,
			force,
			extensionList,
			skippedExtensions,
			skippedFiles,
			deployAlways ?? undefined,
			markerCache,
			notify,
		);
	}

	// Deduplicate resources by canonical path — can happen when an explicit
	// file path is also covered by a project-root or scoped-directory walk,
	// or when the same file is reachable via symlinks. The canonical path
	// is used only as the dedup key; the original path/name are preserved
	// for display and relative-path calculations.
	const seen = new Set<string>();
	const deduped: ResourceFile[] = [];
	for (const r of resources) {
		let canonical = r.path;
		try {
			canonical = realpathSync(r.path);
		} catch {
			// Best-effort: fall back to the original path if realpath
			// fails (e.g. broken symlink).
		}
		if (!seen.has(canonical)) {
			seen.add(canonical);
			deduped.push(r);
		}
	}

	if (deduped.length === 0) {
		throw new C8ctlError(
			"no-deployable-files",
			skippedFiles.length > 0
				? `No files with allowed extensions found. ${skippedFiles.length} file(s) were skipped (${[...skippedExtensions].sort().join(", ")}). Use --force to include all files, or --extensions to expand the allow-list.`
				: "No deployable files found in the specified paths",
			{
				details: {
					skippedFiles,
					skippedExtensions: [...skippedExtensions].sort(),
				},
			},
		);
	}

	return {
		resources: deduped,
		skippedExtensions,
		skippedFiles,
		effectivePaths,
		descriptorRoots: plan
			.filter((entry) => entry.kind === "descriptor")
			.map((entry) => entry.path),
		ignoreBaseDir: ignorePaths.length > 0 ? ignoreBaseDir : null,
	};
}
