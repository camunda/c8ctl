/**
 * Plugin management commands
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineCommand } from "../command-framework.ts";
import { ensurePluginsDir } from "../config.ts";
import { handleCommandError } from "../errors.ts";
import { getLogger } from "../logger.ts";
import { clearLoadedPlugins } from "../plugin-loader.ts";
import {
	addPluginToRegistry,
	getPluginEntry,
	getRegisteredPlugins,
	isPluginRegistered,
	removePluginFromRegistry,
} from "../plugin-registry.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
type ExecFileErrorWithStdout = Error & {
	status?: number;
	stdout?: Buffer | string;
};

function isExecFileError(error: unknown): error is ExecFileErrorWithStdout {
	return error instanceof Error && "stdout" in error;
}

function isAcceptedUrl(input: string): boolean {
	return /^(https?:\/\/|git(\+https|\+ssh)?:\/\/|file:\/\/?)/i.test(input);
}

function getTemplate(templateFileName: string): string {
	const templatePath = join(__dirname, "..", "templates", templateFileName);
	return readFileSync(templatePath, "utf-8");
}

function renderTemplate(
	templateFileName: string,
	replacements: Record<string, string> = {},
): string {
	let content = getTemplate(templateFileName);
	for (const [key, value] of Object.entries(replacements)) {
		content = content.replaceAll(`{{${key}}}`, value);
	}
	return content;
}

/**
 * Load a plugin (npm install wrapper)
 * Supports either package name or --from flag with URL
 * Installs to global plugins directory
 */
export const loadPluginCommand = defineCommand(
	"load",
	"plugin",
	async (ctx, flags, args) => {
		const { logger } = ctx;
		const packageName = args.package;
		const fromUrl = flags.from;

		// Validate input
		if (fromUrl && packageName) {
			throw new Error(
				'Cannot specify both a positional argument and --from flag. Use either "c8 load plugin <name>" or "c8 load plugin --from <url>"',
			);
		}

		if (!packageName && !fromUrl) {
			throw new Error(
				"Package name or URL required. Usage: c8 load plugin <name> or c8 load plugin --from <url>",
			);
		}

		if (fromUrl && !isAcceptedUrl(fromUrl)) {
			throw new Error(
				"Invalid URL format. Accepted URL formats include file://, https://, git:// (see help for more)",
			);
		}

		if (packageName && isAcceptedUrl(packageName)) {
			throw new Error(
				"Package name cannot be a URL. If you want to load from a URL, use the --from flag. Usage: c8 load plugin --from <url>",
			);
		}

		// Get global plugins directory
		const pluginsDir = ensurePluginsDir();

		try {
			let pluginName: string;
			let pluginSource: string;

			if (fromUrl) {
				// Snapshot existing plugins before installation so we can identify the new one
				const existingPluginNames = getInstalledPluginNames(pluginsDir);

				// Install from URL (file://, https://, git://, etc.)
				logger.info(`Loading plugin from: ${fromUrl}...`);
				execFileSync("npm", ["install", fromUrl, "--prefix", pluginsDir], {
					stdio: "inherit",
				});

				// Extract package name from installed package
				pluginName = extractPackageNameFromUrl(
					fromUrl,
					pluginsDir,
					existingPluginNames,
				);
				pluginSource = fromUrl;

				// Validate plugin name
				if (!pluginName || pluginName.trim() === "") {
					logger.info(
						"Ensure the URL points to a valid npm package with a package.json file",
					);
					throw new Error("Failed to extract plugin name from URL");
				}

				logger.success("Plugin loaded successfully from URL", fromUrl);
			} else {
				// Install from npm registry by package name
				if (!packageName)
					throw new Error("unreachable: packageName is required");

				logger.info(`Loading plugin: ${packageName}...`);
				execFileSync("npm", ["install", packageName, "--prefix", pluginsDir], {
					stdio: "inherit",
				});

				pluginName = packageName;
				pluginSource = packageName;

				logger.success("Plugin loaded successfully", packageName);
			}

			// Add to plugin registry
			addPluginToRegistry(pluginName, pluginSource);
			logger.debug(`Added ${pluginName} to plugin registry`);

			// Note: Plugin will be available on next CLI invocation
			// We don't reload in the same process to avoid module cache issues
			logger.info("Plugin will be available on next command execution");
		} catch (error) {
			handleCommandError(logger, "Failed to load plugin", error, [
				"Check that the plugin name/URL is correct and you have network access if loading from a remote source",
			]);
		}
	},
);

