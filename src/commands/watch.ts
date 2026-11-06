/**
 * Watch command - monitor files for changes and auto-deploy
 */

import { existsSync, realpathSync, statSync, watch } from "node:fs";
import { basename, extname, resolve, sep } from "node:path";
import { createClient, normalizeToError, SilentError } from "../core/index.ts";
import { defineCommand } from "../framework/index.ts";
import {
	ALL_DEPLOYABLE_EXTENSIONS,
	CAMUNDA_PROJECT_FILE,
	DEPLOY_COOLDOWN,
	DEPLOYABLE_EXTENSIONS,
	declaresDeployResources,
	isIgnored,
	loadIgnoreRules,
	readDeployResources,
	resolveDeployResources,
	resolveIgnoreBaseDir,
} from "../utils/index.ts";
import {
	checkServerSupportsExtensions,
	deployResources,
	findProjectRoot,
	logMessage,
	rejectSelectionFlagsForDescriptor,
} from "./helpers/deploy-helpers.ts";

export { DEPLOY_COOLDOWN };

const DEBOUNCE_DELAY = 200; // ms to wait after last fs event before deploying

// ─── defineCommand ───────────────────────────────────────────────────────────

/**
 * Watch one or more paths for BPMN/DMN/Form changes and auto-deploy.
 *
 * Long-running: stays alive until SIGINT, then closes watchers, cancels
 * any pending debounced deploys AND aborts any in-flight HTTP deploys via
 * AbortController, then resolves so the framework returns naturally with
 * `{ kind: "never" }`. SIGTERM is handled by Node's default behaviour
 * (immediate termination).
 */
