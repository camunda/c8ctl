/**
 * Shared deployment helpers — resource collection, deployment execution,
 * and process-application detection.
 *
 * Consumed by:
 * - `src/commands/deploy.ts` (the `deployCommand` handler)
 * - `src/commands/watch.ts` (change-triggered re-deploys)
 */

import {
	existsSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
} from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import type { CamundaClient } from "@camunda8/orchestration-cluster-api";
import { TenantId } from "@camunda8/orchestration-cluster-api";
import {
	createClient,
	getLogger,
	isRecord,
	normalizeToError,
	resolveTenantId,
	SilentError,
} from "../../core/index.ts";
import {
	DEPLOYABLE_EXTENSIONS,
	type Ignore,
	isIgnored,
	loadDeployAlwaysRules,
	loadIgnoreRules,
	meetsMinExtensionVersion,
	resolveIgnoreBaseDir,
} from "../../utils/index.ts";

const PROCESS_APPLICATION_FILE = ".process-application";

/**
 * Helper to output messages that respect JSON mode for Unix pipe compatibility
 */
export function logMessage(message: string): void {
	if (getLogger().mode === "json") {
		console.error(JSON.stringify({ type: "message", message }));
	} else {
		console.error(message);
	}
}

/**
 * Format and log a hint about skipped file extensions.
 * Shared between the dry-run preview and the execute path so the
 * message stays consistent. See https://github.com/camunda/c8ctl/issues/350
 */
export function logSkippedExtensions(skippedExtensions: Set<string>): void {
	if (skippedExtensions.size === 0) return;
	const exts = [...skippedExtensions].sort().join(", ");
	logMessage(
		`Skipped files with extensions not in the allow-list (${exts}). ` +
			`Use --extensions=<ext> to add specific types, or --all-extensions to include all server-supported types.`,
	);
}

/**
 * Check whether the connected Camunda server supports extended file extensions.
 * Returns `true` for 8.10+, `false` for older versions.
 * Falls back to `false` on any error (network, auth, unparseable version)
 * so unsupported resource types are not deployed to older clusters.
 */
export async function checkServerSupportsExtensions(
	client: CamundaClient,
): Promise<boolean> {
	const logger = getLogger();
	try {
		const topology = await client.getTopology();
		const version = String(topology.gatewayVersion ?? "");
		const result = meetsMinExtensionVersion(version);
		if (result === null) {
			logger.warn(
				`Could not parse server version "${version}" — assuming extended extensions are NOT supported.`,
			);
			return false;
		}
		return result;
	} catch {
		logger.warn(
			"Could not reach the server to check its version (topology call failed).",
		);
		logger.warn(
			"This can happen with OAuth/SaaS clusters before the first token is fetched, " +
				"or if the server is not yet ready. Assuming extended extensions are NOT supported.",
		);
		return false;
	}
}

/**
 * Extract process/decision IDs from BPMN/DMN files to detect duplicates
 */
