/**
 * Plugin loader for dynamic command loading
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CamundaClient } from "@camunda8/orchestration-cluster-api";
import {
	c8ctl,
	ensurePluginsDir,
	getLogger,
	type Logger,
	type OutputMode,
} from "../../core/index.ts";
import type { FlagDef } from "../command-registry.ts";
import type { confirm, select } from "../ui/prompt.ts";

/**
 * Typed, documented host context passed to plugin command handlers as
 * the third argument (#377).
 *
 * Reflects every member of `GLOBAL_FLAGS` whose value is meaningful to
 * a plugin handler; `help` and `version` are intentionally absent
 * because they are intercepted by the host before dispatch. The
 * class-scoped contract test
 * (`tests/unit/plugin-host-context-contract.test.ts`) pins this
 * relationship.
 *
 * `client` is exposed as a lazy getter so plugins that never need a
 * Camunda client (e.g. local-only utilities, session inspectors) do
 * not trigger credential resolution simply by receiving the ctx.
 *
 * Plugins authored before #377 use the two-argument signature
 * `(args, flags)` — the third argument is additive and JavaScript's
 * variadic call semantics keep those handlers working unchanged.
 */
export interface PluginCtx {
	/**
	 * Active profile name (from `--profile` or session), or `undefined` when
	 * neither was set. Plugins should pass this through to `createClient()` /
	 * `resolveTenantId()` verbatim so env-var-only configurations (no
	 * profile, just `CAMUNDA_*` env vars) resolve the same way they do for
	 * built-in commands.
	 */
	profile: string | undefined;
	/** True when `--dry-run` is set. Plugins SHOULD honour this. */
	dryRun: boolean;
	/** True when `--verbose` is set. */
	verbose: boolean;
	/** Effective output mode (`--json` toggles to `json`). */
	outputMode: OutputMode;
	/** True when `--yes` is set. Skip confirmation prompts. */
	yes: boolean;
	/** Parsed `--fields a,b,c` list, or undefined when not set. */
	fields?: string[];
	/** Host logger — use `logger.json(...)` for structured output. */
	logger: Logger;
	/** Interactive prompts — arrow-key menu and yes/no confirmation. */
	prompt: {
		select: typeof select;
		confirm: typeof confirm;
	};
	/** Lazily-resolved Camunda client. Reading triggers credential resolution. */
	readonly client: CamundaClient;
}

export type PluginCommandHandler = (
	args: string[],
	flags?: Record<string, unknown>,
	ctx?: PluginCtx,
) => Promise<void>;

export interface CommandWithFlags {
	flags: Record<string, FlagDef>;
	handler: PluginCommandHandler;
}

export type PluginCommand = PluginCommandHandler | CommandWithFlags;

export interface PluginCommands {
	[commandName: string]: PluginCommand;
}

export interface PluginMetadata {
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
	/** Plugin package version from its `package.json#version`. */
	version: string;
	commands: PluginCommands;
	metadata?: PluginMetadata;
}

const loadedPlugins = new Map<string, LoadedPlugin>();

/**
 * Structured record of a load-time collision between two plugins,
 * surfaced by `c8ctl doctor plugin` (#363). Two flavours:
 *
 * - `command-name`: two plugins exported a command under the same name.
 *   The earlier-loaded plugin's command stays in dispatch; the later
 *   plugin's was dropped. `winner`/`loser` reflect that ordering.
 * - `plugin-name`: two plugins shared the same `package.json#name`.
 *   The entire later plugin was rejected (its module body was never
 *   imported); `command` is undefined for this kind.
 *
 * The doctor command is the only consumer; the loader appends to this
 * list as it discovers collisions and never reads from it. Cleared by
 * `clearLoadedPlugins()` so test fixtures stay isolated.
 */
export interface PluginCollision {
	kind: "command-name" | "plugin-name";
	winner: string;
	loser: string;
	command?: string;
}

const pluginCollisions: PluginCollision[] = [];

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
				pluginCollisions.push({
					kind: "command-name",
					winner: existing.name,
					loser: plugin.name,
					command: commandName,
				});
				delete plugin.commands[commandName];
				break;
			}
		}
	}
}

