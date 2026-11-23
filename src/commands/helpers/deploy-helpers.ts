/**
 * CLI adapter for the deploy services (`src/services/`): resolves the
 * CLI's target (`--profile`, session, env), prints the services' events
 * and results, and renders deploy errors with actionable hints.
 *
 * Consumed by:
 * - `src/commands/deploy.ts` (the `deployCommand` handler)
 * - `src/commands/watch.ts` (change-triggered re-deploys)
 */

import { relative } from "node:path";
import type { CamundaClient } from "@camunda8/orchestration-cluster-api";
import {
	type C8ctlErrorCode,
	type C8ctlEvent,
	cliSdkLogLevel,
	getLogger,
	isC8ctlError,
	isRecord,
	normalizeToError,
	resolveClusterConfig,
	resolveTenantId,
	SilentError,
} from "../../core/index.ts";
import {
	checkServerSupportsExtensions as checkServerSupportsExtensionsOp,
	type DeployedResource,
	type DeployResult,
	deploy,
} from "../../services/index.ts";
import {
	type CollectResult,
	collectResourcesForPaths as collectResourcesForPathsOp,
	DEPLOYABLE_EXTENSIONS,
	type DeployPathPlan,
	type ProjectMarkerCache,
	planDeployPaths as planDeployPathsOp,
} from "../../utils/index.ts";

export {
	type DeployPathPlan,
	findProjectRoot,
	rejectSelectionFlagsForDescriptor,
} from "../../utils/index.ts";

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
export function logSkippedExtensions(
	skippedExtensions: ReadonlySet<string>,
): void {
	if (skippedExtensions.size === 0) return;
	const exts = [...skippedExtensions].sort().join(", ");
	logMessage(
		`Skipped files with extensions not in the allow-list (${exts}). ` +
			`Use --extensions=<ext> to add specific types, or --all-extensions to include all server-supported types.`,
	);
}

/**
 * Check whether the connected Camunda server supports extended file extensions.
 * Returns `true` for 8.10+, `false` for older versions or on any error.
 */
export function checkServerSupportsExtensions(
	client: CamundaClient,
): Promise<boolean> {
	return checkServerSupportsExtensionsOp(client, (message) =>
		getLogger().warn(message),
	);
}

/** `planDeployPaths` of the deploy services, announcing on stderr. */
export function planDeployPaths(
	paths: string[],
	options: { markerCache?: ProjectMarkerCache; announce?: boolean } = {},
): DeployPathPlan[] {
	return planDeployPathsOp(paths, { ...options, notify: logMessage });
}

/** Log the skipped-extensions hint carried by a `no-deployable-files` error. */
function logSkippedForNoFiles(error: unknown): void {
	if (!isC8ctlError(error) || error.code !== "no-deployable-files") return;
	const extensions = error.details?.skippedExtensions;
	if (Array.isArray(extensions)) {
		logSkippedExtensions(new Set(extensions.map(String)));
	}
}

/**
 * `collectResourcesForPaths` of the deploy services, with its notices
 * and the skipped-extensions hint printed to stderr.
 */
export function collectResourcesForPaths(
	paths: string[],
	force?: boolean,
	extensionList: readonly string[] = DEPLOYABLE_EXTENSIONS,
	loadDeployAlways = true,
	pinnedPlan?: DeployPathPlan[],
): CollectResult {
	try {
		return collectResourcesForPathsOp(
			paths,
			force,
			extensionList,
			loadDeployAlways,
			pinnedPlan,
			logMessage,
		);
	} catch (error) {
		logSkippedForNoFiles(error);
		throw error;
	}
}

/** Errors of the deployment request, rendered by `handleDeploymentError`. */
const REQUEST_ERROR_CODES: ReadonlySet<C8ctlErrorCode> = new Set([
	"connection-failed",
	"unauthorized",
	"forbidden",
	"payload-too-large",
	"deployment-rejected",
	"unknown",
]);

/** What the error hints need to know about a file that was sent. */
interface AttemptedResource {
	name: string;
	relativePath?: string;
	content: { byteLength: number };
}

const RESOURCE_TYPE_LABELS: Record<DeployedResource["type"], string> = {
	process: "Process",
	decision: "Decision",
	"decision-requirements": "Decision Requirements",
	form: "Form",
	resource: "Resource",
};

