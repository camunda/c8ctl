/**
 * Plugin loader for dynamic command loading
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FlagDef } from "./command-registry.ts";
import { ensurePluginsDir } from "./config.ts";
import { getLogger } from "./logger.ts";
import { c8ctl } from "./runtime.ts";

type CommandHandler = (
	args: string[],
	flags?: Record<string, unknown>,
) => Promise<void>;

interface CommandWithFlags {
	flags: Record<string, FlagDef>;
	handler: CommandHandler;
}

type PluginCommand = CommandHandler | CommandWithFlags;

interface PluginCommands {
	[commandName: string]: PluginCommand;
}

interface PluginMetadata {
	name?: string;
	description?: string;
	commands?: {
		[commandName: string]: PluginCommandMeta;
	};
}

/**
 * Per-command plugin metadata.
 *
 * A plugin command is **either** metadata-driven (declares typed flags via
 * the `{ flags, handler }` command form) **or** a passthrough command
 * (`passthrough: true` + `passthroughHint`). Mutually exclusive — see
 * #251 / #366. Declaring both is rejected at load time.
 */
export interface PluginCommandMeta {
	description?: string;
	helpDescription?: string;
	examples?: { command: string; description: string }[];
	/** Subcommands for shell completion (e.g. cluster → start, stop, status). */
	subcommands?: { name: string; description: string }[];
	/**
	 * If true, c8ctl strips GLOBAL_FLAGS from argv and forwards everything
	 * else verbatim to the bare-function handler. Help and JSON help
	 * advertise the boundary explicitly.
	 *
	 * MUST NOT appear together with the `{ flags, handler }` command form;
	 * the load-time validator drops any command that declares both.
	 */
	passthrough?: boolean;
	/**
	 * Required when `passthrough` is true. Short text rendered in help that
	 * advertises the boundary, e.g. "Forwards args to `kubectl`".
	 */
	passthroughHint?: string;
	/**
	 * Optional documentation-only flag list rendered in help under
	 * passthrough commands. NOT parsed by c8ctl.
	 */
	flagsHint?: string[];
}

interface LoadedPlugin {
	name: string;
	commands: PluginCommands;
	metadata?: PluginMetadata;
}

const loadedPlugins = new Map<string, LoadedPlugin>();

/**
 * Validate the passthrough/flags mutual-exclusion rule (#366). Removes
 * offending commands from the registered set so they cannot be invoked,
 * and emits a `logger.warn` naming the plugin and command so the
 * misconfiguration is visible at startup.
 *
 * The contract: a command MUST NOT declare `passthrough: true` AND use the
 * `{ flags, handler }` form. Pick one. A passthrough command without a
 * `passthroughHint` is also rejected (the hint is what makes the boundary
 * legible to users and agents).
 *
 * Mutates `plugin.commands` in place. Safe to call after each plugin is
 * loaded.
 */
