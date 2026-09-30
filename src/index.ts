#!/usr/bin/env node
/**
 * c8ctl - Camunda 8 CLI
 * Main entry point
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { COMMAND_DISPATCH } from "./command-dispatch.ts";
import {
	c8ctl,
	createClient,
	getLogger,
	getUserDataDir,
	loadSessionState,
	printUpdateNotification,
	resolveTenantId,
	SilentError,
	type SortOrder,
	startUpdateCheck,
} from "./core/index.ts";
import {
	type CommandContext,
	commandRegistryEntries,
	createDryRun,
	detectUnknownFlags,
	executePluginCommand,
	getCommandDef,
	getPluginCommands,
	getPluginVersionForCommand,
	globalOptions,
	isHostIncompatiblePluginCommand,
	isPassthroughPluginCommand,
	loadInstalledPlugins,
	type ParsedValues,
	type ParseOptions,
	type PluginCtx,
	parseFlags,
	parseVerbArgs,
	confirm as promptConfirm,
	select as promptSelect,
	refreshCompletionsIfStale,
	showCommandHelp,
	showHelp,
	showVerbResources,
	showVersion,
	splitGlobals,
	stripBlockedFlagTokens,
	stripGlobalFlags,
	validateFlags,
} from "./framework/index.ts";
import { npm } from "./utils/index.ts";

/**
 * Type guard: extract a string value from parseArgs values, or undefined.
 * parseArgs with strict:false returns values typed as string | boolean | (string|boolean)[] | undefined.
 * This narrows to string | undefined safely, without type assertions.
 */