/**
 * Reject a plugin whose name collides with an already-loaded plugin.
 * This is a separate concern from the command-name collision policy
 * tracked under #363: that policy rejects two plugins exporting the
 * same command name, while this one rejects two plugins sharing the
 * same `package.json#name`. Both follow first-registration-wins.
 * Without this guard a user-installed package sharing a name with a
 * default plugin (or with another already-loaded plugin) would
 * silently overwrite the prior `loadedPlugins.set()` entry, bypassing
 * the command-name policy entirely.
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
		pluginCollisions.push({
			kind: "plugin-name",
			winner: pluginName,
			loser: pluginName,
		});
		return true;
	}
	return false;
}

/**
 * Compute the candidate `default-plugins` directories, relative to the
 * directory containing this loader module.
 *
 * The loader sits one directory below the project/dist root:
 *   - Development: `src/framework/plugins/plugin-loader.ts`
 *       → `../../default-plugins`  = `<repo>/default-plugins`
 *   - Production:  `dist/framework/plugin-loader.js`
 *       → `../default-plugins`     = `<repo>/dist/default-plugins`
 *
 * Both candidates are returned (production first); the first one that
 * exists on disk wins. Keeping this pure and exported lets the unit
 * suite — which always runs from the TS sources (dev layout) — still
 * guard the production-layout resolution that real `dist/` runs depend
 * on.
 */