function validatePassthroughCommands(plugin: LoadedPlugin): void {
	const logger = getLogger();
	const meta = plugin.metadata?.commands ?? {};
	for (const commandName of Object.keys(plugin.commands)) {
		const commandMeta = meta[commandName];
		if (commandMeta?.passthrough === undefined) continue;

		// `passthrough: false` is equivalent to "not opted in" — silently
		// skip. Any other non-`true` value (e.g. the string "true", a
		// number) is a contract violation: dispatch and help both gate on
		// `=== true`, so a truthy non-true value would silently disagree
		// with them. Reject loudly at load time.
		if (commandMeta.passthrough === false) continue;
		if (commandMeta.passthrough !== true) {
			logger.warn(
				`Plugin '${plugin.name}' command '${commandName}' has metadata.passthrough set to ` +
					`${JSON.stringify(commandMeta.passthrough)} but the contract requires the boolean ` +
					"literal `true` (or `false` / omitted to opt out). Dropping this command (#366).",
			);
			delete plugin.commands[commandName];
			continue;
		}

		const cmd = plugin.commands[commandName];
		const hasFlagsForm = typeof cmd !== "function";
		if (hasFlagsForm) {
			logger.warn(
				`Plugin '${plugin.name}' command '${commandName}' declares both passthrough:true AND flags. ` +
					"Pick one \u2014 a passthrough command must use the bare-function handler form. " +
					"Dropping this command (#366).",
			);
			delete plugin.commands[commandName];
			continue;
		}
		if (
			typeof commandMeta.passthroughHint !== "string" ||
			commandMeta.passthroughHint.trim() === ""
		) {
			logger.warn(
				`Plugin '${plugin.name}' command '${commandName}' declares passthrough:true ` +
					"but is missing a non-empty passthroughHint. The hint is required so help and " +
					"agents can advertise the boundary. Dropping this command (#366).",
			);
			delete plugin.commands[commandName];
			continue;
		}

		// `flagsHint` is documentation-only and consumed by the help
		// renderer, which assumes `string[]`. Validate the shape here so a
		// mis-typed value can't reach the renderer. The field is optional;
		// invalid shapes are stripped (not fatal) so the command itself
		// continues to work — only the doc affordance is lost.
		const flagsHint = commandMeta.flagsHint;
		if (flagsHint !== undefined) {
			const valid =
				Array.isArray(flagsHint) &&
				flagsHint.every((entry) => typeof entry === "string");
			if (!valid) {
				logger.warn(
					`Plugin '${plugin.name}' command '${commandName}' declares metadata.flagsHint ` +
						"but it is not a string[]. Ignoring flagsHint (#366).",
				);
				delete commandMeta.flagsHint;
			}
		}
	}
}

/**
 * Reject duplicate plugin command names at load time. If `plugin` declares
 * a command name that is already registered by an earlier-loaded plugin,
 * drop it from `plugin.commands` and emit `logger.warn` naming both
 * plugins so the conflict is visible at startup.
 *
 * **Conflict policy: first registration wins.** This is an explicit
 * choice (#366) and replaces the previous implicit "last-loaded wins"
 * behaviour produced by `Object.assign` over `loadedPlugins` in
 * insertion order. Plugins cannot override one another by registering
 * the same command name; if you want a different command, give it a
 * different name. Default plugins always load first, so user-installed
 * plugins cannot override default commands by name.
 *
 * This guarantees that the merged map returned by `getPluginCommands()`
 * has a single owning plugin per command name, which keeps dispatch and
 * `isPassthroughPluginCommand()` consistent: the help renderer and the
 * runtime always agree on which plugin handles a given verb.
 *
 * Mutates `plugin.commands` in place. Safe to call after each plugin is
 * loaded; relies on `loadedPlugins` already containing previously-loaded
 * plugins.
 */
function rejectDuplicateCommandNames(plugin: LoadedPlugin): void {
	const logger = getLogger();
	for (const commandName of Object.keys(plugin.commands)) {
		for (const existing of loadedPlugins.values()) {
			if (Object.hasOwn(existing.commands, commandName)) {
				logger.warn(
					`Plugin '${plugin.name}' tried to register command '${commandName}' but it is ` +
						`already provided by plugin '${existing.name}'. The first registration wins; ` +
						`dropping the duplicate from '${plugin.name}'.`,
				);
				delete plugin.commands[commandName];
				break;
			}
		}
	}
}

/**
 * Reject a plugin whose name collides with an already-loaded plugin
 * (#363). The first-registration-wins policy applies at the plugin
 * level as well as at the command-name level: if a user-installed
 * package shares a `package.json#name` with a default plugin (or with
 * another already-loaded plugin), refusing the second load keeps
 * `loadedPlugins` single-owner per name and prevents a silent
 * `loadedPlugins.set()` overwrite from bypassing the
 * command-name policy.
 *
 * Returns `true` when the caller should skip the load; `false` when
 * the name is free.
 */
