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
	getCommandDef,
	resolveAlias,
} from "./command-registry.ts";
import { detectUnknownFlags, validateFlags } from "./command-validation.ts";
import { showCompletion } from "./commands/completion.ts";
import {
	showCommandHelp,
	showHelp,
	showVerbResources,
	showVersion,
} from "./commands/help.ts";
import { handleAssign, handleUnassign } from "./commands/identity.ts";
import { loadSessionState, resolveTenantId } from "./config.ts";
import { getLogger, type SortOrder } from "./logger.ts";
import { executePluginCommand, loadInstalledPlugins } from "./plugin-loader.ts";
import { c8ctl } from "./runtime.ts";

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

	const { values, positionals } = parseCliArgs();

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
			showCommandHelp(resource);
		} else {
			showHelp();
		}
		return;
	}

	// Handle completion command
	if (verb === "completion") {
		showCompletion(resource);
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
	const commandDef = getCommandDef(verb);
	if (commandDef) {
		validateFlags(values, commandDef.flags);
	}

	// Unknown flag detection — warn about flags not recognised for this verb × resource.
	// Derived from COMMAND_REGISTRY; resource-scoped for search/list.
	const unknownFlags = detectUnknownFlags(verb, normalizedResource, values);
	warnUnknownFlags(logger, unknownFlags, verb, resource);

	// ── Assign / unassign — legacy delegation (not yet migrated to defineCommand) ──
	if (verb === "assign") {
		if (!args[0]) {
			logger.error(
				`ID required. Usage: c8 assign ${normalizedResource} <id> --to-<target>=<targetId>`,
			);
			process.exit(1);
		}
		await handleAssign(normalizedResource, args[0], values, {
			profile: str(values.profile),
		});
		return;
	}

	if (verb === "unassign") {
		if (!args[0]) {
			logger.error(
				`ID required. Usage: c8 unassign ${normalizedResource} <id> --from-<target>=<targetId>`,
			);
			process.exit(1);
		}
		await handleUnassign(normalizedResource, args[0], values, {
			profile: str(values.profile),
		});
		return;
	}

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
		const ctx: CommandContext = {
			client: createClient(profile),
			logger,
			tenantId: resolveTenantId(profile),
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

	// Try to execute plugin command (before unknown-command error)
	if (await executePluginCommand(verb, resource ? [resource, ...args] : args)) {
		return;
	}

	// Unknown command
	logger.error(`Unknown command: ${verb}${resource ? ` ${resource}` : ""}`);
	logger.info('Run "c8 help" for usage information');
	process.exit(1);
}

// Run the CLI only when invoked directly (not when imported)
// Use realpathSync to resolve symlinks (e.g. when installed globally via npm link)
try {
	if (realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
		main().catch((error) => {
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