export const watchCommand = defineCommand("watch", "", async (ctx, flags) => {
	const { logger } = ctx;

	// Parse --extensions / --all-extensions flags into an array of extensions.
	// --extensions merges with the defaults (same semantics as deploy).
	const watchedExtensions = flags["all-extensions"]
		? ALL_DEPLOYABLE_EXTENSIONS
		: flags.extensions && String(flags.extensions).trim()
			? [
					...new Set([
						...DEPLOYABLE_EXTENSIONS,
						...String(flags.extensions)
							.split(",")
							.map((e) => e.trim())
							.filter(Boolean)
							.map((e) => (e.startsWith(".") ? e : `.${e}`)),
					]),
				]
			: DEPLOYABLE_EXTENSIONS;

	// watch treats resource + positionals as path varargs; default to "."
	const rawPaths = ctx.resource
		? [ctx.resource, ...ctx.positionals]
		: ctx.positionals.length > 0
			? ctx.positionals
			: ["."];

	const resolvedPaths = rawPaths.map((p) => resolve(p));

	for (const path of resolvedPaths) {
		if (!existsSync(path)) {
			throw new Error(`Path does not exist: ${path}`);
		}
	}

	// ── Project mode ───────────────────────────────────────────────────
	// When --project (or the deprecated aliases --process-application /
	// --pa) is set, resolve the project root from the watched paths and
	// expand the watch scope to the project root so the entire Camunda
	// project tree is monitored for changes. A project root is marked by
	// a camunda.json descriptor or a legacy .process-application file.
	const projectMode = Boolean(
		flags.project || flags["process-application"] || flags.pa,
	);
	if (!flags.project && (flags["process-application"] || flags.pa)) {
		logMessage(
			"Warning: --process-application/--pa is deprecated, use --project instead.",
		);
	}
	let projectRoot: string | null = null;
	if (projectMode) {
		// Resolve the project root from every watched path and verify they
		// all belong to the same Camunda project.
		let resolvedRoot: string | undefined;
		for (const p of resolvedPaths) {
			const root = findProjectRoot(p);
			if (!root) {
				throw new Error(
					`--project: no camunda.json or .process-application marker found above ${p}. ` +
						"Place a camunda.json file at the root of your Camunda project.",
				);
			}
			// Normalize via realpathSync so symlinks and equivalent
			// spellings of the same directory compare as equal.
			const normalizedRoot = realpathSync(root);
			if (resolvedRoot && normalizedRoot !== resolvedRoot) {
				throw new Error(
					"--project: all watched paths must belong to the same " +
						`Camunda project. Path ${p} resolves to ${normalizedRoot}, ` +
						`but earlier paths resolved to ${resolvedRoot}`,
				);
			}
			resolvedRoot = normalizedRoot;
		}
		// Invariant: resolvedPaths always has ≥1 entry (defaults to ["."]),
		// so the loop above always runs at least once and sets resolvedRoot.
		// This guard satisfies the type checker — it cannot fire at runtime.
		if (!resolvedRoot) {
			throw new Error("--project requires at least one watch path");
		}
		projectRoot = resolvedRoot;
		// Replace watched paths with the project root so we monitor the
		// entire project tree, not just the user-specified subdirectory.
		resolvedPaths.length = 0;
		resolvedPaths.push(projectRoot);
	}

	// ── deployResources (project mode) ─────────────────────────────────
	// When the project descriptor declares `deployResources`, the watcher
	// tracks the descriptor-selected set instead of an extension list:
	// changes to selected files (create, modify, delete, rename) redeploy
	// the re-resolved set, and a camunda.json edit redeploys only when it
	// changes the set. `--force` keeps its meaning of "continue after
	// errors" (including invalid configuration / empty selection).
	const descriptorMode =
		projectRoot !== null && declaresDeployResources(projectRoot);
	if (descriptorMode && projectRoot) {
		rejectSelectionFlagsForDescriptor({
			descriptorRoots: [projectRoot],
			extensions: flags.extensions,
			allExtensions: flags["all-extensions"],
		});
	}
	/** Resolve the current selection; throws on invalid config / empty set. */
	const resolveSelection = (root: string): string[] => {
		const patterns = readDeployResources(root);
		if (patterns === null) {
			throw new Error(
				'"deployResources" was removed from camunda.json. ' +
					"Restart `c8 watch --project` to watch the default resource scan.",
			);
		}
		return resolveDeployResources(root, patterns);
	};
	let selected: string[] = [];
	if (descriptorMode && projectRoot) {
		try {
			selected = resolveSelection(projectRoot);
		} catch (error) {
			if (!flags.force) throw error;
			logger.error(
				"Invalid resource selection",
				normalizeToError(error, "Invalid resource selection"),
			);
		}
	}

	// ── Pre-flight version check ──
	// Always perform the topology check for extension-based watching —
	// --force means "continue after deploy errors", not "bypass extension
	// filtering". A `deployResources` selection is independent of the
	// server version, so it needs no check.
	const serverSupportsExtensions = descriptorMode
		? true
		: await checkServerSupportsExtensions(createClient(ctx.profile));

	// Clamp watched extensions on servers that don't support extended types.
	// Note: explicit file paths bypass extension filtering by design, so
	// this only gates which fs events trigger a deploy.
	const userRequestedExtensions =
		!!flags["all-extensions"] ||
		!!(flags.extensions && String(flags.extensions).trim());
	const effectiveExtensions = serverSupportsExtensions
		? watchedExtensions
		: DEPLOYABLE_EXTENSIONS;

	if (!serverSupportsExtensions && userRequestedExtensions) {
		logMessage(
			`Warning: server does not support extended extensions (requires 8.10+). ` +
				`Falling back to default extensions (${DEPLOYABLE_EXTENSIONS.join(", ")}).`,
		);
	}

	// Load .c8ignore rules from the target directory (not cwd) so that
	// `c8 watch <target>` picks up the .c8ignore inside the target. (#258)
	// A `deployResources` selection ignores .c8ignore, so it is not read.
	const ignoreBaseDir = resolveIgnoreBaseDir(resolvedPaths);
	const ig = descriptorMode ? null : loadIgnoreRules(ignoreBaseDir);

	// Keep track of recently deployed files to avoid duplicate deploys
	const recentlyDeployed = new Map<string, number>();
	// Debounce timers per file to let writes settle before deploying
	const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
	// AbortControllers for in-flight deploys, so SIGINT can cancel them
	// promptly instead of waiting for the HTTP round-trip to finish.
	const inflightDeploys = new Set<AbortController>();
	// Set on SIGINT to short-circuit any debounce callback that fires
	// between signal receipt and the synchronous shutdown work below.
	let shuttingDown = false;
	// Rejects the lifecycle promise below — used to stop watching on an
	// invalid `deployResources` configuration when --force is not set.
	let failWatch: ((error: Error) => void) | undefined;
	// Project-relative paths changed since the last descriptor-mode
	// resolution (collapsed by the debounce window).
	const pendingChanges = new Set<string>();

	/**
	 * Descriptor mode: re-resolve the selection after a burst of changes
	 * and redeploy when a selected file changed or the selected set did.
	 */
	const onDescriptorModeChange = async (root: string): Promise<void> => {
		// Pending changes are kept until a resolution succeeds, so edits made
		// while the descriptor is invalid (--force) are deployed on recovery.
		const changed = [...pendingChanges];

		let next: string[];
		try {
			next = resolveSelection(root);
			pendingChanges.clear();
		} catch (error) {
			const err = normalizeToError(error, "Invalid resource selection");
			logger.error("Invalid resource selection", err);
			if (flags.force) {
				logger.info("Continuing to watch (--force).");
				return;
			}
			failWatch?.(new SilentError(err.message));
			return;
		}

		const previous = new Set(selected);
		const current = new Set(next);
		selected = next;
		const setChanged =
			previous.size !== current.size || next.some((rel) => !previous.has(rel));
		const touches = (rel: string) =>
			[...previous, ...current].some(
				(file) => file === rel || file.startsWith(`${rel}/`),
			);
		const selectedFileChanged = changed.some(
			(rel) => rel !== CAMUNDA_PROJECT_FILE && touches(rel),
		);
		if (!setChanged && !selectedFileChanged) {
			if (changed.includes(CAMUNDA_PROJECT_FILE)) {
				logger.info(
					"camunda.json changed; the selected resources are unchanged — not redeploying",
				);
			}
			return;
		}

		logger.info(
			`\n🔄 Change detected: ${changed.join(", ")} — deploying ${next.length} selected resource(s)`,
		);
		recentlyDeployed.set(root, Date.now());
		const ac = new AbortController();
		inflightDeploys.add(ac);
		try {
			await deployResources([root], {
				profile: ctx.profile,
				continueOnError: flags.force,
				continueOnUserError: true,
				signal: ac.signal,
				verbose: ctx.verbose,
			});
		} catch (error) {
			if (ac.signal.aborted) return;
			logger.error(
				"Failed to deploy project",
				normalizeToError(error, "Deployment request failed"),
			);
		} finally {
			inflightDeploys.delete(ac);
		}
	};

	/** Debounce descriptor-mode changes into one re-resolution. */
	const scheduleDescriptorModeChange = (root: string, delay: number): void => {
		const existing = debounceTimers.get(root);
		if (existing) clearTimeout(existing);
		debounceTimers.set(
			root,
			setTimeout(() => {
				debounceTimers.delete(root);
				if (shuttingDown) return;
				// Within the cooldown, postpone rather than drop: the pending
				// changes must still be resolved once the window passes.
				const lastDeploy = recentlyDeployed.get(root);
				const remaining = lastDeploy
					? DEPLOY_COOLDOWN - (Date.now() - lastDeploy)
					: 0;
				if (remaining > 0) {
					scheduleDescriptorModeChange(root, remaining);
					return;
				}
				void onDescriptorModeChange(root);
			}, delay),
		);
	};

	// Watch each path
	const watchers = resolvedPaths.map((path) => {
		const stats = statSync(path);
		const isDirectory = stats.isDirectory();

		const watcher = watch(
			path,
			{ recursive: isDirectory },
			(_eventType, filename) => {
				if (!filename) return;

				const file = filename;

				if (descriptorMode && projectRoot) {
					pendingChanges.add(filename.split(sep).join("/"));
					scheduleDescriptorModeChange(projectRoot, DEBOUNCE_DELAY);
					return;
				}

				const ext = extname(filename);
				if (!effectiveExtensions.includes(ext)) {
					return;
				}

				// The project descriptor is metadata, never a deployable
				// resource. In project mode a descriptor change still
				// triggers a full project redeploy below.
				if (!projectMode && basename(filename) === CAMUNDA_PROJECT_FILE) {
					return;
				}

				const fullPath = isDirectory ? resolve(path, filename) : path;

				// Skip files matching .c8ignore rules
				if (ig && isIgnored(ig, fullPath, ignoreBaseDir)) {
					return;
				}

				// In project mode, key debounce/cooldown by the project root
				// so that a burst of changes to different files collapses
				// into a single full-project deploy within the debounce window.
				const debounceKey = projectMode && projectRoot ? projectRoot : fullPath;

				// Clear any pending debounce for this key and restart the timer.
				// This ensures we wait until the file system is quiet before reading.
				const existing = debounceTimers.get(debounceKey);
				if (existing) clearTimeout(existing);

				debounceTimers.set(
					debounceKey,
					setTimeout(async () => {
						debounceTimers.delete(debounceKey);

						// SIGINT may have fired between the timer being scheduled
						// and this callback running. Bail before doing any I/O.
						if (shuttingDown) return;

						// Check cooldown to prevent duplicate deploys
						const lastDeploy = recentlyDeployed.get(debounceKey);
						const now = Date.now();
						if (lastDeploy && now - lastDeploy < DEPLOY_COOLDOWN) {
							return;
						}

						// Check if file still exists (might have been deleted).
						// In project mode, deletions are meaningful changes — the
						// project should be redeployed without the removed file.
						if (!projectMode && !existsSync(fullPath)) {
							logger.info(`⚠️  File deleted, skipping: ${basename(file)}`);
							return;
						}

						logger.info(`\n🔄 Change detected: ${basename(file)}`);
						recentlyDeployed.set(debounceKey, Date.now());

						// In project mode, deploy the entire project root instead
						// of the single changed file.
						const deployPaths =
							projectMode && projectRoot ? [projectRoot] : [fullPath];

						const ac = new AbortController();
						inflightDeploys.add(ac);
						try {
							await deployResources(deployPaths, {
								profile: ctx.profile,
								continueOnError: flags.force,
								continueOnUserError: true,
								signal: ac.signal,
								verbose: ctx.verbose,
								loadDeployAlways: serverSupportsExtensions,
								extensionList: effectiveExtensions,
							});
						} catch (error) {
							// `deployResources()` normally returns early when its signal
							// is aborted, so SIGINT cancellation is not expected to land
							// here. Keep this as a defensive fallback in case an
							// aborted deploy ever re-throws — and never log it as a
							// deploy failure, since the goodbye message is the
							// user-visible shutdown signal.
							if (ac.signal.aborted) return;
							logger.error(
								`Failed to deploy ${projectMode ? "project" : basename(file)}`,
								normalizeToError(error, "Deployment request failed"),
							);
						} finally {
							inflightDeploys.delete(ac);
						}
					}, DEBOUNCE_DELAY),
				);
			},
		);

		// Handle watcher errors
		watcher.on("error", (error) => {
			logger.error("Watcher error", error);
		});

		return watcher;
	});

	// Block until SIGINT, then close watchers, cancel any pending debounced
	// deploys, abort any in-flight HTTP deploys, and resolve so the handler
	// returns naturally. The framework treats this as `{ kind: "never" }`
	// and the process exits with code 0.
	//
	// We deliberately do NOT call `process.exit()` here:
	// - `shuttingDown = true` short-circuits any debounce callback that fires
	//   between SIGINT and this synchronous block.
	// - `clearTimeout(...)` cancels any timer that hasn't fired yet.
	// - `ac.abort()` cancels the underlying SDK CancelablePromise for any
	//   deploy currently waiting on the network — those callsites detect
	//   `signal.aborted` and swallow the AbortError instead of logging.
	// Together these drain the event loop within one tick, so the framework
	// can return naturally and own the exit code.
	await new Promise<void>((resolveSignal, rejectSignal) => {
		const shutdown = () => {
			shuttingDown = true;
			for (const w of watchers) w.close();
			for (const timer of debounceTimers.values()) clearTimeout(timer);
			debounceTimers.clear();
			for (const ac of inflightDeploys) ac.abort();
			inflightDeploys.clear();
		};
		const onSigint = () => {
			logger.info("\n\n🍹 - bottoms up.");
			shutdown();
			resolveSignal();
		};
		failWatch = (error) => {
			process.off("SIGINT", onSigint);
			shutdown();
			rejectSignal(error);
		};
		process.once("SIGINT", onSigint);

		// Emit the readiness banner ONLY AFTER both the fs watchers and the
		// SIGINT handler are registered. Tests poll the "Watching for
		// changes" line as a readiness signal before dropping a file or
		// sending SIGINT; emitting it earlier (before fs.watch() returns)
		// races the file-system watcher registration on slow CI runners
		// (fs.watch backends differ per platform — inotify on Linux,
		// FSEvents on macOS, ReadDirectoryChangesW on Windows) and the
		// file event is silently lost.
		logger.info(`👁️  Watching for changes in: ${resolvedPaths.join(", ")}`);
		if (descriptorMode) {
			logger.info(
				`📋 Monitoring ${selected.length} resource(s) selected by "deployResources" in camunda.json`,
			);
		} else {
			logger.info(
				`📋 Monitoring extensions: ${effectiveExtensions.join(", ")}`,
			);
		}
		if (projectMode && projectRoot) {
			logger.info(
				`📦 Project mode: deploying all resources from ${projectRoot}`,
			);
		}
		if (flags.force) {
			logger.info(
				"🔒 Force mode: will continue watching after deployment errors",
			);
		}
		logger.info("Press Ctrl+C to stop watching\n");
	});

	return { kind: "never" };
});
