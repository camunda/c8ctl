/**
 * Shared deployment helpers — deployment execution and its rendering for
 * the CLI. Which files a deploy sends is resolved by the services layer
 * (`src/utils/shared/deploy-resolution.ts`); the wrappers below print its
 * notices.
 *
 * Consumed by:
 * - `src/commands/deploy.ts` (the `deployCommand` handler)
 * - `src/commands/watch.ts` (change-triggered re-deploys)
 */

import { basename, extname, relative } from "node:path";
import type { CamundaClient } from "@camunda8/orchestration-cluster-api";
import { TenantId } from "@camunda8/orchestration-cluster-api";
import {
	createClient,
	getLogger,
	isC8ctlError,
	isRecord,
	normalizeToError,
	resolveTenantId,
	SilentError,
} from "../../core/index.ts";
import {
	type CollectResult,
	collectResourcesForPaths as collectResourcesForPathsOp,
	DEPLOYABLE_EXTENSIONS,
	type DeployPathPlan,
	extractDefinitionId,
	findDuplicateDefinitionIds,
	meetsMinExtensionVersion,
	type ProjectMarkerCache,
	planDeployPaths as planDeployPathsOp,
	type ResourceFile,
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

/** `planDeployPaths` of the services layer, announcing on stderr. */
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
 * `collectResourcesForPaths` of the services layer, with its notices and
 * the skipped-extensions hint printed to stderr.
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
		/** Plan resolved earlier in the same invocation (see
		 *  `collectResourcesForPaths`); descriptors are then not re-read. */
		plan?: DeployPathPlan[];
		/** Explicit tenant, bypassing session/env resolution. `c8ctl setup`
		 *  uses it to pin the local cluster's default tenant. */
		tenantId?: string;
		/** When true, suppress success-path progress output (the "Deploying…"
		 *  line, the success confirmation and the deployed-resources table).
		 *  `c8ctl setup` uses it: the step report is the signal. Failures
		 *  still render in full. */
		quiet?: boolean;
		/** Logger override — defaults to the shared singleton. `c8ctl setup`
		 *  passes its buffered step logger so failure diagnostics close the
		 *  step's title line before printing instead of colliding with it. */
		logger?: ReturnType<typeof getLogger>;
	},
): Promise<void> {
	const logger = options.logger ?? getLogger();
	const tenantId = options.tenantId ?? resolveTenantId(options.profile);

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
			options.plan,
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

	if (!options.quiet) {
		logger.info(`Deploying ${resources.length} resource(s)...`);
	}

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

	if (!options.quiet) {
		logger.success("Deployment successful", result.deploymentKey.toString());
	}

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

	if (displayData.length > 0 && !options.quiet) {
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