function isDuplicatePluginName(pluginName: string): boolean {
	const logger = getLogger();
	if (loadedPlugins.has(pluginName)) {
		logger.warn(
			`Plugin name '${pluginName}' is already loaded; refusing to load a second plugin ` +
				`with the same name. The first registration wins.`,
		);
		return true;
	}
	return false;
}

/**
 * Load default plugins bundled with c8ctl
 */
async function loadDefaultPlugins(): Promise<void> {
	const logger = getLogger();
	const { fileURLToPath } = await import("node:url");
	const { dirname } = await import("node:path");

	try {
		// Get the directory where this file is located
		const __filename = fileURLToPath(import.meta.url);
		const __dirname = dirname(__filename);

		// Check both possible locations:
		// In development: src/plugin-loader.ts -> ../default-plugins
		// In production: dist/plugin-loader.js -> dist/default-plugins
		const possiblePaths = [
			join(__dirname, "default-plugins"), // Production path
			join(__dirname, "..", "default-plugins"), // Development path
		];

		let defaultPluginsDir: string | null = null;
		for (const path of possiblePaths) {
			if (existsSync(path)) {
				defaultPluginsDir = path;
				break;
			}
		}

		if (!defaultPluginsDir) {
			logger.debug("No default-plugins directory found");
			return;
		}

		// Sort to make load order deterministic across filesystems/OSes.
		// The first-registration-wins duplicate-name policy in
		// `rejectDuplicateCommandNames` relies on this — without a stable
		// sort, "who wins" would depend on `readdirSync()` order, which
		// varies across platforms and filesystems.
		const pluginDirs = readdirSync(defaultPluginsDir).sort();
		logger.debug(`Found ${pluginDirs.length} default plugin(s)`);

		for (const pluginDir of pluginDirs) {
			const pluginPath = join(defaultPluginsDir, pluginDir);
			const packageJsonPath = join(pluginPath, "package.json");

			if (!existsSync(packageJsonPath)) {
				logger.debug(`No package.json in default plugin: ${pluginDir}`);
				continue;
			}

			try {
				// Check for c8ctl-plugin file
				const pluginFileJs = join(pluginPath, "c8ctl-plugin.js");
				const pluginFileTs = join(pluginPath, "c8ctl-plugin.ts");

				if (!existsSync(pluginFileJs) && !existsSync(pluginFileTs)) {
					logger.debug(`No c8ctl-plugin.js/ts in default plugin: ${pluginDir}`);
					continue;
				}

				// Read package.json
				const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
				const pluginName = packageJson.name || `default-${pluginDir}`;

				const pluginFile = existsSync(pluginFileJs)
					? pluginFileJs
					: pluginFileTs;

				// Use file:// protocol and add timestamp to bust cache
				const pluginUrl = `file://${pluginFile}?t=${Date.now()}`;
				logger.debug(`Loading default plugin from: ${pluginUrl}`);
				const plugin = await import(pluginUrl);

				if (plugin.commands && typeof plugin.commands === "object") {
					if (isDuplicatePluginName(pluginName)) {
						continue;
					}
					const loaded: LoadedPlugin = {
						name: pluginName,
						commands: { ...plugin.commands },
						metadata: plugin.metadata || {},
					};
					validatePassthroughCommands(loaded);
					rejectDuplicateCommandNames(loaded);
					loadedPlugins.set(pluginName, loaded);
					const commandNames = Object.keys(loaded.commands);
					logger.debug(
						`Successfully loaded default plugin: ${pluginName} with ${commandNames.length} commands:`,
						commandNames,
					);
				}
			} catch (error) {
				logger.debug(`Failed to load default plugin ${pluginDir}:`, error);
			}
		}
	} catch (error) {
		logger.debug("Error loading default plugins:", error);
	}
}

/**
 * Load all installed plugins from global plugins directory
 */