/**
 * Check if a package has a c8ctl plugin file
 */
function hasPluginFile(packagePath: string): boolean {
	return (
		existsSync(join(packagePath, "c8ctl-plugin.js")) ||
		existsSync(join(packagePath, "c8ctl-plugin.ts"))
	);
}

/**
 * Check if a package is a valid c8ctl plugin
 */
function isValidPlugin(pkgPath: string): boolean {
	const pkgJsonPath = join(pkgPath, "package.json");
	if (!existsSync(pkgJsonPath)) return false;

	try {
		const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
		return hasPluginFile(pkgPath) && pkgJson.keywords?.includes("c8ctl");
	} catch {
		return false;
	}
}

/**
 * Get package name from a valid plugin directory
 */
function getPackageName(pkgPath: string): string | null {
	const pkgJsonPath = join(pkgPath, "package.json");
	try {
		const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
		return pkgJson.name;
	} catch {
		return null;
	}
}

/**
 * Try to read package name from source URL/path package.json
 */
function getPackageNameFromSourceUrl(url: string): string | null {
	const URL_SCHEME_PATTERN = /^[a-zA-Z]+:/;
	let sourcePath: string | null = null;
	try {
		if (url.startsWith("file:")) {
			sourcePath = fileURLToPath(url);
		} else if (!URL_SCHEME_PATTERN.test(url)) {
			sourcePath = url;
		}
	} catch {
		sourcePath = null;
	}

	if (!sourcePath) return null;

	const packageName = getPackageName(sourcePath);
	if (packageName && packageName.trim() !== "") {
		return packageName;
	}
	return null;
}

function listTopLevelDependencies(pluginsDir: string): string[] {
	const npmListArgs = [
		"list",
		"--depth",
		"0",
		"--json",
		"--prefix",
		pluginsDir,
	];
	const parseDependencyNames = (value: string): string[] => {
		try {
			const parsed = JSON.parse(value);
			if (typeof parsed !== "object" || parsed === null) return [];
			const { dependencies } = parsed;
			if (!dependencies || typeof dependencies !== "object") return [];
			return Object.keys(dependencies);
		} catch {
			return [];
		}
	};

	try {
		const output = execFileSync("npm", npmListArgs, {
			stdio: ["ignore", "pipe", "pipe"],
			encoding: "utf-8",
		});
		return parseDependencyNames(output);
	} catch (error: unknown) {
		// npm list can return non-zero exit codes (e.g. unmet peer deps) and still print valid JSON to stdout
		if (!isExecFileError(error) || !error.stdout) return [];
		return parseDependencyNames(
			typeof error.stdout === "string"
				? error.stdout
				: error.stdout.toString("utf-8"),
		);
	}
}

function resolvePackagePath(
	nodeModulesPath: string,
	packageName: string,
): string {
	return join(nodeModulesPath, ...packageName.split("/"));
}

/**
 * Get the names of all valid c8ctl plugins currently in node_modules
 */
function getInstalledPluginNames(pluginsDir: string): Set<string> {
	const names = new Set<string>();
	const nodeModulesPath = join(pluginsDir, "node_modules");
	if (!existsSync(nodeModulesPath)) return names;

	for (const dependencyName of listTopLevelDependencies(pluginsDir)) {
		const pkgPath = resolvePackagePath(nodeModulesPath, dependencyName);
		if (!isValidPlugin(pkgPath)) continue;
		const name = getPackageName(pkgPath);
		if (name) {
			names.add(name);
		}
	}

	return names;
}

/**
 * Extract package name from URL or installed package
 * Tries to read package.json from installed package, falls back to URL parsing.
 * When existingNames is provided, prefers a newly installed plugin not in that set.
 */
