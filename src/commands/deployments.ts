/**
 * Deployment commands with building-block folder prioritization
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { TenantId } from "@camunda8/orchestration-cluster-api";
import type { Ignore } from "ignore";
import { createClient } from "../client.ts";
import { defineCommand, dryRun } from "../command-framework.ts";
import { resolveTenantId } from "../config.ts";
import { normalizeToError, SilentError } from "../errors.ts";
import { isIgnored, loadIgnoreRules } from "../ignore.ts";
import { getLogger, isRecord } from "../logger.ts";
import { c8ctl } from "../runtime.ts";

const RESOURCE_EXTENSIONS = [".bpmn", ".dmn", ".form"];
const PROCESS_APPLICATION_FILE = ".process-application";

/**
 * Helper to output messages that respect JSON mode for Unix pipe compatibility
 */
function logMessage(message: string): void {
	if (c8ctl.outputMode === "json") {
		console.error(JSON.stringify({ type: "message", message }));
	} else {
		console.error(message);
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
	return existsSync(paFilePath);
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
		// Check if we've gone outside the basePath
		const rel = relative(basePath, currentDir);
		if (rel.startsWith("..") || rel === "") {
			break;
		}

		// Check if this directory is a building block
		if (isBuildingBlockFolder(currentDir)) {
			return { type: "bb", root: currentDir };
		}

		// Check if this directory has a .process-application file
		if (hasProcessApplicationFile(currentDir)) {
			return { type: "pa", root: currentDir };
		}

		// Move up one level
		const parentDir = dirname(currentDir);
		if (parentDir === currentDir) break; // Reached filesystem root
		currentDir = parentDir;
	}

	return { type: null, root: null };
}

/**
 * Recursively collect resource files from a directory
 */