export async function loadInstalledPlugins(): Promise<void> {
	const logger = getLogger();

	// Expose the runtime to plugins via globalThis.
	// C8ctl implements C8ctlPluginRuntime directly — no monkey-patching needed.
	globalThis.c8ctl = c8ctl;

	// Load default plugins first
	await loadDefaultPlugins();

	// Then load user-installed plugins
	const pluginsDir = ensurePluginsDir();
	const nodeModulesPath = join(pluginsDir, "node_modules");

	if (!existsSync(nodeModulesPath)) {
		logger.debug("Global plugins node_modules directory not found");
		return;
	}

	try {
		// Sort to make load order deterministic across filesystems/OSes.
		// The first-registration-wins duplicate-name policy in
		// `rejectDuplicateCommandNames` relies on this — without a stable
		// sort, "who wins" would depend on `readdirSync()` order, which
		// varies across platforms and filesystems.
		const entries = readdirSync(nodeModulesPath).sort();
		logger.debug(`Scanning ${entries.length} entries in node_modules`);

		const packagesToScan: string[] = [];

		// Collect regular packages and scoped packages
		for (const entry of entries) {
			if (entry.startsWith(".")) {
				continue;
			}

			if (entry.startsWith("@")) {
				// Scoped package - scan subdirectories (sorted for determinism).
				const scopePath = join(nodeModulesPath, entry);
				try {
					const scopedPackages = readdirSync(scopePath).sort();
					for (const scopedPkg of scopedPackages) {
						if (!scopedPkg.startsWith(".")) {
							packagesToScan.push(join(entry, scopedPkg));
						}
					}
				} catch (error) {
					logger.debug(
						`Failed to scan scoped package directory ${entry}:`,
						error,
					);
				}
			} else {
				// Regular package
				packagesToScan.push(entry);
			}
		}

		// Final defensive sort: `@scope/pkg` paths interleave with bare
		// `pkg` paths in the order we appended them, but for
		// duplicate-name resolution we want a single, stable lexicographic
		// order over the full set.
		packagesToScan.sort();

		logger.debug(
			`Found ${packagesToScan.length} packages to scan:`,
			packagesToScan,
		);

		for (const packageName of packagesToScan) {
			const packagePath = join(nodeModulesPath, packageName);
			const packageJsonPath = join(packagePath, "package.json");

			if (!existsSync(packageJsonPath)) {
				logger.debug(`No package.json for ${packageName}`);
				continue;
			}

			try {
				// Check for c8ctl-plugin entry point files first
				const pluginFileJs = join(packagePath, "c8ctl-plugin.js");
				const pluginFileTs = join(packagePath, "c8ctl-plugin.ts");

				if (!existsSync(pluginFileJs) && !existsSync(pluginFileTs)) {
					logger.debug(`No c8ctl-plugin.js/ts found for ${packageName}`);
					continue;
				}

				// Read package.json to check keywords
				const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));

				// Plugin must have c8ctl or c8ctl-plugin in keywords
				const isC8ctlPlugin =
					packageJson.keywords?.includes("c8ctl") ||
					packageJson.keywords?.includes("c8ctl-plugin");

				if (!isC8ctlPlugin) {
					logger.debug(
						`Package ${packageName} has c8ctl-plugin file but missing keywords (keywords: ${packageJson.keywords?.join(", ") || "none"})`,
					);
					continue;
				}

				logger.debug(`Found c8ctl plugin candidate: ${packageName}`);

				const pluginFile = existsSync(pluginFileJs)
					? pluginFileJs
					: pluginFileTs;

				// Use file:// protocol and add timestamp to bust cache
				const pluginUrl = `file://${pluginFile}?t=${Date.now()}`;
				logger.debug(`Loading plugin from: ${pluginUrl}`);
				const plugin = await import(pluginUrl);

				if (plugin.commands && typeof plugin.commands === "object") {
					if (isDuplicatePluginName(packageName)) {
						continue;
					}
					const loaded: LoadedPlugin = {
						name: packageName,
						commands: { ...plugin.commands },
						metadata: plugin.metadata || {},
					};
					validatePassthroughCommands(loaded);
					rejectDuplicateCommandNames(loaded);
					loadedPlugins.set(packageName, loaded);
					const commandNames = Object.keys(loaded.commands);
					logger.debug(
						`Successfully loaded plugin: ${packageName} with ${commandNames.length} commands:`,
						commandNames,
					);
				}
			} catch (error) {
				logger.debug(`Failed to load plugin ${packageName}:`, error);
			}
		}
		logger.debug(`Total plugins loaded: ${loadedPlugins.size}`);
	} catch (error) {
		logger.debug("Error scanning for plugins:", error);
	}
}

