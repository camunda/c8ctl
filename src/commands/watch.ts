/**
 * Watch command - monitor files for changes and auto-deploy
 */

import { existsSync, statSync, watch } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { defineCommand } from "../command-framework.ts";
import { normalizeToError } from "../errors.ts";
import { isIgnored, loadIgnoreRules } from "../ignore.ts";
import { DEPLOY_COOLDOWN } from "../watch-constants.ts";
import { deployResources } from "./deployments.ts";
import { DEPLOYABLE_EXTENSIONS } from "./resource-extensions.ts";

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

	// Parse --extensions flag into an array of extensions
	const watchedExtensions =
		flags.extensions && String(flags.extensions).trim()
			? String(flags.extensions)
					.split(",")
					.map((e) => e.trim())
					.filter(Boolean)
					.map((e) => (e.startsWith(".") ? e : `.${e}`))
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

	// Load .c8ignore rules from the working directory
	const ignoreBaseDir = resolve(process.cwd());
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
				if (!watchedExtensions.includes(ext)) {
					return;
				}

				const fullPath = isDirectory ? resolve(path, filename) : path;

				// Skip files matching .c8ignore rules
				if (isIgnored(ig, fullPath, ignoreBaseDir)) {
					return;
				}

				// Clear any pending debounce for this file and restart the timer.
				// This ensures we wait until the file system is quiet before reading.
				const existing = debounceTimers.get(fullPath);
				if (existing) clearTimeout(existing);

				debounceTimers.set(
					fullPath,
					setTimeout(async () => {
						debounceTimers.delete(fullPath);

						// SIGINT may have fired between the timer being scheduled
						// and this callback running. Bail before doing any I/O.
						if (shuttingDown) return;

						// Check cooldown to prevent duplicate deploys
						const lastDeploy = recentlyDeployed.get(fullPath);
						const now = Date.now();
						if (lastDeploy && now - lastDeploy < DEPLOY_COOLDOWN) {
							return;
						}

						// Check if file still exists (might have been deleted)
						if (!existsSync(fullPath)) {
							logger.info(`⚠️  File deleted, skipping: ${basename(file)}`);
							return;
						}

						logger.info(`\n🔄 Change detected: ${basename(file)}`);
						recentlyDeployed.set(fullPath, Date.now());

						const ac = new AbortController();
						inflightDeploys.add(ac);
						try {
							await deployResources([fullPath], {
								profile: ctx.profile,
								continueOnError: flags.force,
								continueOnUserError: true,
								signal: ac.signal,
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
								`Failed to deploy ${basename(file)}`,
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
		logger.info(`📋 Monitoring extensions: ${watchedExtensions.join(", ")}`);
		if (flags.force) {
			logger.info(
				"🔒 Force mode: will continue watching after deployment errors",
			);
		}
		logger.info("Press Ctrl+C to stop watching\n");
	});

	return { kind: "never" };
});
