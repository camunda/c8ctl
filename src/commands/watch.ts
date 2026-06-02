/**
 * Watch command - monitor files for changes and auto-deploy
 */

import { existsSync, realpathSync, statSync, watch } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { createClient, normalizeToError } from "../core/index.ts";
import { defineCommand } from "../framework/index.ts";
import {
	ALL_DEPLOYABLE_EXTENSIONS,
	DEPLOY_COOLDOWN,
	DEPLOYABLE_EXTENSIONS,
	isIgnored,
	loadIgnoreRules,
	resolveIgnoreBaseDir,
} from "../utils/index.ts";
import {
	checkServerSupportsExtensions,
	deployResources,
	findProcessApplicationRoot,
	logMessage,
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

	// ── Process-application mode (#227) ──────────────────────────────
	// When --process-application is set, resolve the PA root from the
	// watched paths and expand the watch scope to the PA root so the
	// entire process application tree is monitored for changes.
	const paMode = Boolean(flags["process-application"] || flags.pa);
	let paRoot: string | null = null;
	if (paMode) {
		// Resolve PA root from every watched path and verify they all
		// belong to the same process application.
		let resolvedRoot: string | undefined;
		for (const p of resolvedPaths) {
			const root = findProcessApplicationRoot(p);
			if (!root) {
				throw new Error(
					`--process-application: no .process-application marker found above ${p}. ` +
						"Place a .process-application file at the root of your process application.",
				);
			}
			// Normalize via realpathSync so symlinks and equivalent
			// spellings of the same directory compare as equal.
			const normalizedRoot = realpathSync(root);
			if (resolvedRoot && normalizedRoot !== resolvedRoot) {
				throw new Error(
					"--process-application: all watched paths must belong to the same " +
						`process application. Path ${p} resolves to ${normalizedRoot}, ` +
						`but earlier paths resolved to ${resolvedRoot}`,
				);
			}
			resolvedRoot = normalizedRoot;
		}
		// Invariant: resolvedPaths always has ≥1 entry (defaults to ["."]),
		// so the loop above always runs at least once and sets resolvedRoot.
		// This guard satisfies the type checker — it cannot fire at runtime.
		if (!resolvedRoot) {
			throw new Error("--process-application requires at least one watch path");
		}
		paRoot = resolvedRoot;
		// Replace watched paths with the PA root so we monitor the entire
		// process application tree, not just the user-specified subdirectory.
		resolvedPaths.length = 0;
		resolvedPaths.push(paRoot);
	}

	// ── Pre-flight version check ──
	// Always perform the topology check — --force means "continue after
	// deploy errors", not "bypass extension filtering".
	const serverSupportsExtensions = await checkServerSupportsExtensions(
		createClient(ctx.profile),
	);

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
	const ignoreBaseDir = resolveIgnoreBaseDir(resolvedPaths);
	const ig = loadIgnoreRules(ignoreBaseDir);

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

				const ext = extname(filename);
				if (!effectiveExtensions.includes(ext)) {
					return;
				}

				const fullPath = isDirectory ? resolve(path, filename) : path;

				// Skip files matching .c8ignore rules
				if (isIgnored(ig, fullPath, ignoreBaseDir)) {
					return;
				}

				// In PA mode, key debounce/cooldown by the PA root so that
				// a burst of changes to different files collapses into a
				// single full-PA deploy within the debounce window.
				const debounceKey = paMode && paRoot ? paRoot : fullPath;

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
						// In PA mode, deletions are meaningful changes — the PA
						// should be redeployed without the removed file.
						if (!paMode && !existsSync(fullPath)) {
							logger.info(`⚠️  File deleted, skipping: ${basename(file)}`);
							return;
						}

						logger.info(`\n🔄 Change detected: ${basename(file)}`);
						recentlyDeployed.set(debounceKey, Date.now());

						// In PA mode, deploy the entire PA root instead of the
						// single changed file.
						const deployPaths = paMode && paRoot ? [paRoot] : [fullPath];

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
								`Failed to deploy ${paMode ? "process application" : basename(file)}`,
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
	await new Promise<void>((resolveSignal) => {
		process.once("SIGINT", () => {
			shuttingDown = true;
			logger.info("\n\n🍹 - bottoms up.");
			for (const w of watchers) w.close();
			for (const timer of debounceTimers.values()) clearTimeout(timer);
			debounceTimers.clear();
			for (const ac of inflightDeploys) ac.abort();
			inflightDeploys.clear();
			resolveSignal();
		});

		// Emit the readiness banner ONLY AFTER both the fs watchers and the
		// SIGINT handler are registered. Tests poll the "Watching for
		// changes" line as a readiness signal before dropping a file or
		// sending SIGINT; emitting it earlier (before fs.watch() returns)
		// races the file-system watcher registration on slow CI runners
		// (fs.watch backends differ per platform — inotify on Linux,
		// FSEvents on macOS, ReadDirectoryChangesW on Windows) and the
		// file event is silently lost.
		logger.info(`👁️  Watching for changes in: ${resolvedPaths.join(", ")}`);
		logger.info(`📋 Monitoring extensions: ${effectiveExtensions.join(", ")}`);
		if (paMode && paRoot) {
			logger.info(
				`📦 Process application mode: deploying all resources from ${paRoot}`,
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