export function defaultPluginsCandidateDirs(loaderDir: string): string[] {
	return [
		// Production: dist/framework/plugins -> dist/default-plugins
		join(loaderDir, "..", "..", "default-plugins"),
		// Development: src/framework/plugins -> <repo>/default-plugins
		join(loaderDir, "..", "..", "..", "default-plugins"),
	];
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

		const possiblePaths = defaultPluginsCandidateDirs(__dirname);

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
				const pluginVersion =
					typeof packageJson.version === "string" &&
					packageJson.version.length > 0
						? packageJson.version
						: "0.0.0";

				// Check for duplicate plugin name BEFORE the dynamic import
				// so a duplicate-name plugin's module code never runs (the
				// import has top-level side effects we don't want to execute
				// only to throw the result away).
				if (isDuplicatePluginName(pluginName)) {
					continue;
				}

				const pluginFile = existsSync(pluginFileJs)
					? pluginFileJs
					: pluginFileTs;

				// Use file:// protocol and add timestamp to bust cache
				const pluginUrl = `file://${pluginFile}?t=${Date.now()}`;
				logger.debug(`Loading default plugin from: ${pluginUrl}`);
				const plugin = await import(pluginUrl);

				if (plugin.commands && typeof plugin.commands === "object") {
					const loaded: LoadedPlugin = {
						name: pluginName,
						version: pluginVersion,
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

				// Use the package.json#name (not the filesystem directory
				// entry) as the canonical plugin name / loadedPlugins key.
				// Under npm aliases (e.g. `npm i my-alias@npm:real-plugin`),
				// the install directory is `my-alias` but the package name is
				// `real-plugin`. Keying by directory would miss real
				// duplicate-name collisions and surface the wrong name in
				// duplicate warnings. `packageName` is kept for filesystem /
				// logging purposes only.
				const pluginName =
					typeof packageJson.name === "string" && packageJson.name.length > 0
						? packageJson.name
						: packageName;
				const pluginVersion =
					typeof packageJson.version === "string" &&
					packageJson.version.length > 0
						? packageJson.version
						: "0.0.0";

				// Check for duplicate plugin name BEFORE the dynamic import
				// so a duplicate-name plugin's module code never runs (the
				// import has top-level side effects we don't want to execute
				// only to throw the result away).
				if (isDuplicatePluginName(pluginName)) {
					continue;
				}

				// Use file:// protocol and add timestamp to bust cache
				const pluginUrl = `file://${pluginFile}?t=${Date.now()}`;
				logger.debug(`Loading plugin from: ${pluginUrl}`);
				const plugin = await import(pluginUrl);

				if (plugin.commands && typeof plugin.commands === "object") {
					const loaded: LoadedPlugin = {
						name: pluginName,
						version: pluginVersion,
						commands: { ...plugin.commands },
						metadata: plugin.metadata || {},
					};
					validatePassthroughCommands(loaded);
					rejectDuplicateCommandNames(loaded);
					loadedPlugins.set(pluginName, loaded);
					const commandNames = Object.keys(loaded.commands);
					logger.debug(
						`Successfully loaded plugin: ${pluginName} (dir: ${packageName}) with ${commandNames.length} commands:`,
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
 * Execute a plugin command if it exists.
 *
 * `ctx` is the typed host context introduced in #377. When provided it
 * is passed as the third handler argument; legacy two-argument
 * handlers ignore it. When omitted the call site is treating the
 * plugin as a fire-and-forget passthrough/help-render shim and
 * intentionally does not construct a client.
 */
export async function executePluginCommand(
	commandName: string,
	args: string[],
	flags?: Record<string, unknown>,
	ctx?: PluginCtx,
): Promise<boolean> {
	const commands = getPluginCommands();
	const cmd = Object.hasOwn(commands, commandName)
		? commands[commandName]
		: undefined;

	if (cmd) {
		if (typeof cmd === "function") {
			if (ctx !== undefined) {
				await cmd(args, flags, ctx);
			} else if (flags !== undefined) {
				await cmd(args, flags);
			} else {
				await cmd(args);
			}
		} else {
			await cmd.handler(args, flags, ctx);
		}
		return true;
	}

	return false;
}

/**
 * Look up the loaded version of a plugin by command name. Returns
 * `undefined` if no plugin owns the command. Used by `--version` on a
 * plugin verb to print the plugin's package version (#377).
 */
export function getPluginVersionForCommand(
	commandName: string,
): { pluginName: string; version: string } | undefined {
	for (const plugin of loadedPlugins.values()) {
		if (Object.hasOwn(plugin.commands, commandName)) {
			return { pluginName: plugin.name, version: plugin.version };
		}
	}
	return undefined;
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
	/** Plugin package version (`package.json#version`). */
	pluginVersion: string;
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
	/** Typed flag declarations for flag-aware (non-passthrough) commands. */
	flags?: Record<string, FlagDef>;
}

export function getPluginCommandsInfo(): PluginCommandInfo[] {
	const infos: PluginCommandInfo[] = [];

	for (const plugin of loadedPlugins.values()) {
		for (const commandName of Object.keys(plugin.commands)) {
			const meta = plugin.metadata?.commands?.[commandName];
			const cmd = plugin.commands[commandName];
			const flags = typeof cmd !== "function" ? cmd.flags : undefined;
			infos.push({
				commandName,
				pluginName: plugin.name,
				pluginVersion: plugin.version,
				description: meta?.description,
				helpDescription: meta?.helpDescription,
				examples: meta?.examples,
				subcommands: meta?.subcommands,
				passthrough: meta?.passthrough === true ? true : undefined,
				passthroughHint: meta?.passthroughHint,
				flagsHint: meta?.flagsHint,
				flags,
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
	pluginCollisions.length = 0;
}

/**
 * Snapshot of plugin collisions detected at load time (#363). Returns
 * a deep defensive copy of frozen records so callers cannot mutate
 * the loader's bookkeeping (neither the array nor the entries).
 * Order reflects the order in which the loader observed the
 * collisions.
 */
export function getPluginCollisions(): readonly Readonly<PluginCollision>[] {
	return Object.freeze(pluginCollisions.map((c) => Object.freeze({ ...c })));
}

/**
 * Snapshot of currently loaded plugins (#363). Returns the canonical
 * `package.json#name` of each plugin together with the command names
 * it actually registered (after duplicate-name rejection). Used by
 * `c8ctl doctor plugin` to render an authoritative view of what was
 * loaded vs. what was dropped.
 */
export interface LoadedPluginSummary {
	name: string;
	commands: string[];
}

export function getLoadedPluginSummaries(): LoadedPluginSummary[] {
	const summaries: LoadedPluginSummary[] = [];
	for (const plugin of loadedPlugins.values()) {
		summaries.push({
			name: plugin.name,
			commands: Object.keys(plugin.commands),
		});
	}
	return summaries;
}