function extractPackageNameFromUrl(
	url: string,
	pluginsDir: string,
	existingNames?: Set<string>,
): string {
	const sourcePackageName = getPackageNameFromSourceUrl(url);
	if (sourcePackageName) {
		return sourcePackageName;
	}

	// Try to scan node_modules to find the package by reading package.json
	try {
		const nodeModulesPath = join(pluginsDir, "node_modules");
		if (existsSync(nodeModulesPath)) {
			const dependencyNames = listTopLevelDependencies(pluginsDir);

			if (existingNames) {
				// Prefer the newly installed plugin (not present before install)
				for (const dependencyName of dependencyNames) {
					const pkgPath = resolvePackagePath(nodeModulesPath, dependencyName);
					const name = getPackageName(pkgPath);
					if (name && !existingNames.has(name) && isValidPlugin(pkgPath)) {
						return name;
					}
				}
			}

			// Fallback: return the first valid plugin found
			for (const dependencyName of dependencyNames) {
				const pkgPath = resolvePackagePath(nodeModulesPath, dependencyName);
				if (!isValidPlugin(pkgPath)) continue;
				const name = getPackageName(pkgPath);
				if (name) return name;
			}
		}
	} catch (_error) {
		// Fall through to URL-based name extraction
	}

	// Fallback: extract from URL pattern
	const match = url.match(/\/([^/]+?)(\.git)?$/);
	return match ? match[1] : url.replace(/[^a-zA-Z0-9-_@/]/g, "-");
}

/**
 * Unload a plugin (npm uninstall wrapper)
 * Uninstalls from global plugins directory
 */
export const unloadPluginCommand = defineCommand(
	"unload",
	"plugin",
	async (ctx, flags, args) => {
		const { logger } = ctx;
		const packageName = args.package;
		const force = flags.force;

		if (!packageName) {
			throw new Error(
				"Package name required. Usage: c8ctl unload plugin <package-name>",
			);
		}

		const pluginsDir = ensurePluginsDir();
		const isRegistered = isPluginRegistered(packageName);
		const isPresent = existsSync(join(pluginsDir, "node_modules", packageName));

		if (!isRegistered && !isPresent) {
			logger.info('Run "c8ctl list plugins" to see installed plugins');
			throw new Error(
				`Plugin "${packageName}" is neither registered nor installed in the global plugins directory.`,
			);
		}

		// Limbo state: present in node_modules but not in the registry — requires --force
		if (!isRegistered && !force) {
			logger.info(
				`Use --force to remove it: c8ctl unload plugin ${packageName} --force`,
			);
			throw new Error(
				`Plugin "${packageName}" is installed in node_modules but not in the registry (limbo state).`,
			);
		}

		const action = isRegistered ? "Unloading" : "Force-removing";
		logger.info(`${action} plugin: ${packageName}...`);

		try {
			execFileSync("npm", ["uninstall", packageName, "--prefix", pluginsDir], {
				stdio: "inherit",
			});
		} catch (uninstallError) {
			// npm uninstall may fail for untracked/extraneous packages; fall back to physical removal
			logger.warn(
				`npm uninstall failed for plugin "${packageName}", attempting manual removal from node_modules`,
			);
			try {
				rmSync(join(pluginsDir, "node_modules", packageName), {
					recursive: true,
					force: true,
				});
				logger.debug(
					`Manually removed plugin directory for "${packageName}" from plugins directory`,
				);
			} catch (fsError) {
				const uninstallErrorDetails =
					uninstallError instanceof Error
						? uninstallError.message
						: String(uninstallError);
				const combinedError = new Error(
					`Manual removal failed after npm uninstall failed for plugin "${packageName}". npm uninstall error: ${uninstallErrorDetails}`,
					{ cause: fsError },
				);
				handleCommandError(
					logger,
					`Failed to remove plugin "${packageName}" from the global plugins directory.`,
					combinedError,
					[
						"Please verify file permissions for the plugins directory and try again with appropriate rights.",
					],
				);
			}
		}

		if (isRegistered) {
			removePluginFromRegistry(packageName);
			logger.debug(`Removed ${packageName} from plugin registry`);
		}

		clearLoadedPlugins();
		if (isRegistered) {
			logger.success("Plugin unloaded successfully", packageName);
			logger.info("Plugin commands are no longer available");
		} else {
			logger.success(
				"Plugin installation removed from global plugins directory",
				packageName,
			);
			logger.info(
				"Plugin was not registered; no plugin commands were active to unload",
			);
		}
	},
);

