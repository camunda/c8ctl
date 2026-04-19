/**
 * Watch command - monitor files for changes and auto-deploy
 */

import { existsSync, statSync, watch } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { defineCommand } from "../command-framework.ts";
import { isIgnored, loadIgnoreRules } from "../ignore.ts";
import { deploy } from "./deployments.ts";

const WATCHED_EXTENSIONS = [".bpmn", ".dmn", ".form"];
export const DEPLOY_COOLDOWN = 1000; // 1 second cooldown
const DEBOUNCE_DELAY = 200; // ms to wait after last fs event before deploying

// ─── defineCommand ───────────────────────────────────────────────────────────

/**
 * Watch one or more paths for BPMN/DMN/Form changes and auto-deploy.
 *
 * Long-running: stays alive until SIGINT, then resolves so the framework
 * returns naturally with `{ kind: "never" }`. SIGTERM is handled by Node's
 * default behaviour (immediate termination).
 */
export const watchCommand = defineCommand("watch", "", async (ctx, flags) => {
	const { logger } = ctx;

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

	logger.info(`👁️  Watching for changes in: ${resolvedPaths.join(", ")}`);
	logger.info(`📋 Monitoring extensions: ${WATCHED_EXTENSIONS.join(", ")}`);
	if (flags.force) {
		logger.info(
			"🔒 Force mode: will continue watching after deployment errors",
		);
	}
	logger.info("Press Ctrl+C to stop watching\n");

	// Keep track of recently deployed files to avoid duplicate deploys
	const recentlyDeployed = new Map<string, number>();
	// Debounce timers per file to let writes settle before deploying
	const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

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
				if (!WATCHED_EXTENSIONS.includes(ext)) {
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

						try {
							await deploy([fullPath], {
								profile: ctx.profile,
								continueOnError: flags.force,
								continueOnUserError: true,
							});
						} catch (error) {
							logger.error(
								`Failed to deploy ${basename(file)}`,
								error instanceof Error ? error : new Error(String(error)),
							);
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
	// deploys, and resolve so the handler returns naturally. Cancelling
	// pending timers prevents a deploy from firing after Ctrl+C and keeps
	// the event loop from staying alive past shutdown. The framework
	// treats this as `{ kind: "never" }` and the process exits with code 0.
	await new Promise<void>((resolveSignal) => {
		process.once("SIGINT", () => {
			logger.info("\n\n🍹 - bottoms up.");
			for (const w of watchers) w.close();
			for (const timer of debounceTimers.values()) clearTimeout(timer);
			debounceTimers.clear();
			resolveSignal();
		});
	});

	return { kind: "never" };
});
