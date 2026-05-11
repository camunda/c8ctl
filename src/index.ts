#!/usr/bin/env node
/**
 * c8ctl - Camunda 8 CLI
 * Main entry point
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createClient } from "./client.ts";
import { COMMAND_DISPATCH } from "./command-dispatch.ts";
import type { CommandContext } from "./command-framework.ts";
import {
	COMMAND_REGISTRY,
	type CommandDef,
	deriveParseArgsOptions,
	GLOBAL_FLAGS,
	getCommandDef,
	resolveAlias,
} from "./command-registry.ts";
import { detectUnknownFlags, validateFlags } from "./command-validation.ts";
import { refreshCompletionsIfStale } from "./completion.ts";
import { loadSessionState, resolveTenantId } from "./config.ts";
import {
	showCommandHelp,
	showHelp,
	showVerbResources,
	showVersion,
} from "./help.ts";
import { getLogger, type SortOrder } from "./logger.ts";
import {
	executePluginCommand,
	getPluginCommands,
	isPassthroughPluginCommand,
	loadInstalledPlugins,
} from "./plugin-loader.ts";
import { c8ctl } from "./runtime.ts";
import { printUpdateNotification, startUpdateCheck } from "./update-check.ts";

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
 * Parse command line arguments.
 * Options are derived from the command registry — no manual duplication.
 */
function parseCliArgs() {
	try {
		const { values, positionals } = parseArgs({
			args: process.argv.slice(2),
			options: deriveParseArgsOptions(),
			allowPositionals: true,
			strict: false,
		});

		return { values, positionals };
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`Error parsing arguments: ${message}`);
		process.exit(1);
	}
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
 * Return the raw argv tokens that follow the verb position, where the
 * verb position is found by walking from the start and skipping leading
 * GLOBAL_FLAGS only (consuming the value of string-typed global flags).
 * The first non-flag token — or any unknown `--*`/`-*` token — is
 * treated as the verb candidate.
 *
 * This avoids `argv.indexOf(verb)`, which is unsafe because the verb
 * string may also appear as the value of a global string flag (e.g.
 * `--profile <verb>`). Returns `[]` if no verb token is found at or
 * after the scan position.
 */
export function sliceArgvAfterVerb(argv: string[], verb: string): string[] {
	const stringGlobalNames = new Set<string>();
	const stringGlobalShorts = new Set<string>();
	const booleanGlobalNames = new Set<string>();
	const booleanGlobalShorts = new Set<string>();
	for (const [name, def] of Object.entries(GLOBAL_FLAGS)) {
		const short = "short" in def ? def.short : undefined;
		if (def.type === "string") {
			stringGlobalNames.add(name);
			if (short) stringGlobalShorts.add(short);
		} else {
			booleanGlobalNames.add(name);
			if (short) booleanGlobalShorts.add(short);
		}
	}

	let i = 0;
	while (i < argv.length) {
		const tok = argv[i];
		if (tok === "--") {
			// GNU `--` convention: end of options. The next token is the
			// verb candidate. Skip the separator and continue scanning so
			// `c8ctl -- <verb> <args...>` dispatches correctly with the
			// full post-verb argv (rather than bailing and forwarding []).
			i++;
			continue;
		}
		if (tok.startsWith("--")) {
			const eq = tok.indexOf("=");
			const name = eq >= 0 ? tok.slice(2, eq) : tok.slice(2);
			if (booleanGlobalNames.has(name)) {
				i++;
				continue;
			}
			if (stringGlobalNames.has(name)) {
				i += eq < 0 ? 2 : 1;
				continue;
			}
			// Unknown long flag — do not silently consume a value. Fall through
			// to the verb match below (and bail if it doesn't match).
		} else if (tok.startsWith("-") && tok.length === 2) {
			const short = tok.slice(1);
			if (booleanGlobalShorts.has(short)) {
				i++;
				continue;
			}
			if (stringGlobalShorts.has(short)) {
				i += 2;
				continue;
			}
		}
		// First token that is not a leading GLOBAL_FLAG must be the verb.
		if (tok === verb) return argv.slice(i + 1);
		return [];
	}
	return [];
}

/**
 * Strip GLOBAL_FLAGS (and the value of any string-typed global flag) from
 * a raw argv slice before forwarding to a passthrough plugin handler
 * (#366). GLOBAL_FLAGS already affect the c8ctl runtime via their
 * regular handling in `main()`; the plugin must not see them again.
 *
 * Conservative behaviour: an isolated `--` terminator is preserved and
 * everything after it is forwarded verbatim, matching POSIX convention.
 */