/**
 * Scan a directory entry for c8ctl plugins and add to the set
 */
function addPluginIfFound(
	entry: string,
	nodeModulesPath: string,
	installedPlugins: Set<string>,
): void {
	if (entry.startsWith(".")) return;

	if (entry.startsWith("@")) {
		// Scoped package - scan subdirectories
		const scopePath = join(nodeModulesPath, entry);
		try {
			readdirSync(scopePath)
				.filter((pkg) => !pkg.startsWith("."))
				.forEach((scopedPkg) => {
					const packageNameWithScope = `${entry}/${scopedPkg}`;
					const packagePath = join(nodeModulesPath, entry, scopedPkg);
					if (hasPluginFile(packagePath)) {
						installedPlugins.add(packageNameWithScope);
					}
				});
		} catch {
			// Skip packages that can't be read
		}
	} else {
		// Regular package
		const packagePath = join(nodeModulesPath, entry);
		if (hasPluginFile(packagePath)) {
			installedPlugins.add(entry);
		}
	}
}

/**
 * Scan node_modules for installed plugins
 */
function scanInstalledPlugins(nodeModulesPath: string): Set<string> {
	const installedPlugins = new Set<string>();

	if (!existsSync(nodeModulesPath)) {
		return installedPlugins;
	}

	try {
		const entries = readdirSync(nodeModulesPath);
		entries.forEach((entry) => {
			addPluginIfFound(entry, nodeModulesPath, installedPlugins);
		});
	} catch (error) {
		getLogger().debug("Error scanning global plugins directory:", error);
	}

	return installedPlugins;
}

/**
 * Get installed plugin version from package.json
 */
export function getInstalledPluginVersion(
	nodeModulesPath: string,
	packageName: string,
): string | null {
	const packagePath = join(nodeModulesPath, ...packageName.split("/"));
	const packageJsonPath = join(packagePath, "package.json");

	if (!existsSync(packageJsonPath)) {
		return null;
	}

	try {
		const pkgJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
		return typeof pkgJson.version === "string" ? pkgJson.version : null;
	} catch {
		return null;
	}
}

/**
 * Extract version from a registry source like package@version
 */
export function getVersionFromSource(
	source: string,
	packageName: string,
): string | null {
	const packagePrefix = `${packageName}@`;
	if (!source.startsWith(packagePrefix)) {
		return null;
	}

	const version = source.slice(packagePrefix.length).trim();
	return version.length > 0 ? version : null;
}

/**
 * Check if plugin source points to URL/git-style location
 */
function isUrlSource(source: string): boolean {
	return (
		source.includes("://") ||
		source.startsWith("git+") ||
		source.startsWith("git@") ||
		source.startsWith("github:")
	);
}

/**
 * Resolve npm install target based on source type and version
 */
function resolveInstallTarget(
	source: string,
	packageName: string,
	version?: string,
): string {
	if (!version) {
		return source;
	}

	return isUrlSource(source)
		? `${source.split("#")[0]}#${version}`
		: `${packageName}@${version}`;
}

/**
 * List installed plugins
 */
