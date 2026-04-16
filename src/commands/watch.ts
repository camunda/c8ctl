/**
 * Watch command - monitor files for changes and auto-deploy
 */

import { existsSync, statSync, watch } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { defineCommand } from "../command-framework.ts";
import { isIgnored, loadIgnoreRules } from "../ignore.ts";
import { getLogger } from "../logger.ts";
import { deploy } from "./deployments.ts";

export const DEFAULT_WATCHED_EXTENSIONS = [
	".bpmn",
	".dmn",
	".form",
	".md",
	".txt",
	".xml",
	".rpa",
	".json",
	".config",
	".yml",
	".yaml",
];
export const DEPLOY_COOLDOWN = 1000; // 1 second cooldown
const DEBOUNCE_DELAY = 200; // ms to wait after last fs event before deploying

/**
 * Watch for file changes and auto-deploy
 */
export async function watchFiles(
	paths: string[],
	options: {
		profile?: string;
		force?: boolean;
		extensions?: string[];
	},
): Promise<void> {
	const logger = getLogger();

	const watchedExtensions =
		options.extensions && options.extensions.length > 0
			? options.extensions
			: DEFAULT_WATCHED_EXTENSIONS;

	if (!paths || paths.length === 0) {
		paths = ["."];
	}

	// Resolve all paths
	const resolvedPaths = paths.map((p) => resolve(p));

	// Validate paths exist
	for (const path of resolvedPaths) {
		if (!existsSync(path)) {
			logger.error(`Path does not exist: ${path}`);
			process.exit(1);
		}
	}

	// Load .c8ignore rules from the working directory
	const ignoreBaseDir = resolve(process.cwd());
	const ig = loadIgnoreRules(ignoreBaseDir);

	logger.info(`👁️  Watching for changes in: ${resolvedPaths.join(", ")}`);
	logger.info(`📋 Monitoring extensions: ${watchedExtensions.join(", ")}`);
	if (options.force) {
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
	for (const path of resolvedPaths) {
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
								profile: options.profile,
								continueOnError: options.force,
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
	}

	// Keep process alive
	process.on("SIGINT", () => {
		logger.info("\n\n🍹 - bottoms up.");
		process.exit(0);
	});
}

// ─── defineCommand wrapper ───────────────────────────────────────────────────

export const watchCommand = defineCommand("watch", "", async (ctx, flags) => {
	// watch treats resource + positionals as path varargs
	const paths = ctx.resource
		? [ctx.resource, ...ctx.positionals]
		: ctx.positionals.length > 0
			? ctx.positionals
			: ["."];
	const extensions =
		flags.extensions && String(flags.extensions).trim()
			? String(flags.extensions)
					.split(",")
					.map((e) => e.trim())
					.filter(Boolean)
					.map((e) => (e.startsWith(".") ? e : `.${e}`))
			: undefined;
	await watchFiles(paths, {
		profile: ctx.profile,
		force: flags.force,
		extensions,
	});
	return { kind: "never" };
});