function collectResourceFiles(
	dirPath: string,
	collected: ResourceFile[] = [],
	basePath?: string,
	ig?: Ignore,
	ignoreBaseDir?: string,
): ResourceFile[] {
	if (!existsSync(dirPath)) {
		return collected;
	}

	// Set basePath to dirPath on first call
	if (!basePath) {
		basePath = dirPath;
	}

	const stat = statSync(dirPath);

	if (stat.isFile()) {
		if (ig && ignoreBaseDir && isIgnored(ig, dirPath, ignoreBaseDir)) {
			return collected;
		}
		const ext = extname(dirPath);
		if (RESOURCE_EXTENSIONS.includes(ext)) {
			const groupInfo = findGroupRoot(dirPath, basePath);
			collected.push({
				path: dirPath,
				name: basename(dirPath),
				content: readFileSync(dirPath),
				isBuildingBlock: groupInfo.type === "bb",
				isProcessApplication: groupInfo.type === "pa",
				groupPath: groupInfo.root || undefined,
			});
		}
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
				// Skip ignored files
				if (ig && ignoreBaseDir && isIgnored(ig, fullPath, ignoreBaseDir)) {
					return;
				}
				files.push(fullPath);
			}
		});

		// Process files in current directory first
		files.forEach((file) => {
			const ext = extname(file);
			if (RESOURCE_EXTENSIONS.includes(ext)) {
				const groupInfo = findGroupRoot(file, basePath);
				collected.push({
					path: file,
					name: basename(file),
					content: readFileSync(file),
					isBuildingBlock: groupInfo.type === "bb",
					isProcessApplication: groupInfo.type === "pa",
					groupPath: groupInfo.root || undefined,
				});
			}
		});

		// Process building block folders first (prioritized)
		bbFolders.forEach((bbFolder) => {
			collectResourceFiles(bbFolder, collected, basePath, ig, ignoreBaseDir);
		});

		// Then process regular folders
		regularFolders.forEach((regularFolder) => {
			collectResourceFiles(
				regularFolder,
				collected,
				basePath,
				ig,
				ignoreBaseDir,
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
 * Deploy resources
 */
/**
 * Collect deployable resources from the given paths, applying `.c8ignore`
 * rules. Throws on the two pre-API guard failures so callers (deploy
 * handler, watch, dry-run preview) all surface the same errors with the
 * same wording.
 *
 * Shared between `deployCommand` (used for both the dry-run preview and
 * the execute path via `deployResources`) and `deployResources` itself.
 */
function collectResourcesForPaths(paths: string[]): ResourceFile[] {
	if (paths.length === 0) {
		throw new Error(
			"No paths provided. Use: c8 deploy <path> or c8 deploy (for current directory)",
		);
	}

	// Load .c8ignore rules from the working directory
	const ignoreBaseDir = resolve(process.cwd());
	const ig = loadIgnoreRules(ignoreBaseDir);

	const resources: ResourceFile[] = [];
	paths.forEach((path) => {
		collectResourceFiles(path, resources, undefined, ig, ignoreBaseDir);
	});

	if (resources.length === 0) {
		throw new Error("No BPMN/DMN/Form files found in the specified paths");
	}

	return resources;
}

/**
 * Internal helper: deploy the given paths to the cluster and render the
 * result table. Used by `deployCommand` (the standard CLI entry point)
 * and by `watchCommand` (for change-triggered re-deploys).
 *
 * Does NOT consult `c8ctl.dryRun` — dry-run handling lives in the
 * `deployCommand` handler so the framework's `dryRun()` helper owns
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
	},
): Promise<void> {
	const logger = getLogger();
	const tenantId = resolveTenantId(options.profile);

	// ─── Pre-API-call validation and preparation ────────────────────────
	// These steps run OUTSIDE any try/catch so validation errors bubble
	// straight to the framework's `handleCommandError`. Only the actual
	// HTTP deploy call (further down) is wrapped in a catch that routes
	// through `handleDeploymentError` for rich Problem-Detail rendering.

	const resources = collectResourcesForPaths(paths);

	// Store the base paths for relative path calculation. Safe to assign
	// directly now: the empty-paths guard inside `collectResourcesForPaths`
	// has already thrown.
	const basePaths = paths;

	const client = createClient(options.profile);

	// Calculate relative paths for display
	const basePath = basePaths.length === 1 ? basePaths[0] : process.cwd();
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

	resources.forEach((r) => {
		const ext = extname(r.path);
		if (ext === ".bpmn" || ext === ".dmn") {
			const defId = extractDefinitionId(r.content, ext);
			if (defId) {
				definitionIdToResource.set(defId, r);
			}
		} else if (ext === ".form") {
			// Forms are matched by filename (without extension)
			const formId = basename(r.name, ".form");
			formNameToResource.set(formId, r);
		}
	});

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
	const allResources = [
		...result.processes.map((proc) => ({
			type: "Process" as const,
			id: proc.processDefinitionId,
			version: proc.processDefinitionVersion,
			key: proc.processDefinitionKey.toString(),
			resource: definitionIdToResource.get(proc.processDefinitionId),
		})),
		...result.decisions.map((dec) => ({
			type: "Decision" as const,
			id: dec.decisionDefinitionId || "-",
			version: dec.version ?? "-",
			key: dec.decisionDefinitionKey?.toString() || "-",
			resource: definitionIdToResource.get(dec.decisionDefinitionId || ""),
		})),
		...result.forms.map((form) => ({
			type: "Form" as const,
			id: form.formId || "-",
			version: form.version ?? "-",
			key: form.formKey?.toString() || "-",
			resource: formNameToResource.get(form.formId || ""),
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
): void {
	// Extract problem title early to determine whether this is a user-fixable error
	const raw: Record<string, unknown> = isRecord(error) ? error : {};
	const problemTitle = typeof raw.title === "string" ? raw.title : undefined;
	const isUserFixable = problemTitle === "INVALID_ARGUMENT";
	const shouldContinue =
		continueOnError || (continueOnUserError && isUserFixable);

	if (c8ctl.verbose) {
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
		if (
			line.startsWith("'") &&
			(line.includes(".bpmn") ||
				line.includes(".dmn") ||
				line.includes(".form"))
		) {
			// This is a file-specific error
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

// ─── defineCommand ───────────────────────────────────────────────────────────

/**
 * Side-effectful: collects files, validates, deploys, and renders its own
 * table output.
 *
 * The body lives directly in the handler (per #288): argument-shape
 * resolution, dry-run preview via the framework's `dryRun()` helper,
 * and the call into the shared `deployResources` helper that watch also
 * uses for change-triggered re-deploys.
 */
export const deployCommand = defineCommand("deploy", "", async (ctx) => {
	// Argument shape: `c8 deploy [path...]`. With no positional, default
	// to cwd. Pinned by tests/unit/deploy-behaviour.test.ts.
	const paths = ctx.resource
		? [ctx.resource, ...ctx.positionals]
		: ctx.positionals.length > 0
			? ctx.positionals
			: ["."];

	// Dry-run preview. Collect resources first so the preview body
	// reflects what would actually be sent — and so the empty-paths /
	// no-files guards still surface as thrown errors before we emit.
	// `dryRun()` returns null when `c8ctl.dryRun` is false, so this whole
	// block is a no-op outside dry-run mode.
	if (c8ctl.dryRun) {
		const previewResources = collectResourcesForPaths(paths);
		const tenantId = resolveTenantId(ctx.profile);
		const dr = dryRun({
			command: "deploy",
			method: "POST",
			endpoint: "/deployments",
			profile: ctx.profile,
			body: {
				tenantId,
				resources: previewResources.map((r) => ({ name: r.name })),
			},
		});
		if (dr) return dr;
	}

	// Execute path: `deployResources` re-runs `collectResourcesForPaths`
	// internally and renders the success table. The double-walk in
	// dry-run mode is intentional: keeping the helper self-contained
	// avoids threading pre-collected state between the handler and the
	// shared helper used by `watch`.
	await deployResources(paths, { profile: ctx.profile });
	return { kind: "none" };
});