export const listPluginsCommand = defineCommand(
	"list",
	"plugin",
	async (ctx, _flags, _args) => {
		const { logger } = ctx;

		try {
			// Get plugins from registry (local source of truth)
			const registeredPlugins = getRegisteredPlugins();

			// Check global plugins directory
			const pluginsDir = ensurePluginsDir();
			const nodeModulesPath = join(pluginsDir, "node_modules");
			const installedPlugins = scanInstalledPlugins(nodeModulesPath);

			// Build unified list with status
			const plugins: Array<{
				Name: string;
				Version: string;
				Status: string;
				Source: string;
				"Installed At": string;
			}> = [];

			// Add registered plugins
			for (const plugin of registeredPlugins) {
				const isInstalled = installedPlugins.has(plugin.name);
				const installStatus = isInstalled ? "✓ Installed" : "⚠ Not installed";
				const installedVersion = isInstalled
					? getInstalledPluginVersion(nodeModulesPath, plugin.name)
					: null;
				const sourceVersion = getVersionFromSource(plugin.source, plugin.name);

				plugins.push({
					Name: plugin.name,
					Version: installedVersion ?? sourceVersion ?? "Unknown",
					Status: installStatus,
					Source: plugin.source,
					"Installed At": new Date(plugin.installedAt).toLocaleString(),
				});

				installedPlugins.delete(plugin.name);
			}

			// Add any plugins installed but not in registry
			for (const name of installedPlugins) {
				plugins.push({
					Name: name,
					Version:
						getInstalledPluginVersion(nodeModulesPath, name) ?? "Unknown",
					Status: "⚠ Not in registry",
					Source: "Unknown",
					"Installed At": "Unknown",
				});
			}

			if (plugins.length === 0) {
				logger.info("No c8ctl plugins installed");
				return;
			}

			// Check if there are sync issues
			const needsSync = plugins.some((p) => p.Status !== "✓ Installed");

			logger.table(plugins);

			if (needsSync) {
				logger.info("");
				logger.info(
					'Some plugins are out of sync. Run "c8ctl sync plugins" to synchronize your plugins',
				);
			}
		} catch (error) {
			handleCommandError(logger, "Failed to list plugins", error);
		}
	},
);

/**
 * Sync plugins - synchronize registry with actual installations
 * Registry has precedence - plugins are installed to global directory
 */
export const syncPluginsCommand = defineCommand(
	"sync",
	"plugin",
	async (ctx, _flags, _args) => {
		const { logger } = ctx;

		// Get global plugins directory
		const pluginsDir = ensurePluginsDir();
		const nodeModulesPath = join(pluginsDir, "node_modules");

		logger.info("Starting plugin synchronization...");
		logger.info("");

		// Get registered plugins (local source of truth)
		const registeredPlugins = getRegisteredPlugins();

		if (registeredPlugins.length === 0) {
			logger.info("No plugins registered. Nothing to sync.");
			return;
		}

		logger.info(`Found ${registeredPlugins.length} registered plugin(s):`);
		for (const plugin of registeredPlugins) {
			logger.info(`  - ${plugin.name} (${plugin.source})`);
		}
		logger.info("");

		let syncedCount = 0;
		let failedCount = 0;
		const failures: Array<{ plugin: string; error: string }> = [];

		// Process each registered plugin
		for (const plugin of registeredPlugins) {
			logger.info(`Syncing ${plugin.name}...`);

			try {
				// Check if plugin is installed in global directory
				const packageDir = join(nodeModulesPath, plugin.name);
				const isInstalled = existsSync(packageDir);

				if (isInstalled) {
					logger.info(
						`  ✓ ${plugin.name} is already installed, attempting rebuild...`,
					);

					// Try npm rebuild first
					try {
						execFileSync(
							"npm",
							["rebuild", plugin.name, "--prefix", pluginsDir],
							{
								stdio: "pipe",
							},
						);
						logger.success(`  ✓ ${plugin.name} rebuilt successfully`);
						syncedCount++;
						continue;
					} catch (_rebuildError) {
						logger.info(`  ⚠ Rebuild failed, attempting fresh install...`);
					}
				} else {
					logger.info(`  ⚠ ${plugin.name} not found, installing...`);
				}

				// Fresh install
				try {
					execFileSync(
						"npm",
						["install", plugin.source, "--prefix", pluginsDir],
						{
							stdio: "inherit",
						},
					);
					logger.success(`  ✓ ${plugin.name} installed successfully`);
					syncedCount++;
				} catch (installError) {
					logger.error(`  ✗ Failed to install ${plugin.name}`);
					failedCount++;
					failures.push({
						plugin: plugin.name,
						error:
							installError instanceof Error
								? installError.message
								: String(installError),
					});
				}
			} catch (error) {
				logger.error(`  ✗ Failed to sync ${plugin.name}`);
				failedCount++;
				failures.push({
					plugin: plugin.name,
					error: error instanceof Error ? error.message : String(error),
				});
			}

			logger.info("");
		}

		// Summary
		logger.info("Synchronization complete:");
		logger.info(`  ✓ Synced: ${syncedCount} plugin(s)`);

		if (failedCount > 0) {
			logger.info(`  ✗ Failed: ${failedCount} plugin(s)`);
			logger.info("");
			logger.info("Failed plugins:");
			for (const failure of failures) {
				logger.error(`  - ${failure.plugin}: ${failure.error}`);
			}
			logger.info("");
			const syncError = new Error(
				failures.map((f) => `${f.plugin}: ${f.error}`).join("; "),
			);
			handleCommandError(
				logger,
				`Failed to sync ${failedCount} plugin(s)`,
				syncError,
				[
					'Check network connectivity and verify plugin sources are accessible. You may need to remove failed plugins from the registry with "c8ctl unload plugin <name>"',
				],
			);
		}

		logger.success("All plugins synced successfully!");
	},
);