function str(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/**
 * Type guard: extract a boolean value from parseArgs values, or undefined.
 */
function bool(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

/**
 * Parse --version flag value into a number, or undefined if not set.
 */
function parseVersionFlag(values: Record<string, unknown>): number | undefined {
	return values.version && typeof values.version === "string"
		? parseInt(values.version, 10)
		: undefined;
}

/**
 * Resolve process definition ID from --id, --processDefinitionId, or --bpmnProcessId flag
 */
export function resolveProcessDefinitionId(
	values: Record<string, unknown>,
): string | undefined {
	return (
		str(values.id) ||
		str(values.processDefinitionId) ||
		str(values.bpmnProcessId)
	);
}

/**
 * Warn about unrecognized flags for a verb × resource combination.
 */
function warnUnknownFlags(
	logger: ReturnType<typeof getLogger>,
	unknownFlags: string[],
	verb: string,
	resource: string,
): void {
	if (unknownFlags.length === 0) return;
	const flagList = unknownFlags.map((f) => `--${f}`).join(", ");
	const command = resource ? `${verb} ${resource}` : verb;
	logger.warn(
		`Flag(s) ${flagList} not recognized for '${command}'. They will be ignored. Run "c8ctl help ${verb}" for valid options.`,
	);
}

/** Verbs that require a resource argument — derived from COMMAND_REGISTRY (includes aliases). */
const VERB_REQUIRES_RESOURCE = new Set(
	commandRegistryEntries()
		.filter(([, def]) => def.requiresResource)
		.flatMap(([verb, def]) => [verb, ...(def.aliases ?? [])]),
);

/**
 * Apply GLOBAL_FLAGS to the process-wide runtime: per-invocation output mode
 * (#356), `--fields`, `--dry-run` and `--verbose`. Idempotent — `main()`
 * calls it once for the flags before the verb and again with the merged set
 * once the flags after the verb have been parsed.
 */
function applyGlobalFlags(values: ParsedValues): void {
	// Apply per-invocation output mode override (#356).
	// Precedence: --json flag > C8CTL_OUTPUT_MODE env var > persisted session.
	// Setting `c8ctl.outputMode` directly is in-memory only; saveSessionState
	// uses the separately-tracked persistedOutputMode from config.ts so this
	// override never leaks back to disk.
	if (values.json === true) {
		c8ctl.outputMode = "json";
	} else if (process.env.C8CTL_OUTPUT_MODE === "json") {
		c8ctl.outputMode = "json";
	} else if (process.env.C8CTL_OUTPUT_MODE === "text") {
		c8ctl.outputMode = "text";
	}
	// Any other C8CTL_OUTPUT_MODE value (including unset, empty, or
	// "yaml"/typo) falls through to the persisted mode loaded above.

	// Resolve --fields flag (agent feature: filter output keys)
	if (values.fields && typeof values.fields === "string") {
		c8ctl.fields = values.fields
			.split(",")
			.map((f) => f.trim())
			.filter(Boolean);
	}

	// Resolve --dry-run flag (agent feature: emit API request without executing)
	if (values["dry-run"]) {
		c8ctl.dryRun = true;
	}

	// Resolve --verbose flag (enable SDK trace logging and surface raw errors)
	if (values.verbose) {
		c8ctl.verbose = true;
	}
}

/**
 * Main CLI handler
 */
async function main() {
	// Load session state from disk at startup
	loadSessionState();

	// Fire-and-forget: check for CLI updates in the background
	startUpdateCheck(c8ctl.version);

	// Stage 1 (#373): parse GLOBAL_FLAGS from the front of argv and stop at
	// the verb. Everything after the verb stays raw for stage 2, which parses
	// it against that command's own flag table.
	const stage1 = splitGlobals(process.argv.slice(2));

	// Global flags given before the verb take effect now so plugin loading
	// (which logs) sees the right output mode; flags after the verb are
	// applied again below once stage 2 has parsed them.
	applyGlobalFlags(stage1.globals);

	// Inject dependencies into the runtime (breaks circular imports)
	// `npm` is the cross-platform runner from utils/. Assigning it here is also
	// the compile-time check that it still satisfies the `NpmRunner` contract
	// core/ declares structurally (core/ may not import utils/).
	c8ctl.init({
		createClient,
		resolveTenantId,
		getLogger,
		getUserDataDir,
		npm,
	});

	// Load installed plugins
	await loadInstalledPlugins();

	const rawVerb = stage1.verb;

	// A global --version before the verb is the CLI version. After the verb
	// it is command-scoped (definition-version filter on built-ins, plugin
	// version on plugin verbs) and is parsed by stage 2 below.
	if (stage1.globals.version === true) {
		showVersion();
		return;
	}

	if (!rawVerb) {
		showHelp();
		return;
	}

	// Stage 2 (#373): parse everything after the verb against
	// GLOBAL_FLAGS ∪ effectiveFlags(verb, resource). Globals stay accepted
	// after the verb (lenient variant).
	const parsed = parseVerbArgs({ rawVerb, rest: stage1.rest });
	const { resource, args } = parsed;
	const values: ParsedValues = { ...stage1.globals, ...parsed.values };
	// `--version` before the verb was handled above; only the post-verb
	// (string) meaning reaches handlers.
	values.version = parsed.values.version;
	applyGlobalFlags(values);

	// Initialize logger with current output mode from c8ctl runtime
	const logger = getLogger(c8ctl.outputMode);

	// Auto-refresh installed completions if CLI version changed
	refreshCompletionsIfStale(c8ctl.dryRun ?? false);

	// Handle help command
	if (
		rawVerb === "help" ||
		rawVerb === "menu" ||
		rawVerb === "--help" ||
		rawVerb === "-h"
	) {
		// Check if user wants help for a specific command
		if (resource) {
			await showCommandHelp(resource);
		} else {
			showHelp();
		}
		return;
	}

	// Resolve verb aliases to canonical verb name (e.g. "w" → "watch",
	// "rm" → "remove" or "unload" depending on the resource argument).
	// Stage 2 already resolved it so the dispatch key uses the canonical verb
	// (not the raw alias) and `c8ctl rm plugin --help` shows unload help
	// (not remove help).
	const verb = parsed.verb;

	// Sort order and --limit only apply to built-in commands; a plugin verb
	// owns its own flag namespace.
	const isPluginVerb =
		Object.hasOwn(getPluginCommands(), verb) && !getCommandDef(verb);

	// Resolve sort order from --asc / --desc flags (default: asc)
	const sortOrder: SortOrder = values.desc ? "desc" : "asc";
	if (!isPluginVerb && values.asc && values.desc) {
		logger.error("Cannot specify both --asc and --desc. Use one or the other.");
		process.exit(1);
	}

	// Resolve --limit flag (max items to fetch)
	const limitStr = isPluginVerb ? undefined : str(values.limit);
	const limit = limitStr ? parseInt(limitStr, 10) : undefined;
	if (limit !== undefined && (Number.isNaN(limit) || limit < 1)) {
		logger.error("--limit must be a positive integer.");
		process.exit(1);
	}

	// `c8ctl <verb> [<resource>] [args] --help` — uniformly route to the help
	// renderer. Placed AFTER the `help`/`menu` reserved-verb handler and
	// BEFORE plugin pre-parse so that every verb (built-in or plugin,
	// resourceless or resource-required) honours --help. Closes the
	// class-scoped contract gap pinned by tests/unit/two-stage-parser-contract.test.ts
	// (#373) where verbs whose missing-resource guard never fired (deploy,
	// run, doctor, output, version, …) silently dispatched to the handler.
	if (values.help) {
		await showCommandHelp(verb);
		return;
	}

	// Check if this is a plugin command — only for verbs not claimed by a built-in.
	// Placed after help/menu handling so those reserved verbs can never be shadowed.
	if (isPluginVerb) {
		const cmd = getPluginCommands()[verb];
		const cmdFlagDefs = typeof cmd !== "function" ? cmd.flags : undefined;

		// Plugin --version (#377): when a plugin verb is invoked with
		// --version, print the plugin's package version and identifying
		// name, not c8ctl's. Routed before any other plugin dispatch so
		// the handler is never called.
		if (values.version) {
			const info = getPluginVersionForCommand(verb);
			if (info) {
				if (logger.mode === "json") {
					logger.json({
						kind: "plugin-version",
						verb,
						pluginName: info.pluginName,
						version: info.version,
					});
				} else {
					logger.info(`${info.pluginName} ${info.version}`);
				}
				return;
			}
		}

		// Construct the plugin host context (#377). Lazy `client` getter
		// mirrors the built-in CommandContext pattern so plugins that
		// never touch a Camunda client (e.g. local-only utilities) do
		// not trigger credential resolution by virtue of receiving ctx.
		// Leave undefined when no flag/session profile is set so
		// resolveClusterConfig() can fall through to CAMUNDA_* env vars,
		// matching the behaviour of built-in commands.
		const pluginProfile = str(values.profile) ?? c8ctl.activeProfile;
		let _pluginClient: ReturnType<typeof createClient> | undefined;
		const pluginCtx: PluginCtx = {
			profile: pluginProfile,
			dryRun: c8ctl.dryRun === true,
			verbose: c8ctl.verbose === true,
			outputMode: c8ctl.outputMode,
			yes: bool(values.yes) === true,
			fields: c8ctl.fields,
			logger,
			prompt: { select: promptSelect, confirm: promptConfirm },
			get client() {
				if (!_pluginClient) _pluginClient = createClient(pluginProfile);
				return _pluginClient;
			},
		};

		// Passthrough plugin contract (#366): strip GLOBAL_FLAGS from the
		// raw argv following the verb token and forward the rest verbatim.
		// GLOBAL_FLAGS already affect the c8ctl runtime via their regular
		// handling earlier in main(); the plugin must not see them again.
		// Validation at load time guarantees passthrough commands are the
		// bare-function form and never carry a `flags` declaration.
		if (isPassthroughPluginCommand(verb)) {
			// Stage 1 already located the verb token (skipping leading
			// GLOBAL_FLAGS, so a verb name that is also the value of a string
			// global like `--profile <verb>` is never mistaken for the verb);
			// `rest` is everything after it, verbatim.
			const forwarded = stripGlobalFlags(stage1.rest);
			await executePluginCommand(verb, forwarded, undefined, pluginCtx);
			return;
		}

		if (cmdFlagDefs) {
			// Plugin flag scoping (#373): a plugin verb's effective flag
			// namespace is `GLOBAL_FLAGS ∪ plugin.flags`. Use ONLY the
			// global flags as the conflict source — never the union of
			// every built-in verb's flags. Otherwise a plugin can't declare
			// a flag like `--limit` (which lives in SEARCH_FLAGS, valid
			// only on `search`/`get`) without being silently blocked, even
			// though `--limit` is irrelevant to the plugin's verb.
			//
			// Globals are still treated as a hard conflict because the
			// host strips them from argv before the plugin parser sees
			// them, so a plugin's same-named flag would never receive a
			// value (#364).
			const builtinOptions = globalOptions();
			const builtinShorts = new Set(
				Object.values(builtinOptions)
					.map((o) => o.short)
					.filter((s): s is string => s !== undefined),
			);
			// `globalOptions()` is a null-prototype table, so plugin-supplied
			// flag names like `__proto__`, `constructor`, or `prototype`
			// cannot pollute the prototype chain when assigned below (paired
			// with the `Object.hasOwn` collision check).
			const mergedOptions: ParseOptions = globalOptions();
			const blockedFlags = new Set<string>();
			for (const [name, def] of Object.entries(cmdFlagDefs)) {
				if (Object.hasOwn(builtinOptions, name)) {
					// A required plugin flag whose name collides with a global
					// flag is unsatisfiable: the token is always stripped from
					// argv before the plugin parser sees it, so the required
					// check downstream would always fire with the misleading
					// "--<name> is required" message even when the user did
					// pass a value (#364). Fail fast here with a single
					// actionable error instead.
					if (def.required === true) {
						logger.error(
							`Plugin flag --${name} is declared required but conflicts with a global c8ctl flag of the same name; ` +
								`it can never be satisfied. The plugin must rename this flag.`,
						);
						process.exit(1);
					}
					logger.warn(
						`Plugin flag --${name} conflicts with a global c8ctl flag and will not be parsed`,
					);
					blockedFlags.add(name);
					continue;
				}
				const short =
					def.short && builtinShorts.has(def.short) ? undefined : def.short;
				if (def.short && !short) {
					logger.warn(
						`Plugin flag --${name} short alias -${def.short} conflicts with a global c8ctl alias and will be ignored`,
					);
				}
				mergedOptions[name] = {
					type: def.type,
					...(short && { short }),
					...(def.multiple && { multiple: true }),
				};
			}
			// Strip blocked-flag tokens from argv before re-parse. Blocked
			// names exclusively collide with GLOBAL_FLAGS (post-#373), but
			// `mergedOptions` carries the global type for those names, so
			// parseArgs alone would consume only the value of *string*
			// globals — leaving the value of a *boolean* global behind to
			// drift into positionals when the plugin typed the same name
			// as string. The helper consults both type tables and strips
			// the following non-flag token when either side is string.
			// Stage 2 for a plugin verb: re-parse the raw tokens after the verb
			// against `GLOBAL_FLAGS ∪ plugin.flags`.
			const filteredArgv = stripBlockedFlagTokens({
				argv: stage1.rest,
				blocked: blockedFlags,
				pluginFlagDefs: cmdFlagDefs,
				globalFlagDefs: builtinOptions,
			});
			const pluginParsed = parseFlags({
				args: filteredArgv,
				options: mergedOptions,
			});
			const extractedFlags: Record<string, unknown> = {};
			for (const [flagName, def] of Object.entries(cmdFlagDefs)) {
				if (blockedFlags.has(flagName)) continue;
				const raw = pluginParsed.values[flagName];
				// multiple:true flags collect all values into an array — preserve
				// the array so the plugin handler receives every supplied value.
				// Non-multiple string flags may still arrive as an array when
				// parseArgs sees the same flag name declared as multiple elsewhere;
				// take the last value (last-write-wins) in that case.
				const value =
					def.type === "string" && Array.isArray(raw) && !def.multiple
						? (raw.findLast((v) => typeof v === "string") ?? undefined)
						: raw;
				if (value !== undefined) {
					extractedFlags[flagName] = value;
				}
				// A disabled plugin (#523) is exempt: its handler exists only to
				// explain which c8ctl it needs, and "--label is required" would
				// send the user off to satisfy a flag for a command that cannot
				// run whatever they pass.
				if (
					def.required === true &&
					value === undefined &&
					!isHostIncompatiblePluginCommand(verb)
				) {
					logger.error(`--${flagName} is required`);
					process.exit(1);
				}
			}
			await executePluginCommand(
				verb,
				pluginParsed.positionals,
				extractedFlags,
				pluginCtx,
			);
		} else {
			await executePluginCommand(
				verb,
				resource ? [resource, ...args] : args,
				undefined,
				pluginCtx,
			);
		}
		return;
	}

	// Normalize resource
	const normalizedResource = parsed.normalizedResource;

	// Resource validation guard — single chokepoint for all verbs that require a resource.
	// Derived from COMMAND_REGISTRY.requiresResource.
	// help/completion are dispatched before this point.
	// If --help is passed, show verb help instead of the resource error.
	if (!resource && VERB_REQUIRES_RESOURCE.has(verb)) {
		if (values.help) {
			showVerbResources(verb);
			return;
		}
		showVerbResources(verb);
		process.exit(1);
	}

	// Flag validation — run all registered validators before dispatch.
	// Validators throw on invalid input; validateFlags catches and exits.
	// Also enforces `required: true` on the effective flag set (#308).
	const commandDef = getCommandDef(verb);
	if (commandDef) {
		const effectiveFlags =
			commandDef.resourceFlags?.[normalizedResource] ?? commandDef.flags;
		validateFlags(values, effectiveFlags);
	}

	// Unknown flag detection — warn about flags not recognised for this verb × resource.
	// Derived from COMMAND_REGISTRY; resource-scoped for search/list.
	const unknownFlags = detectUnknownFlags(verb, normalizedResource, values);
	warnUnknownFlags(logger, unknownFlags, verb, resource);

	// ── Registry-driven dispatch ───────────────────────────────────────────
	// For verbs with enumerated resources (e.g. `list process-instance`),
	// the dispatch key includes the normalised resource.
	// For verbs without enumerated resources (e.g. `deploy`, `run`, `watch`),
	// the resource slot holds the first positional argument (a file path, etc.)
	// and the dispatch key uses an empty resource suffix.
	const hasEnumeratedResources =
		commandDef !== undefined &&
		commandDef.resources !== undefined &&
		commandDef.resources.length > 0;
	const useResourceKey =
		VERB_REQUIRES_RESOURCE.has(verb) && hasEnumeratedResources;
	const dispatchKey = useResourceKey
		? `${verb}:${normalizedResource}`
		: `${verb}:`;
	// For verbs with enumerated resources, fall back to "verb:" when the
	// specific resource key isn't found (lets the handler validate/reject).
	const handler =
		COMMAND_DISPATCH.get(dispatchKey) ??
		(useResourceKey ? COMMAND_DISPATCH.get(`${verb}:`) : undefined);
	if (handler) {
		const profile = str(values.profile);
		// Lazy config access: createClient() and resolveTenantId() are deferred
		// until first access, so commands that never touch ctx.client or
		// ctx.tenantId (e.g. session/profile management) skip config resolution.
		let _client: ReturnType<typeof createClient> | undefined;
		let _tenantId: string | undefined;
		let _tenantResolved = false;
		const ctx: CommandContext = {
			get client() {
				if (!_client) _client = createClient(profile);
				return _client;
			},
			logger,
			get tenantId() {
				if (!_tenantResolved) {
					_tenantId = resolveTenantId(profile);
					_tenantResolved = true;
				}
				return _tenantId;
			},
			resource: useResourceKey ? normalizedResource : resource || "",
			positionals: args,
			sortOrder,
			sortBy: str(values.sortBy),
			limit,
			all: bool(values.all),
			between: str(values.between),
			dateField: str(values.dateField),
			version: parseVersionFlag(values),
			isDryRun: c8ctl.dryRun ?? false,
			dryRun: createDryRun(c8ctl.dryRun ?? false),
			verbose: c8ctl.verbose ?? false,
			profile,
			yes: bool(values.yes) === true,
		};
		await handler.execute(ctx, values, args);
		return;
	}

	// Unknown command (plugin check was already done above)
	logger.error(`Unknown command: ${verb}${resource ? ` ${resource}` : ""}`);
	logger.info('Run "c8 help" for usage information');
	process.exit(1);
}

// Run the CLI only when invoked directly (not when imported)
// Use realpathSync to resolve symlinks (e.g. when installed globally via npm link)
try {
	if (realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
		main()
			.then(() => printUpdateNotification())
			.catch((error) => {
				if (c8ctl.verbose) {
					throw error;
				}
				// A SilentError carries a message that is already the complete,
				// user-facing diagnosis (see core/errors.ts). Render it as one
				// error line — "Unexpected error" plus a stack would bury it.
				if (error instanceof SilentError) {
					getLogger(c8ctl.outputMode).error(error.message);
					process.exit(1);
				}
				console.error("Unexpected error:", error);
				process.exit(1);
			});
	}
} catch {
	/* not invoked directly */
}