/** The display base for relative file paths. */
function displayBasePath(
	explicit: string | undefined,
	resolvedPaths: readonly string[],
): string {
	return (
		explicit ?? (resolvedPaths.length === 1 ? resolvedPaths[0] : process.cwd())
	);
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
		 * `createDeployment` HTTP request is cancelled. Cancellation is
		 * handled internally: `deployResources()` then returns early
		 * without surfacing the cancellation as a deploy failure.
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
		/** Plan resolved earlier in the same invocation (see
		 *  `collectResourcesForPaths`); descriptors are then not re-read. */
		plan?: DeployPathPlan[];
		/** Explicit tenant, bypassing session/env resolution. */
		tenantId?: string;
		/** When true, suppress success-path progress output (the "Deploying…"
		 *  line, the success confirmation and the deployed-resources table).
		 *  Failures still render in full. */
		quiet?: boolean;
		/** Logger override — defaults to the shared singleton. */
		logger?: ReturnType<typeof getLogger>;
	},
): Promise<void> {
	const logger = options.logger ?? getLogger();
	const tenantId = options.tenantId ?? resolveTenantId(options.profile);
	// The CLI host resolves its target from --profile, the session and the
	// environment; the service only receives the result.
	const cluster = resolveClusterConfig(options.profile);
	const plan = options.plan ?? planDeployPaths(paths);

	const onProgress = (event: C8ctlEvent): void => {
		if (event.type === "notice") {
			logMessage(event.message);
		} else if (event.type === "warning") {
			logger.warn(event.message);
		} else if (event.phase === "resolved") {
			const skipped = event.data?.skipped;
			if (!options.suppressSkippedLog && isSkipped(skipped)) {
				logSkippedExtensions(new Set(skipped.extensions));
			}
		} else if (event.phase === "deploy" && !options.quiet) {
			logger.info(`Deploying ${event.total} resource(s)...`);
		}
	};

	let result: DeployResult;
	try {
		result = await deploy(
			{
				target: { cluster },
				paths,
				tenantId,
				extensions: [...(options.extensionList ?? DEPLOYABLE_EXTENSIONS)],
				force: options.force,
			},
			{
				signal: options.signal,
				onProgress,
				env: process.env,
				sdkLogLevel: cliSdkLogLevel(),
			},
			{
				plan,
				serverSupportsExtensions: options.loadDeployAlways ?? true,
			},
		);
	} catch (error) {
		logSkippedForNoFiles(error);
		if (!isC8ctlError(error)) throw error;
		// Caller-initiated cancellation (e.g. SIGINT in `watch`) is not a
		// deploy failure.
		if (error.code === "cancelled") return;
		if (error.code === "duplicate-definition-ids") {
			renderDuplicateIds(error.message, error.details?.duplicates, logger);
			// Rendered above; the SilentError exits non-zero without a
			// duplicate summary line.
			throw new SilentError(error.message);
		}
		if (REQUEST_ERROR_CODES.has(error.code)) {
			handleDeploymentError(
				error.cause ?? error,
				attemptedResources(error.details, options.basePath),
				logger,
				options.continueOnError,
				options.continueOnUserError,
				options.verbose === true,
			);
			return;
		}
		throw error;
	}

	if (!options.quiet) {
		logger.success("Deployment successful", result.deploymentKey);
	}

	const basePath = displayBasePath(options.basePath, result.resolvedPaths);
	const rows = result.resources.map((resource) =>
		toTableRow(resource, basePath),
	);

	// Sort by directory path (grouping), then by file name
	rows.sort((a, b) => {
		if (a.sortKey !== b.sortKey) {
			return a.sortKey.localeCompare(b.sortKey);
		}
		return a.File.localeCompare(b.File);
	});

	const displayData = rows.map(({ File, Type, ID, Version, Key }) => ({
		File,
		Type,
		ID,
		Version,
		Key,
	}));

	if (displayData.length > 0 && !options.quiet) {
		logger.table(displayData);
	}
}

function isSkipped(
	value: unknown,
): value is { files: string[]; extensions: string[] } {
	return (
		typeof value === "object" &&
		value !== null &&
		"extensions" in value &&
		Array.isArray(value.extensions)
	);
}

function renderDuplicateIds(
	message: string,
	duplicates: unknown,
	logger: ReturnType<typeof getLogger>,
): void {
	logger.error(message);
	if (typeof duplicates === "object" && duplicates !== null) {
		for (const [id, dupPaths] of Object.entries(duplicates)) {
			const list = Array.isArray(dupPaths) ? dupPaths.join(", ") : "";
			logMessage(`  Process/Decision ID "${id}" found in: ${list}`);
		}
	}
	logMessage(
		"\nCamunda does not allow deploying multiple resources with the same definition ID in a single deployment.",
	);
	logMessage(
		"Please deploy these files separately or ensure each process/decision has a unique ID.",
	);
}