function extractDefinitionId(
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

interface ResourceFile {
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
 * Find the root building block or process application folder by traversing up the path
 * Returns the path to the group root, or null if not in a group
 */
function findGroupRoot(
	filePath: string,
	basePath: string,
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

		// Check if this directory has a .process-application file
		if (hasProcessApplicationFile(currentDir)) {
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
 * Walk up from `startDir` looking for a `.process-application` marker
 * file. Returns the directory that contains the marker, or `null` if
 * none is found before reaching the filesystem root.
 *
 * `startDir` may be a file path — the walk starts from its parent
 * directory in that case (the initial `hasProcessApplicationFile` call
 * harmlessly returns false for non-directories).
 *
 * Unlike `findGroupRoot()` (which tags individual files for display),
 * this function determines the *deploy scope*: when a PA root is found,
 * `collectResourcesForPaths` expands the input to the PA root so that
 * the entire application is deployed.
 */
export function findProcessApplicationRoot(startDir: string): string | null {
	let currentDir = resolve(startDir);

	while (true) {
		if (hasProcessApplicationFile(currentDir)) {
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
		if (ig && ignoreBaseDir && isIgnored(ig, dirPath, ignoreBaseDir)) {
			return collected;
		}
		// Explicit file paths always pass through — the user named the
		// file directly, so their intent is unambiguous. Extension
		// filtering only applies during directory discovery (below).
		const groupInfo = findGroupRoot(dirPath, basePath);
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
				} else {
					regularFolders.push(fullPath);
				}
			} else if (entryStat.isFile()) {
				// Skip hidden files (e.g. .c8ignore, .process-application)
				if (entry.startsWith(".")) {
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
			const groupInfo = findGroupRoot(file, basePath);
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
			);
		});
	}

	return collected;
}

/**
 * Find duplicate process/decision IDs across resources
 */
function findDuplicateDefinitionIds(
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
 * Result of collecting deployable resources, including any extensions
 * that were skipped during directory walks (for user feedback).
 */
interface CollectResult {
	resources: ResourceFile[];
	skippedExtensions: Set<string>;
	skippedFiles: string[];
	/** Resolved base paths used for resource collection and display.
	 *  When PA detection fires, these are expanded to the PA root(s)
	 *  rather than the user-supplied input paths. Used downstream for
	 *  `ignoreBaseDir` resolution and `basePaths` in `deployResources`. */
	effectivePaths: string[];
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
): CollectResult {
	if (paths.length === 0) {
		throw new Error(
			"No paths provided. Use: c8 deploy <path> or c8 deploy (for current directory)",
		);
	}

	// ── Process-application auto-detection (#227) ──────────────────────
	// For each directory path, walk up looking for a .process-application
	// marker. If found, expand to the PA root so the entire application
	// is deployed — matching Desktop Modeler behaviour.
	// File paths are NOT expanded so that watch-mode single-file deploys
	// remain scoped to the changed file.
	const effectivePaths: string[] = [];
	const seenRoots = new Set<string>();
	for (const p of paths) {
		const abs = resolve(p);
		let isFile = false;
		try {
			isFile = statSync(abs).isFile();
		} catch {
			// Path does not exist — skip PA detection and keep the
			// absolute path so collectResourceFiles (which silently
			// skips missing paths) falls through to the "No deployable
			// files found" guard.
			effectivePaths.push(abs);
			continue;
		}

		if (isFile) {
			effectivePaths.push(abs);
			continue;
		}

		const paRoot = findProcessApplicationRoot(abs);
		if (paRoot) {
			// Deduplicate: multiple input dirs inside the same PA should
			// only trigger one resource walk from the PA root. Use
			// realpathSync for the dedup key to handle symlinks/case.
			let canonical = paRoot;
			try {
				canonical = realpathSync(paRoot);
			} catch {
				// Best-effort fallback.
			}
			if (!seenRoots.has(canonical)) {
				seenRoots.add(canonical);
				effectivePaths.push(paRoot);
			}
		} else {
			effectivePaths.push(abs);
		}
	}

	// Load .c8ignore rules from the effective target directory (which may
	// be the PA root) so that `c8 deploy <target>` picks up the .c8ignore
	// inside the target. (#258)
	const ignoreBaseDir = resolveIgnoreBaseDir(effectivePaths);
	const ig = loadIgnoreRules(ignoreBaseDir);

	// Load !path negation patterns from .c8ignore. Files matching a
	// negation bypass extension filtering ("deploy them always").
	// Skipped on servers <8.10 where extended extensions aren't supported.
	const deployAlways = loadDeployAlways
		? loadDeployAlwaysRules(ignoreBaseDir)
		: null;

	const resources: ResourceFile[] = [];
	const skippedExtensions = new Set<string>();
	const skippedFiles: string[] = [];
	effectivePaths.forEach((path) => {
		collectResourceFiles(
			path,
			resources,
			undefined,
			ig,
			ignoreBaseDir,
			force,
			extensionList,
			skippedExtensions,
			skippedFiles,
			deployAlways ?? undefined,
		);
	});

	// Deduplicate resources by canonical path — can happen when an explicit
	// file path is also covered by a PA-root or scoped-directory walk, or
	// when the same file is reachable via symlinks. The canonical path is
	// used only as the dedup key; the original path/name are preserved for
	// display and relative-path calculations.
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
		logSkippedExtensions(skippedExtensions);
		throw new Error(
			skippedFiles.length > 0
				? `No files with allowed extensions found. ${skippedFiles.length} file(s) were skipped (${[...skippedExtensions].sort().join(", ")}). Use --force to include all files, or --extensions to expand the allow-list.`
				: "No deployable files found in the specified paths",
		);
	}

	return {
		resources: deduped,
		skippedExtensions,
		skippedFiles,
		effectivePaths,
	};
}

/**
 * Internal helper: deploy the given paths to the cluster and render the
 * result table. Used by `deployCommand` (the standard CLI entry point)
 * and by `watchCommand` (for change-triggered re-deploys).
 *
 * Does NOT consult dry-run state — dry-run handling lives in the
 * `deployCommand` handler so the context's `ctx.dryRun()` helper owns
 * preview emission. Watch never triggers a dry-run, so this split also
 * removes a footgun where a stale dry-run flag could suppress a watch
 * deploy.
 */
export async function deployResources(
	paths: string[],
	options: {
		profile?: string;
		continueOnError?: boolean;
		continueOnUserError?: boolean;
		force?: boolean;
		extensionList?: readonly string[];
		/**
		 * Optional cancellation signal. When aborted, an in-flight
		 * `createDeployment` HTTP request is cancelled via the SDK's
		 * `CancelablePromise.cancel()`. Cancellation is handled internally:
		 * if the signal is aborted, `deployResources()` returns early
		 * without surfacing the cancellation as a deploy failure (no
		 * "Deployment failed" log, no rejection from the awaited promise).
		 * Callers do not need their own try/catch to suppress aborts.
		 */
		signal?: AbortSignal;
		/** When true, skip the skipped-extensions log (caller already handled it). */
		suppressSkippedLog?: boolean;
		/** When false, skip loading deploy-always negation rules from .c8ignore.
		 *  Used to suppress them on servers <8.10 that don't support extended extensions. */
		loadDeployAlways?: boolean;
		/** Override base path for relative path display. When set, used instead
		 *  of inferring from paths (avoids regression when extra file paths are appended). */
		basePath?: string;
		/** Whether --verbose was set (surfaces raw errors with stack traces). */
		verbose?: boolean;
	},
): Promise<void> {
	const logger = getLogger();
	const tenantId = resolveTenantId(options.profile);

	// ─── Pre-API-call validation and preparation ────────────────────────
	// These steps run OUTSIDE any try/catch so validation errors bubble
	// straight to the framework's `handleCommandError`. Only the actual
	// HTTP deploy call (further down) is wrapped in a catch that routes
	// through `handleDeploymentError` for rich Problem-Detail rendering.

	const { resources, skippedExtensions, effectivePaths } =
		collectResourcesForPaths(
			paths,
			options.force,
			options.extensionList ?? DEPLOYABLE_EXTENSIONS,
			options.loadDeployAlways ?? true,
		);

	if (!options.suppressSkippedLog) {
		logSkippedExtensions(skippedExtensions);
	}

	// Use the effective paths (which may have been expanded to a PA root)
	// for relative path calculation so display paths make sense.
	const basePaths = effectivePaths;

	const client = createClient(options.profile);

	// Calculate relative paths for display
	const basePath =
		options.basePath ?? (basePaths.length === 1 ? basePaths[0] : process.cwd());
	resources.forEach((r) => {
		r.relativePath = relative(basePath, r.path) || r.name;
	});

	// Sort: group resources by their group, with building blocks first, then process applications, then standalone
	resources.sort((a, b) => {
		// Building blocks have highest priority
		if (a.isBuildingBlock && !b.isBuildingBlock) return -1;
		if (!a.isBuildingBlock && b.isBuildingBlock) return 1;

		// Within building blocks, group by groupPath
		if (a.isBuildingBlock && b.isBuildingBlock) {
			if (a.groupPath && b.groupPath) {
				const groupCompare = a.groupPath.localeCompare(b.groupPath);
				if (groupCompare !== 0) return groupCompare;
			}
			return a.path.localeCompare(b.path);
		}

		// Process applications come next
		if (a.isProcessApplication && !b.isProcessApplication) return -1;
		if (!a.isProcessApplication && b.isProcessApplication) return 1;

		// Within process applications, group by groupPath
		if (a.isProcessApplication && b.isProcessApplication) {
			if (a.groupPath && b.groupPath) {
				const groupCompare = a.groupPath.localeCompare(b.groupPath);
				if (groupCompare !== 0) return groupCompare;
			}
			return a.path.localeCompare(b.path);
		}

		// Finally, standalone resources sorted by path
		return a.path.localeCompare(b.path);
	});

	// Validate for duplicate process/decision IDs
	const duplicates = findDuplicateDefinitionIds(resources);
	if (duplicates.size > 0) {
		// Single source of truth for both the user-visible logger.error and
		// the SilentError message — keeps stderr and `--verbose` rethrow
		// stack message aligned even if the wording is later edited.
		const duplicateIdsMessage =
			"Cannot deploy: Multiple files with the same process/decision ID in one deployment";
		// Pre-render the rich detail (per-id file list + guidance) so the
		// user sees actionable context, then throw a SilentError so the
		// framework records the failure without re-rendering a duplicate
		// summary line.
		logger.error(duplicateIdsMessage);
		duplicates.forEach((dupPaths, id) => {
			logMessage(
				`  Process/Decision ID "${id}" found in: ${dupPaths.join(", ")}`,
			);
		});
		logMessage(
			"\nCamunda does not allow deploying multiple resources with the same definition ID in a single deployment.",
		);
		logMessage(
			"Please deploy these files separately or ensure each process/decision has a unique ID.",
		);
		throw new SilentError(duplicateIdsMessage);
	}

	logger.info(`Deploying ${resources.length} resource(s)...`);

	// Create a mapping from definition ID to resource file for later reference
	const definitionIdToResource = new Map<string, ResourceFile>();
	const formNameToResource = new Map<string, ResourceFile>();
	// Map basename → ResourceFile[]: multiple files can share a basename
	// across directories (e.g. sub-a/model.dmn, sub-b/model.dmn). When
	// the API returns a resourceName, we pop the first matching entry so
	// each response record resolves to a distinct local file.
	const resourcesByName = new Map<string, ResourceFile[]>();

	resources.forEach((r) => {
		const existing = resourcesByName.get(r.name);
		if (existing) {
			existing.push(r);
		} else {
			resourcesByName.set(r.name, [r]);
		}

		const ext = extname(r.path);
		if (ext === ".bpmn" || ext === ".dmn") {
			const defId = extractDefinitionId(r.content, ext);
			if (defId) {
				definitionIdToResource.set(defId, r);
			}
		} else if (ext === ".form") {
			// Forms are matched by their internal ID from the JSON content.
			// Fall back to filename (without extension) if the ID can't be parsed.
			let formId = basename(r.name, ".form");
			try {
				const parsed: unknown = JSON.parse(r.content.toString("utf-8"));
				if (isRecord(parsed) && typeof parsed.id === "string") {
					formId = parsed.id;
				}
			} catch {
				// Not valid JSON — use filename
			}
			formNameToResource.set(formId, r);
		}
	});

	/** Pop the first resource with a matching basename, or return undefined. */
	function popResourceByName(name: string): ResourceFile | undefined {
		const bucket = resourcesByName.get(name);
		if (!bucket || bucket.length === 0) return undefined;
		return bucket.shift();
	}

	// ─── API call ────────────────────────────────────────────────────────
	// Only this section is wrapped in a catch that routes through
	// `handleDeploymentError`. Pre-API errors above bubble to the
	// framework directly.

	// Create deployment request - convert buffers to File objects with proper MIME types
	const pendingDeploy = client.createDeployment({
		tenantId: TenantId.assumeExists(tenantId),
		resources: resources.map((r) => {
			// Determine MIME type based on extension
			const ext = r.name.split(".").pop()?.toLowerCase();
			const mimeType =
				ext === "bpmn"
					? "application/xml"
					: ext === "dmn"
						? "application/xml"
						: ext === "form"
							? "application/json"
							: "application/octet-stream";
			// Convert Buffer to Uint8Array for File constructor
			return new File([new Uint8Array(r.content)], r.name, {
				type: mimeType,
			});
		}),
	});

	// Wire optional cancellation: when the caller's AbortSignal fires,
	// cancel the underlying CancelablePromise so the in-flight HTTP
	// request is aborted promptly. Used by `watch` so SIGINT mid-deploy
	// shuts down within ~one event-loop tick rather than blocking on
	// the network round-trip.
	const onAbort = (): void => {
		pendingDeploy.cancel();
	};
	if (options.signal) {
		if (options.signal.aborted) {
			onAbort();
		} else {
			options.signal.addEventListener("abort", onAbort, { once: true });
		}
	}

	let result: Awaited<typeof pendingDeploy>;
	try {
		result = await pendingDeploy;
	} catch (error) {
		options.signal?.removeEventListener("abort", onAbort);
		// Caller-initiated cancellation (e.g. SIGINT in `watch`): the
		// CancelablePromise rejects with a "Cancelled" error after we
		// invoked `pendingDeploy.cancel()` from the abort listener. The
		// caller already knows the request was aborted — do not surface
		// it as a user-visible deploy failure or exit non-zero.
		if (options.signal?.aborted) {
			return;
		}
		handleDeploymentError(
			error,
			resources,
			logger,
			options.continueOnError,
			options.continueOnUserError,
			options.verbose === true,
		);
		// `handleDeploymentError` either throws (terminal) or returns
		// (continue-on-error). On the continue path, skip the success
		// render below — there's no result to render.
		return;
	}
	options.signal?.removeEventListener("abort", onAbort);

	logger.success("Deployment successful", result.deploymentKey.toString());

	// Group resources by their directory (building block or process application)
	type ResourceRow = {
		File: string;
		Type: string;
		ID: string;
		Version: string | number;
		Key: string;
		sortKey: string;
	};

	// Normalize all deployed resources into a common structure
	const knownResources = new Set<ResourceFile>();
	const allResources = [
		...result.processes.map((proc) => {
			const resource = definitionIdToResource.get(proc.processDefinitionId);
			if (resource) knownResources.add(resource);
			return {
				type: "Process" as const,
				id: proc.processDefinitionId,
				version: proc.processDefinitionVersion,
				key: proc.processDefinitionKey.toString(),
				resource,
			};
		}),
		...result.decisions.map((dec) => {
			const resource = definitionIdToResource.get(
				dec.decisionDefinitionId || "",
			);
			if (resource) knownResources.add(resource);
			return {
				type: "Decision" as const,
				id: dec.decisionDefinitionId || "-",
				version: dec.version ?? "-",
				key: dec.decisionDefinitionKey?.toString() || "-",
				resource,
			};
		}),
		...result.decisionRequirements.map((dr) => {
			const resource = popResourceByName(dr.resourceName || "");
			if (resource) knownResources.add(resource);
			return {
				type: "Decision Requirements" as const,
				id: dr.decisionRequirementsId || "-",
				version: dr.version ?? "-",
				key: dr.decisionRequirementsKey?.toString() || "-",
				resource,
			};
		}),
		...result.forms.map((form) => {
			const resource = formNameToResource.get(form.formId || "");
			if (resource) knownResources.add(resource);
			return {
				type: "Form" as const,
				id: form.formId || "-",
				version: form.version ?? "-",
				key: form.formKey?.toString() || "-",
				resource,
			};
		}),
		// Generic resources (not processes, decisions, or forms)
		// are returned in the `resources` array by 8.10+.
		...result.resources.map((res) => {
			const resource = popResourceByName(res.resourceName || "");
			if (resource) knownResources.add(resource);
			return {
				type: "Resource" as const,
				id: res.resourceId || "-",
				version: res.version ?? "-",
				key: res.resourceKey?.toString() || "-",
				resource,
			};
		}),
		// Supplementary resources not returned in any response array.
		// Show them in the table so the user knows they were deployed.
		...resources
			.filter((r) => !knownResources.has(r))
			.map((r) => ({
				type: "Resource" as const,
				id: "-",
				version: "-" as const,
				key: "-",
				resource: r,
			})),
	];

	const tableData: ResourceRow[] = allResources.map(
		({ type, id, version, key, resource }) => {
			const fileDisplay = resource
				? `${resource.isBuildingBlock ? "🧱 " : ""}${resource.isProcessApplication ? "📦 " : ""}${resource.relativePath || resource.name}`
				: "-";

			// Extract directory path for grouping (e.g., "bla/_bb-building-block" or "pa")
			const sortKey = resource?.relativePath
				? resource.relativePath.substring(
						0,
						resource.relativePath.lastIndexOf("/") + 1,
					) || resource.relativePath
				: "zzz"; // Resources without paths go last

			return {
				File: fileDisplay,
				Type: type,
				ID: id,
				Version: version,
				Key: key,
				sortKey,
			};
		},
	);

	// Sort by directory path (grouping), then by file name
	tableData.sort((a, b) => {
		if (a.sortKey !== b.sortKey) {
			return a.sortKey.localeCompare(b.sortKey);
		}
		return a.File.localeCompare(b.File);
	});

	// Remove sortKey before displaying
	const displayData = tableData.map(({ File, Type, ID, Version, Key }) => ({
		File,
		Type,
		ID,
		Version,
		Key,
	}));

	if (displayData.length > 0) {
		logger.table(displayData);
	}
}

/**
 * Format and display deployment errors with actionable guidance
 */
function handleDeploymentError(
	error: unknown,
	resources: ResourceFile[],
	logger: ReturnType<typeof getLogger>,
	continueOnError?: boolean,
	continueOnUserError?: boolean,
	verbose?: boolean,
): void {
	// Extract problem title early to determine whether this is a user-fixable error
	const raw: Record<string, unknown> = isRecord(error) ? error : {};
	const problemTitle = typeof raw.title === "string" ? raw.title : undefined;
	const isUserFixable = problemTitle === "INVALID_ARGUMENT";
	const shouldContinue =
		continueOnError || (continueOnUserError && isUserFixable);

	if (verbose) {
		if (shouldContinue) {
			throw error;
		}
		// Verbose mode: surface the original error to the framework so
		// `handleCommandError` rethrows it and Node prints the stack trace.
		// Non-Error throws (e.g. RFC 9457 problem-detail plain objects from
		// the SDK) are normalized via the centralized helper so the message
		// is built from `title` / `detail` / `status` instead of collapsing
		// to `Error: [object Object]`. The original value is preserved as
		// `cause` so it remains inspectable.
		throw normalizeToError(error, "Deployment request failed");
	}

	// Try to interpret common transport/network issues first for actionable guidance
	const deriveNetworkErrorTitle = (err: unknown): string | undefined => {
		const anyErr = isRecord(err) ? err : {};
		const code =
			typeof anyErr.code === "string"
				? anyErr.code
				: isRecord(anyErr.cause) && typeof anyErr.cause.code === "string"
					? anyErr.cause.code
					: undefined;

		if (!code && typeof anyErr?.name === "string") {
			// Handle fetch/abort style errors
			if (anyErr.name === "AbortError") {
				return "Request to Camunda cluster timed out or was aborted. Please check your network connection and try again.";
			}
		}

		switch (code) {
			case "ECONNREFUSED":
				return "Cannot connect to Camunda cluster (connection refused). Verify the endpoint URL and that the cluster is reachable.";
			case "ENOTFOUND":
				return "Cannot resolve Camunda cluster host. Check the cluster URL and your DNS/network configuration.";
			case "EHOSTUNREACH":
				return "Camunda cluster host is unreachable. Check VPN/proxy settings and your network connectivity.";
			case "ECONNRESET":
				return "Connection to Camunda cluster was reset. Retry the operation and check for intermittent network issues.";
			case "ETIMEDOUT":
				return "Request to Camunda cluster timed out. Check your network connection and consider retrying.";
			default:
				return undefined;
		}
	};

	// Extract RFC 9457 Problem Detail fields and other useful signals
	const networkTitle = deriveNetworkErrorTitle(error);
	const errorInstanceTitle =
		error instanceof Error && typeof error.message === "string" && error.message
			? error.message
			: undefined;
	const messageFieldTitle =
		typeof raw.message === "string" ? raw.message : undefined;
	const title =
		problemTitle ??
		networkTitle ??
		errorInstanceTitle ??
		messageFieldTitle ??
		"Unknown error (unexpected error format; re-run with increased logging or check network configuration).";

	const detail = typeof raw.detail === "string" ? raw.detail : undefined;
	const status = typeof raw.status === "number" ? raw.status : undefined;

	// Display the main error
	logger.error("Deployment failed", new Error(title));

	// Display the detailed error message if available
	if (detail) {
		logMessage(`\n${formatDeploymentErrorDetail(detail)}`);
	}

	// Provide actionable hints based on error type
	logMessage("");
	printDeploymentHints(title, detail, status, resources);
	logMessage("For more details on the error, run with the --verbose flag");

	if (shouldContinue) {
		return;
	}
	// Pre-rendered the rich error context above; throw a SilentError so
	// `handleCommandError` exits non-zero without re-rendering a
	// duplicate "Failed to deploy: <message>" summary line.
	throw new SilentError(title);
}

/**
 * Format the error detail for better readability
 */
function formatDeploymentErrorDetail(detail: string): string {
	// The detail often contains embedded newlines, format them nicely
	const lines = detail
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);

	// Find the main message and the file-specific errors
	const result: string[] = [];
	let inFileError = false;

	for (const line of lines) {
		if (line.startsWith("'") && line.includes("':")) {
			// This is a file-specific error (detected by 'filename': pattern)
			inFileError = true;
			result.push(`  📄 ${line}`);
		} else if (line.startsWith("- Element:")) {
			result.push(`     ${line}`);
		} else if (line.startsWith("- ERROR:") || line.startsWith("- WARNING:")) {
			const icon = line.startsWith("- ERROR:") ? "❌" : "⚠️";
			result.push(`     ${icon} ${line.substring(2)}`);
		} else if (inFileError && line.startsWith("-")) {
			result.push(`     ${line}`);
		} else {
			result.push(`  ${line}`);
		}
	}

	return result.join("\n");
}

/**
 * Print actionable hints based on the error type
 */
function printDeploymentHints(
	title: string,
	detail: string | undefined,
	status: number | undefined,
	resources: ResourceFile[],
): void {
	const hints: string[] = [];

	if (title === "INVALID_ARGUMENT") {
		if (detail?.includes("Must reference a message")) {
			hints.push(
				"💡 A message start event or intermediate catch event is missing a message reference.",
			);
			hints.push(
				"   Open the BPMN file in Camunda Modeler and configure the message name.",
			);
		}
		if (detail?.includes("duplicate")) {
			hints.push("💡 Resource IDs must be unique within a deployment.");
			hints.push("   Check for duplicate process/decision IDs in your files.");
		}
		if (detail?.includes("parsing") || detail?.includes("syntax")) {
			hints.push("💡 The resource file contains syntax errors.");
			hints.push(
				"   Validate the file in Camunda Modeler or check the XML/JSON structure.",
			);
		}
	} else if (title === "RESOURCE_EXHAUSTED") {
		hints.push("💡 The server is under heavy load (backpressure).");
		hints.push("   Wait a moment and retry the deployment.");
	} else if (title === "NOT_FOUND" || status === 404) {
		hints.push(
			"💡 The Camunda server could not be reached or the endpoint was not found.",
		);
		hints.push("   Check your connection settings with: c8 list profiles");
	} else if (
		title === "UNAUTHENTICATED" ||
		title === "PERMISSION_DENIED" ||
		status === 401 ||
		status === 403
	) {
		hints.push("💡 Authentication or authorization failed.");
		hints.push(
			"   Check your credentials and permissions for the current profile.",
		);
	} else {
		hints.push("💡 Review the error message above for specific issues.");
		hints.push("   You may need to fix the resource files before deploying.");
	}

	// Show which files were being deployed
	if (resources.length > 0) {
		hints.push("");
		hints.push(`📁 Resources attempted (${resources.length}):`);
		resources.slice(0, 5).forEach((r) => {
			hints.push(`   - ${r.relativePath || r.name}`);
		});
		if (resources.length > 5) {
			hints.push(`   ... and ${resources.length - 5} more`);
		}
	}

	hints.forEach((h) => {
		logMessage(h);
	});
}