/**
 * Upgrade a plugin to the latest version or a specific version
 */
export const upgradePluginCommand = defineCommand(
	"upgrade",
	"plugin",
	async (ctx, _flags, args) => {
		const { logger } = ctx;
		const packageName = args.package;
		const version = args.version;

		if (!packageName) {
			throw new Error(
				"Package name required. Usage: c8ctl upgrade plugin <package-name> [version]",
			);
		}

		// Check if plugin is registered
		if (!isPluginRegistered(packageName)) {
			logger.info('Run "c8ctl list plugins" to see installed plugins');
			throw new Error(`Plugin "${packageName}" is not registered.`);
		}

		const pluginEntry = getPluginEntry(packageName);
		const pluginsDir = ensurePluginsDir();

		const source = pluginEntry?.source ?? packageName;

		// Versioned upgrade needs to respect source type
		// File-based plugins do not have a version selector in npm install syntax
		if (version && source.startsWith("file:")) {
			logger.info(`Plugin source is: ${source}`);
			logger.info(
				'Use "c8ctl load plugin --from <file-url>" after checking out the desired plugin version in your local source directory',
			);
			throw new Error(
				`Cannot upgrade file-based plugin "${packageName}" to a specific version.`,
			);
		}

		const installTarget = resolveInstallTarget(source, packageName, version);

		try {
			logger.info(
				`Upgrading plugin: ${packageName} to ${version || "latest"}...`,
			);

			// Uninstall current version
			execFileSync("npm", ["uninstall", packageName, "--prefix", pluginsDir], {
				stdio: "pipe",
			});

			// Install new version while respecting source type
			execFileSync("npm", ["install", installTarget, "--prefix", pluginsDir], {
				stdio: "inherit",
			});

			// Update registry with new source if version was specified
			if (version) {
				addPluginToRegistry(packageName, installTarget);
			}

			// Clear plugin cache
			clearLoadedPlugins();

			logger.success("Plugin upgraded successfully", packageName);
			logger.info("Plugin will be available on next command execution");
		} catch (error) {
			handleCommandError(logger, "Failed to upgrade plugin", error, [
				"Check network connectivity and verify the package/version exists",
			]);
		}
	},
);

/**
 * Downgrade a plugin to a specific version
 */