/** The files a failed request sent, from the error's `details.attempted`. */
function attemptedResources(
	details: Record<string, unknown> | undefined,
	explicitBasePath: string | undefined,
): AttemptedResource[] {
	const resolvedPaths = Array.isArray(details?.resolvedPaths)
		? details.resolvedPaths.map(String)
		: [];
	const basePath = displayBasePath(explicitBasePath, resolvedPaths);
	const attempted = Array.isArray(details?.attempted) ? details.attempted : [];
	return attempted.flatMap((entry: unknown) => {
		if (!isRecord(entry)) return [];
		const { path, name, bytes } = entry;
		if (typeof path !== "string" || typeof name !== "string") return [];
		return [
			{
				name,
				relativePath: relative(basePath, path) || name,
				content: { byteLength: typeof bytes === "number" ? bytes : 0 },
			},
		];
	});
}

interface ResourceRow {
	File: string;
	Type: string;
	ID: string;
	Version: string | number;
	Key: string;
	sortKey: string;
}

function toTableRow(resource: DeployedResource, basePath: string): ResourceRow {
	const file = resource.file;
	const relativePath = file ? relative(basePath, file.path) || file.name : "";
	const fileDisplay = file
		? `${file.group?.kind === "building-block" ? "🧱 " : ""}${file.group?.kind === "project" ? "📦 " : ""}${relativePath}`
		: "-";

	// Directory path for grouping (e.g. "bla/_bb-building-block" or "pa");
	// resources without a file go last.
	const sortKey = relativePath
		? relativePath.substring(0, relativePath.lastIndexOf("/") + 1) ||
			relativePath
		: "zzz";

	return {
		File: fileDisplay,
		Type: RESOURCE_TYPE_LABELS[resource.type],
		ID: resource.id ?? "-",
		Version: resource.version ?? "-",
		Key: resource.key ?? "-",
		sortKey,
	};
}

/**
 * Format and display deployment errors with actionable guidance
 */
function handleDeploymentError(
	error: unknown,
	resources: AttemptedResource[],
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

	// HTTP 413 is raised by the cluster ingress (body-size limit), not the
	// engine — it arrives as a bare "HTTP 413" with no Problem-Detail body.
	// Give it a self-explanatory title so the "Deployment failed" line and
	// the rethrown SilentError both read clearly. The actionable detail
	// (payload size, largest file, how to split) is added by
	// `printDeploymentHints`, keyed off `status === 413`.
	const effectiveTitle =
		status === 413 ? "Payload too large (HTTP 413)" : title;

	// Display the main error
	logger.error("Deployment failed", new Error(effectiveTitle));

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
	throw new SilentError(effectiveTitle);
}

/**
 * Format a byte count as a human-readable size (e.g. "1.5 MB").
 * Used by the HTTP 413 hint so the user sees roughly how large the
 * rejected payload was.
 */
function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KB", "MB", "GB", "TB"];
	let value = bytes / 1024;
	let unitIndex = 0;
	while (value >= 1024 && unitIndex < units.length - 1) {
		value /= 1024;
		unitIndex++;
	}
	return `${value.toFixed(1)} ${units[unitIndex]}`;
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
	resources: AttemptedResource[],
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
	} else if (status === 413) {
		const totalBytes = resources.reduce(
			(sum, r) => sum + r.content.byteLength,
			0,
		);
		hints.push(
			`💡 The deployment payload (~${formatBytes(totalBytes)} across ${resources.length} resource(s)) exceeded the cluster's request body-size limit.`,
		);
		hints.push(
			"   This limit is enforced by the cluster ingress, not the engine, so the whole deployment was rejected before reaching Camunda — nothing was deployed.",
		);
		if (resources.length > 0) {
			const largest = resources.reduce((max, r) =>
				r.content.byteLength > max.content.byteLength ? r : max,
			);
			hints.push(
				`   Largest single resource: ${largest.relativePath || largest.name} (~${formatBytes(largest.content.byteLength)}).`,
			);
		}
		hints.push(
			"   Split the resources across multiple `c8 deploy` runs so each request stays under the limit.",
		);
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