/**
 * Get all loaded plugin commands
 */
export function getPluginCommands(): PluginCommands {
	const allCommands: PluginCommands = Object.create(null);

	for (const plugin of loadedPlugins.values()) {
		Object.assign(allCommands, plugin.commands);
	}

	return allCommands;
}

/**
 * Execute a plugin command if it exists
 */
export async function executePluginCommand(
	commandName: string,
	args: string[],
	flags?: Record<string, unknown>,
): Promise<boolean> {
	const commands = getPluginCommands();
	const cmd = Object.hasOwn(commands, commandName)
		? commands[commandName]
		: undefined;

	if (cmd) {
		if (typeof cmd === "function") {
			if (flags !== undefined) {
				await cmd(args, flags);
			} else {
				await cmd(args);
			}
		} else {
			await cmd.handler(args, flags);
		}
		return true;
	}

	return false;
}

/**
 * Check if a command is provided by a plugin
 */
export function isPluginCommand(commandName: string): boolean {
	const commands = getPluginCommands();
	return Object.hasOwn(commands, commandName);
}

/**
 * Get list of all plugin command names
 */
export function getPluginCommandNames(): string[] {
	return Object.keys(getPluginCommands());
}

/**
 * Get plugin information for help display
 */
export interface PluginCommandInfo {
	commandName: string;
	pluginName: string;
	description?: string;
	helpDescription?: string;
	examples?: { command: string; description: string }[];
	/** Subcommands for shell completion (e.g. cluster → start, stop, status). */
	subcommands?: { name: string; description: string }[];
	/** True when the command opted into the #366 passthrough contract. */
	passthrough?: boolean;
	/** Required when passthrough is true — short text that names the boundary. */
	passthroughHint?: string;
	/** Optional documentation-only flag list rendered under passthrough help. */
	flagsHint?: string[];
}

export function getPluginCommandsInfo(): PluginCommandInfo[] {
	const infos: PluginCommandInfo[] = [];

	for (const plugin of loadedPlugins.values()) {
		for (const commandName of Object.keys(plugin.commands)) {
			const meta = plugin.metadata?.commands?.[commandName];
			infos.push({
				commandName,
				pluginName: plugin.name,
				description: meta?.description,
				helpDescription: meta?.helpDescription,
				examples: meta?.examples,
				subcommands: meta?.subcommands,
				passthrough: meta?.passthrough === true ? true : undefined,
				passthroughHint: meta?.passthroughHint,
				flagsHint: meta?.flagsHint,
			});
		}
	}

	return infos;
}

/**
 * True if the named command is a registered passthrough plugin command
 * (#366). Used by the dispatcher to gate the strip-and-forward path.
 */
export function isPassthroughPluginCommand(commandName: string): boolean {
	for (const plugin of loadedPlugins.values()) {
		if (!Object.hasOwn(plugin.commands, commandName)) continue;
		const meta = plugin.metadata?.commands?.[commandName];
		if (meta?.passthrough === true) return true;
	}
	return false;
}

/**
 * Clear all loaded plugins (useful for testing and after uninstall)
 */
export function clearLoadedPlugins(): void {
	loadedPlugins.clear();
}