export function stripGlobalFlags(argv: string[]): string[] {
	const booleanFlags = new Set<string>();
	const stringFlags = new Set<string>();
	const booleanShorts = new Set<string>();
	const stringShorts = new Set<string>();

	for (const [name, def] of Object.entries(GLOBAL_FLAGS)) {
		const short = "short" in def ? def.short : undefined;
		if (def.type === "boolean") {
			booleanFlags.add(name);
			if (short) booleanShorts.add(short);
		} else {
			stringFlags.add(name);
			if (short) stringShorts.add(short);
		}
	}

	const out: string[] = [];
	let i = 0;
	let sawTerminator = false;
	while (i < argv.length) {
		const tok = argv[i];
		if (sawTerminator) {
			out.push(tok);
			i++;
			continue;
		}
		if (tok === "--") {
			sawTerminator = true;
			out.push(tok);
			i++;
			continue;
		}
		if (tok.startsWith("--")) {
			const eq = tok.indexOf("=");
			const name = eq >= 0 ? tok.slice(2, eq) : tok.slice(2);
			if (booleanFlags.has(name) || stringFlags.has(name)) {
				if (eq < 0 && stringFlags.has(name)) i++; // consume value
				i++;
				continue;
			}
		} else if (tok.startsWith("-") && tok.length === 2) {
			const short = tok.slice(1);
			if (booleanShorts.has(short)) {
				i++;
				continue;
			}
			if (stringShorts.has(short)) {
				i += 2; // consume short flag and its value
				continue;
			}
		}
		out.push(tok);
		i++;
	}
	return out;
}

/**
 * Remove tokens for blocked plugin flags from an argv slice so they cannot
 * shift positionals during the plugin-flag re-parse.
 *
 * The built-in may declare a blocked flag as boolean while the plugin
 * declared it as string. In that case the user supplied a value token
 * (--name value) that the built-in parser leaves in positionals. We use
 * the PLUGIN's declared type to decide whether to strip a following token.
 */
function stripBlockedFlagTokens(
	argv: string[],
	blocked: Set<string>,
	pluginFlagDefs: Record<string, { type: string }>,
): string[] {
	const out: string[] = [];
	let i = 0;
	while (i < argv.length) {
		const arg = argv[i];
		if (arg.startsWith("--")) {
			const eqIdx = arg.indexOf("=");
			const name = eqIdx >= 0 ? arg.slice(2, eqIdx) : arg.slice(2);
			if (blocked.has(name)) {
				if (
					eqIdx < 0 &&
					pluginFlagDefs[name]?.type === "string" &&
					i + 1 < argv.length &&
					!argv[i + 1].startsWith("-")
				) {
					i++;
				}
				i++;
				continue;
			}
		}
		out.push(arg);
		i++;
	}
	return out;
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
	// biome-ignore lint/plugin: widen to CommandDef to access optional aliases property
	(Object.entries(COMMAND_REGISTRY) as [string, CommandDef][])
		.filter(([, def]) => def.requiresResource)
		.flatMap(([verb, def]) => [verb, ...(def.aliases ?? [])]),
);

/**
 * Main CLI handler
 */