export const downgradePluginCommand = defineCommand(
	"downgrade",
	"plugin",
	async (ctx, _flags, args) => {
		const { logger } = ctx;
		const packageName = args.package;
		const version = args.version;

		if (!packageName || !version) {
			throw new Error(
				"Package name and version required. Usage: c8ctl downgrade plugin <package-name> <version>",
			);
		}

		// Check if plugin is registered
		if (!isPluginRegistered(packageName)) {
			logger.info('Run "c8ctl list plugins" to see installed plugins');
			throw new Error(`Plugin "${packageName}" is not registered.`);
		}

		const pluginEntry = getPluginEntry(packageName);
		const pluginsDir = ensurePluginsDir();

		const source = pluginEntry?.source ?? packageName;

		// Downgrade needs to respect the plugin source
		// File-based plugins do not have a version selector in npm install syntax
		if (source.startsWith("file:")) {
			logger.info(`Plugin source is: ${source}`);
			logger.info(
				'Use "c8ctl load plugin --from <file-url>" after checking out the desired plugin version in your local source directory',
			);
			throw new Error(
				`Cannot downgrade file-based plugin "${packageName}" by version.`,
			);
		}

		const installTarget = resolveInstallTarget(source, packageName, version);

		try {
			logger.info(
				`Downgrading plugin: ${packageName} to version ${version}...`,
			);

			// Uninstall current version
			execFileSync("npm", ["uninstall", packageName, "--prefix", pluginsDir], {
				stdio: "pipe",
			});

			// Install specific version while respecting source type
			execFileSync("npm", ["install", installTarget, "--prefix", pluginsDir], {
				stdio: "inherit",
			});

			// Update registry with new source
			addPluginToRegistry(packageName, installTarget);

			// Clear plugin cache
			clearLoadedPlugins();

			logger.success("Plugin downgraded successfully", packageName);
			logger.info("Plugin will be available on next command execution");
		} catch (error) {
			handleCommandError(logger, "Failed to downgrade plugin", error, [
				"Check network connectivity and verify the version exists",
			]);
		}
	},
);

/**
 * Initialize a new plugin project with TypeScript template
 */
export const initPluginCommand = defineCommand(
	"init",
	"plugin",
	async (ctx, _flags, args) => {
		const { logger } = ctx;
		const { mkdirSync, writeFileSync } = await import("node:fs");
		const { resolve } = await import("node:path");

		const rawName = args.name || "myplugin";
		// Convention over configuration: plugin name is the suffix after 'c8ctl-plugin-'
		const pluginName = rawName.startsWith("c8ctl-plugin-")
			? rawName.slice("c8ctl-plugin-".length)
			: rawName;

		if (!pluginName) {
			logger.info("Example: c8ctl init plugin myplugin");
			throw new Error(
				'Plugin name cannot be empty. Provide a name suffix after "c8ctl-plugin-".',
			);
		}

		const dirName = `c8ctl-plugin-${pluginName}`;
		const pluginDir = resolve(process.cwd(), dirName);

		// Check if directory already exists
		if (existsSync(pluginDir)) {
			logger.info("Choose a different name or remove the existing directory");
			throw new Error(`Directory "${dirName}" already exists.`);
		}

		try {
			logger.info(`Creating plugin: ${dirName}...`);

			const templateVars = { PLUGIN_NAME: pluginName, PLUGIN_DIR: dirName };

			// Create plugin directory
			mkdirSync(pluginDir, { recursive: true });

			// Create package.json
			writeFileSync(
				join(pluginDir, "package.json"),
				renderTemplate("package.json", templateVars),
			);

			// Create tsconfig.json
			writeFileSync(
				join(pluginDir, "tsconfig.json"),
				getTemplate("tsconfig.json.template"),
			);

			// Create src directory
			mkdirSync(join(pluginDir, "src"), { recursive: true });

			// Create root c8ctl-plugin.js entry point
			writeFileSync(
				join(pluginDir, "c8ctl-plugin.js"),
				getTemplate("c8ctl-plugin.js"),
			);

			// Create c8ctl-plugin.ts
			writeFileSync(
				join(pluginDir, "src", "c8ctl-plugin.ts"),
				renderTemplate("c8ctl-plugin.ts", templateVars),
			);

			// Create README.md
			const readme = renderTemplate("README.md", templateVars);

			writeFileSync(join(pluginDir, "README.md"), readme);

			// Create AGENTS.md
			const agents = getTemplate("AGENTS.md");

			writeFileSync(join(pluginDir, "AGENTS.md"), agents);

			// Create .gitignore (stored as 'gitignore' to survive npm publish)
			writeFileSync(join(pluginDir, ".gitignore"), getTemplate("gitignore"));

			logger.success("Plugin scaffolding created successfully!");
			const nextSteps = renderTemplate(
				"init-plugin-next-steps.txt",
				templateVars,
			);
			for (const line of nextSteps.split("\n")) {
				logger.info(line);
			}
		} catch (error) {
			handleCommandError(logger, "Failed to create plugin", error);
		}
	},
);