async function main() {
	// Load session state from disk at startup
	loadSessionState();

	// Fire-and-forget: check for CLI updates in the background
	startUpdateCheck(c8ctl.version);

	const { values, positionals } = parseCliArgs();

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

	// Initialize logger with current output mode from c8ctl runtime
	const logger = getLogger(c8ctl.outputMode);

	// Resolve sort order from --asc / --desc flags (default: asc)
	const sortOrder: SortOrder = values.desc ? "desc" : "asc";
	if (values.asc && values.desc) {
		logger.error("Cannot specify both --asc and --desc. Use one or the other.");
		process.exit(1);
	}

	// Resolve --limit flag (max items to fetch)
	const limitStr = str(values.limit);
	const limit = limitStr ? parseInt(limitStr, 10) : undefined;
	if (limit !== undefined && (Number.isNaN(limit) || limit < 1)) {
		logger.error("--limit must be a positive integer.");
		process.exit(1);
	}

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

	// Inject dependencies into the runtime (breaks circular imports)
	c8ctl.init({ createClient, resolveTenantId, getLogger });

	// Load installed plugins
	await loadInstalledPlugins();

	// Auto-refresh installed completions if CLI version changed
	refreshCompletionsIfStale();

	// Extract command and resource
	const [verb, resource, ...args] = positionals;

	// Handle global --version flag (only when no verb/command is provided)
	if (values.version && !verb) {
		showVersion();
		return;
	}

	if (values.help && positionals.length === 0) {
		showHelp();
		return;
	}

	if (!verb) {
		showHelp();
		return;
	}

	// Handle help command
	if (
		verb === "help" ||
		verb === "menu" ||
		verb === "--help" ||
		verb === "-h"
	) {
		// Check if user wants help for a specific command
		if (resource) {
			await showCommandHelp(resource);
		} else {
			showHelp();
		}
		return;
	}

	// Check if this is a plugin command — only for verbs not claimed by a built-in.
	// Placed after help/menu handling so those reserved verbs can never be shadowed.
	const pluginCommands = getPluginCommands();
	if (verb && Object.hasOwn(pluginCommands, verb) && !getCommandDef(verb)) {
		const cmd = pluginCommands[verb];
		const cmdFlagDefs = typeof cmd !== "function" ? cmd.flags : undefined;

		// Passthrough plugin contract (#366): strip GLOBAL_FLAGS from the
		// raw argv following the verb token and forward the rest verbatim.
		// GLOBAL_FLAGS already affect the c8ctl runtime via their regular
		// handling earlier in main(); the plugin must not see them again.
		// Validation at load time guarantees passthrough commands are the
		// bare-function form and never carry a `flags` declaration.
		if (isPassthroughPluginCommand(verb)) {
			// Locate the verb token by walking process.argv from the start and
			// skipping leading GLOBAL_FLAGS (consuming string-flag values).
			// A naive `indexOf(verb)` is unsafe because `verb` may also appear
			// as the value of a global string flag (e.g. `--profile <verb>`).
			const rawAfterVerb = sliceArgvAfterVerb(process.argv.slice(2), verb);
			const forwarded = stripGlobalFlags(rawAfterVerb);
			await executePluginCommand(verb, forwarded);
			return;
		}

		if (cmdFlagDefs) {
			// Use built-in flags as a blacklist: start from the full built-in
			// option set, then add plugin flags only when the name is not already
			// taken. This prevents a plugin flag from silently changing a built-in
			// flag's parse type.
			const builtinOptions = deriveParseArgsOptions();
			const builtinShorts = new Set(
				Object.values(builtinOptions)
					.map((o) => o.short)
					.filter((s): s is string => s !== undefined),
			);
			const mergedOptions = { ...builtinOptions };
			const blockedFlags = new Set<string>();
			for (const [name, def] of Object.entries(cmdFlagDefs)) {
				if (name in builtinOptions) {
					logger.warn(
						`Plugin flag --${name} conflicts with a built-in flag and will not be parsed`,
					);
					blockedFlags.add(name);
					continue;
				}
				const short =
					def.short && builtinShorts.has(def.short) ? undefined : def.short;
				if (def.short && !short) {
					logger.warn(
						`Plugin flag --${name} short alias -${def.short} conflicts with a built-in alias and will be ignored`,
					);
				}
				mergedOptions[name] = {
					type: def.type,
					...(short && { short }),
				};
			}
			const filteredArgv = stripBlockedFlagTokens(
				process.argv.slice(2),
				blockedFlags,
				cmdFlagDefs,
			);
			let pluginParsed: ReturnType<typeof parseArgs>;
			try {
				pluginParsed = parseArgs({
					args: filteredArgv,
					options: mergedOptions,
					allowPositionals: true,
					strict: false,
				});
			} catch (error: unknown) {
				const message = error instanceof Error ? error.message : String(error);
				console.error(`Error parsing arguments: ${message}`);
				process.exit(1);
			}
			const extractedFlags: Record<string, unknown> = {};
			for (const [flagName, def] of Object.entries(cmdFlagDefs)) {
				if (blockedFlags.has(flagName)) continue;
				const raw = pluginParsed.values[flagName];
				// Repeated string flags arrive as arrays — take the last value
				// (last-write-wins), matching built-in flag normalization.
				const value =
					def.type === "string" && Array.isArray(raw)
						? (raw.findLast((v) => typeof v === "string") ?? undefined)
						: raw;
				if (value !== undefined) {
					extractedFlags[flagName] = value;
				}
				if (def.required === true && value === undefined) {
					logger.error(`--${flagName} is required`);
					process.exit(1);
				}
			}
			const [_verb, _resource, ...pluginArgs] = pluginParsed.positionals;
			await executePluginCommand(
				verb,
				_resource ? [_resource, ...pluginArgs] : pluginArgs,
				extractedFlags,
			);
		} else {
			await executePluginCommand(verb, resource ? [resource, ...args] : args);
		}
		return;
	}

	// Normalize resource
	const normalizedResource = resource ? resolveAlias(resource) : "";

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
			dryRun: c8ctl.dryRun,
			profile,
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
				console.error("Unexpected error:", error);
				process.exit(1);
			});
	}
} catch {
	/* not invoked directly */
}
