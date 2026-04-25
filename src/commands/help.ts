/**
 * Help and version commands
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	COMMAND_REGISTRY,
	type CommandDef,
	type FlagDef,
	GLOBAL_FLAGS,
	RESOURCE_ALIASES,
	SEARCH_FLAGS,
} from "../command-registry.ts";
import { getLogger } from "../logger.ts";
import {
	executePluginCommand,
	getPluginCommandsInfo,
	isPluginCommand,
	type PluginCommandInfo,
} from "../plugin-loader.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Typed entries for COMMAND_REGISTRY — avoids `as CommandDef` on every loop. */
function registryEntries(): [string, CommandDef][] {
	return Object.entries(COMMAND_REGISTRY);
}

/** Typed entries for a flag record — avoids `as FlagDef` on every loop. */
function flagEntries(flags: Record<string, FlagDef>): [string, FlagDef][] {
	return Object.entries(flags);
}

/** Look up a verb in COMMAND_REGISTRY, returning undefined for unknown verbs. */
function lookupVerb(verb: string): CommandDef | undefined {
	// biome-ignore lint/plugin: single isolation point — COMMAND_REGISTRY uses `satisfies` so Object index needs widening
	return (COMMAND_REGISTRY as Record<string, CommandDef>)[verb];
}

/**
 * Build structured JSON help data for machine/agent consumption.
 * Returned by showHelp() and showCommandHelp() in JSON output mode.
 */

interface HelpFlag {
	flag: string;
	type: string;
	description: string;
	short?: string;
	appliesTo?: string;
}

interface HelpCommand {
	verb: string;
	resource: string;
	resources: string[];
	description: string;
	mutating: boolean;
	examples?: Array<{ command: string; description: string }> | string[];
}

interface HelpJson {
	version: string;
	usage: string;
	commands: HelpCommand[];
	resourceAliases: Record<string, string>;
	globalFlags: HelpFlag[];
	searchFlags: HelpFlag[];
	agentFlags: HelpFlag[];
}

/**
 * Derive the display name for a resource, showing long name with alias.
 * e.g. "pi" → "process-instance (pi)", "jobs" → "jobs"
 */
function resourceDisplayName(resource: string): string {
	const canonical = RESOURCE_ALIASES[resource];
	// No alias mapping — show as-is
	if (!canonical || canonical === resource) return resource;
	// Resource is longer than canonical (e.g. "process-instances" → "process-instance")
	if (resource.length > canonical.length) return `${resource} (${canonical})`;
	// Resource is a short alias (e.g. "pi" → "process-instance")
	return `${canonical} (${resource})`;
}

/**
 * Format a single flag for display.
 */
function formatFlag(name: string, def: FlagDef, col: number): string {
	const flag = def.short ? `--${name}, -${def.short}` : `--${name}`;
	const typeHint = def.type === "string" ? ` <${name}>` : "";
	return `    ${(flag + typeHint).padEnd(col)}${def.description}`;
}

/**
 * Build structured JSON help data for machine/agent consumption.
 * Derived entirely from COMMAND_REGISTRY.
 */
function buildHelpJson(
	version: string,
	pluginCommandsInfo: PluginCommandInfo[],
): HelpJson {
	const commands: HelpCommand[] = [];

	for (const [verb, def] of registryEntries()) {
		commands.push({
			verb,
			resource: deriveResourcePlaceholder(verb, def),
			resources: [...def.resources],
			description: def.helpDescription ?? def.description,
			mutating: def.mutating,
		});
	}

	for (const cmd of pluginCommandsInfo) {
		commands.push({
			verb: cmd.commandName,
			resource: "",
			resources: [],
			description: cmd.description || "",
			mutating: false,
			examples: cmd.examples || [],
		});
	}

	// Derive resource aliases: short alias → canonical(s)
	const resourceAliases: Record<string, string> = {};
	for (const [alias, canonical] of Object.entries(RESOURCE_ALIASES)) {
		if (alias.length <= 4 && alias !== canonical) {
			resourceAliases[alias] = `${canonical}(s)`;
		}
	}

	// Derive global flags from GLOBAL_FLAGS only.
	// Per #321, SEARCH_FLAGS belong in `searchFlags`, not `globalFlags`.
	const globalFlags: HelpFlag[] = [];
	for (const [name, def] of flagEntries(GLOBAL_FLAGS)) {
		globalFlags.push({
			flag: `--${name}`,
			type: def.type,
			description: def.description,
			...(def.short ? { short: `-${def.short}` } : {}),
		});
	}

	// Derive search flags from SEARCH_FLAGS plus list/search resourceFlags
	const searchFlags: HelpFlag[] = [];
	const seenSearchFlags = new Set<string>();
	for (const [name, def] of Object.entries(SEARCH_FLAGS)) {
		seenSearchFlags.add(name);
		searchFlags.push({
			flag: `--${name}`,
			type: def.type,
			description: def.description,
		});
	}
	for (const verb of ["list", "search"] as const) {
		const cmdDef = lookupVerb(verb);
		if (cmdDef?.resourceFlags) {
			for (const resourceFlags of Object.values(cmdDef.resourceFlags)) {
				for (const [name, fd] of flagEntries(resourceFlags)) {
					if (!seenSearchFlags.has(name)) {
						seenSearchFlags.add(name);
						searchFlags.push({
							flag: `--${name}`,
							type: fd.type,
							description: fd.description,
						});
					}
				}
			}
		}
	}

	return {
		version,
		usage: "c8ctl <command> [resource] [options]",
		commands,
		resourceAliases,
		globalFlags,
		searchFlags,
		agentFlags: flagEntries(GLOBAL_FLAGS)
			.filter(([, f]) => f.agentDescription)
			.map(([name, f]) => ({
				flag: `--${name}`,
				type: f.type,
				description: (f.agentDescription ?? "").replace(/\n/g, " "),
				...(f.agentAppliesTo ? { appliesTo: f.agentAppliesTo } : {}),
			})),
	};
}

/**
 * Get package version
 */
export function getVersion(): string {
	const packagePath = join(__dirname, "../../package.json");
	const packageJson = JSON.parse(readFileSync(packagePath, "utf-8"));
	return packageJson.version;
}

/**
 * Display version
 */
export function showVersion(): void {
	const logger = getLogger();
	logger.info(`c8ctl v${getVersion()}`);
}

// ─── Derived help generation ─────────────────────────────────────────────────

/**
 * Derive the resource placeholder for a command's help line.
 * Uses helpResource override if set, otherwise auto-derives from
 * resources list, positionals, and requiresResource flag.
 */
function deriveResourcePlaceholder(_verb: string, def: CommandDef): string {
	if (def.helpResource) return def.helpResource;

	const resources = def.resources;

	// Single-resource commands: show "resource <positional>"
	if (resources.length === 1) {
		const canonical = RESOURCE_ALIASES[resources[0]] ?? resources[0];
		const positionals = def.resourcePositionals?.[canonical];
		if (positionals && positionals.length > 0) {
			const posArgs = positionals
				.map((p) => (p.required ? `<${p.name}>` : `[${p.name}]`))
				.join(" ");
			return `${resources[0]} ${posArgs}`;
		}
		return resources[0];
	}

	// Multi-resource commands
	if (resources.length > 1 && def.requiresResource) {
		// Find common positional shape across resources
		const allPositionals = def.resourcePositionals
			? Object.values(def.resourcePositionals)
			: [];

		if (allPositionals.length > 0) {
			// Use the first resource's positionals as representative
			const first = allPositionals[0];
			if (first.length > 0) {
				const posArgs = first
					.map((p) => (p.required ? `<${p.name}>` : `[${p.name}]`))
					.join(" ");
				return `<resource> ${posArgs}`;
			}
		}
		return "<resource>";
	}

	return "";
}

/**
 * Build the resource suffix for description (e.g. "(pi, pd, ut, inc)")
 * Shows the valid resources when the placeholder is generic (<resource>, <app>).
 */
function deriveResourceSuffix(verb: string, def: CommandDef): string {
	if (def.resources.length === 0) return "";
	const placeholder = deriveResourcePlaceholder(verb, def);
	// Show suffix only when placeholder is generic (contains <resource> or <app>)
	if (placeholder.includes("<resource>") || placeholder.includes("<app>")) {
		return ` (${def.resources.join(", ")})`;
	}
	return "";
}

/**
 * Generate the Commands section lines from the registry.
 */
function generateCommandLines(): string {
	const lines: string[] = [];
	const DESC_COL = 36; // description starts at column 36

	for (const [verb, def] of registryEntries()) {
		const resource = deriveResourcePlaceholder(verb, def);
		const desc = def.helpDescription ?? def.description;
		const suffix = deriveResourceSuffix(verb, def);

		// Ensure at least 2 spaces between verb and resource, and between resource and desc
		const verbPadded = verb.length >= 10 ? `${verb}  ` : verb.padEnd(10);
		const leftPart = `  ${verbPadded}${resource}`;
		const padding = Math.max(2, DESC_COL - leftPart.length);
		lines.push(`${leftPart}${" ".repeat(padding)}${desc}${suffix}`);
	}

	return lines.join("\n");
}

/**
 * Generate the Flags section from GLOBAL_FLAGS and select verb-specific flags.
 * Uses the curated descriptions from the registry.
 */
function generateFlagsSection(): string {
	// Per #321, the top-level Flags section lists ONLY truly global flags.
	// Command-specific flags belong in `c8ctl help <verb>`.
	const lines: string[] = [];
	const FLAG_COL = 36;
	for (const [name, def] of flagEntries(GLOBAL_FLAGS)) {
		const flag = def.short ? `--${name}, -${def.short}` : `--${name}`;
		const typeHint = def.type === "string" ? ` <${name}>` : "";
		lines.push(`  ${(flag + typeHint).padEnd(FLAG_COL)}${def.description}`);
	}
	return lines.join("\n");
}

/**
 * Generate the Search Flags section from SEARCH_FLAGS and
 * all unique search-specific flags across command resourceFlags.
 */
function generateSearchFlagsSection(): string {
	const lines: string[] = [];
	const FLAG_COL = 36;

	// Collect unique search flags from list and search commands
	const searchFlagMap = new Map<string, FlagDef>();
	for (const verb of ["list", "search"] as const) {
		const def = COMMAND_REGISTRY[verb];
		if (def.resourceFlags) {
			for (const resourceFlags of Object.values(def.resourceFlags)) {
				for (const [name, flagDef] of Object.entries(resourceFlags)) {
					if (!searchFlagMap.has(name)) {
						searchFlagMap.set(name, flagDef);
					}
				}
			}
		}
	}

	// Search/list shared flags
	for (const [name, def] of Object.entries(SEARCH_FLAGS)) {
		const typeHint = def.type === "string" ? ` <${name}>` : "";
		lines.push(
			`  ${(`--${name}${typeHint}`).padEnd(FLAG_COL)}${def.description}`,
		);
	}

	// Separate case-sensitive and case-insensitive flags
	const caseSensitive: [string, FlagDef][] = [];
	const caseInsensitive: [string, FlagDef][] = [];

	for (const [name, def] of searchFlagMap) {
		// Skip flags already in SEARCH_FLAGS
		if (name in SEARCH_FLAGS) continue;
		if (
			name.startsWith("i") &&
			name.length > 1 &&
			name[1] === name[1].toLowerCase()
		) {
			// Check if there's a non-i version
			const baseName = name.slice(1);
			const firstLower = baseName[0].toLowerCase() + baseName.slice(1);
			if (searchFlagMap.has(firstLower)) {
				caseInsensitive.push([name, def]);
				continue;
			}
		}
		caseSensitive.push([name, def]);
	}

	for (const [name, def] of caseSensitive) {
		const typeHint = def.type === "string" ? ` <${name}>` : "";
		lines.push(
			`  ${(`--${name}${typeHint}`).padEnd(FLAG_COL)}${def.description}`,
		);
	}

	if (caseInsensitive.length > 0) {
		lines.push("");
		lines.push("  Case-Insensitive Search (--i prefix):");
		for (const [name, def] of caseInsensitive) {
			const typeHint = def.type === "string" ? " <pattern>" : "";
			lines.push(
				`  ${(`--${name}${typeHint}`).padEnd(FLAG_COL)}${def.description}`,
			);
		}
	}

	return lines.join("\n");
}

/**
 * Generate resource aliases section from RESOURCE_ALIASES.
 */
function generateResourceAliases(): string {
	// Collect unique alias → long-name mappings
	// We want to show short aliases (pi, pd, ut, inc, msg, auth, mr)
	const displayed = new Map<string, string>();
	for (const [alias, canonical] of Object.entries(RESOURCE_ALIASES)) {
		// Only show short aliases (not the long plural forms)
		if (alias.length <= 4 && alias !== canonical) {
			if (!displayed.has(alias)) {
				// Find the plural/long form for display
				const plural = Object.entries(RESOURCE_ALIASES).find(
					([k, v]) => v === canonical && k.includes("-") && k !== alias,
				);
				const displayName = plural ? `${canonical}(s)` : canonical;
				displayed.set(alias, displayName);
			}
		}
	}

	const lines: string[] = [];
	for (const [alias, longName] of displayed) {
		lines.push(`  ${alias.padEnd(5)}= ${longName}`);
	}
	return lines.join("\n");
}

/**
 * Generate the "For detailed help" footer from commands with hasDetailedHelp.
 */
function generateHelpFooter(): string {
	const lines: string[] = [];
	const CMD_COL = 35;

	for (const [verb, def] of registryEntries()) {
		if (def.hasDetailedHelp) {
			const label =
				def.helpFooterLabel ?? `Show ${verb} command with all flags`;
			lines.push(`  ${`c8ctl help ${verb}`.padEnd(CMD_COL)}${label}`);
		}
	}

	// Special entries: profiles and plugin (virtual help topics)
	lines.push(
		`  ${`c8ctl help profiles`.padEnd(CMD_COL)}Show profile management help`,
	);
	lines.push(
		`  ${`c8ctl help plugin`.padEnd(CMD_COL)}Show plugin management help`,
	);
	lines.push(
		`  ${`c8ctl help plugins`.padEnd(CMD_COL)}Show plugin management help (alias)`,
	);

	return lines.join("\n");
}

/**
 * Generate the Examples section from registry helpExamples.
 */
function generateExamplesSection(): string {
	const lines: string[] = [];
	const DESC_COL = 36;

	for (const [, def] of registryEntries()) {
		if (!def.helpExamples) continue;
		for (const ex of def.helpExamples) {
			const padding = Math.max(2, DESC_COL - ex.command.length - 2);
			lines.push(`  ${ex.command}${" ".repeat(padding)}${ex.description}`);
		}
	}

	return lines.join("\n");
}

/**
 * Generate the Agent Flags section from GLOBAL_FLAGS entries
 * that have agentDescription set.
 */
function generateAgentFlagsSection(): string {
	const lines: string[] = [];

	for (const [name, def] of flagEntries(GLOBAL_FLAGS)) {
		if (!def.agentDescription) continue;
		const typeHint = def.type === "string" ? ` <${name}>` : "";
		const flag = `--${name}${typeHint}`;
		const descLines = def.agentDescription.split("\n");
		// First line: flag + first description line
		lines.push(`  ${flag.padEnd(22)}${descLines[0]}`);
		// Continuation lines: indented to align
		for (let i = 1; i < descLines.length; i++) {
			lines.push(`  ${"".padEnd(22)}${descLines[i]}`);
		}
		if (def.agentAppliesTo) {
			lines.push(`  ${"".padEnd(22)}Applies to ${def.agentAppliesTo}.`);
		}
		lines.push("");
	}

	return lines.join("\n").trimEnd();
}

/**
 * Display full help
 */
export function showHelp(): void {
	const logger = getLogger();
	const version = getVersion();
	const pluginCommandsInfo = getPluginCommandsInfo();

	// JSON mode: emit structured command tree for machine consumption
	if (logger.mode === "json") {
		logger.json(buildHelpJson(version, pluginCommandsInfo));
		return;
	}

	let pluginSection = "";
	if (pluginCommandsInfo.length > 0) {
		pluginSection = "\n\nPlugin Commands:";
		for (const cmd of pluginCommandsInfo) {
			const desc = cmd.description ? `  ${cmd.description}` : "";
			pluginSection += `\n  ${cmd.commandName.padEnd(20)}${desc}`;
		}
	}

	let pluginExamples = "";
	for (const cmd of pluginCommandsInfo) {
		for (const ex of cmd.examples ?? []) {
			pluginExamples += `\n  ${ex.command.padEnd(35)}${ex.description}`;
		}
	}

	const commandLines = generateCommandLines();
	const flagsSection = generateFlagsSection();
	const searchFlagsSection = generateSearchFlagsSection();
	const resourceAliases = generateResourceAliases();
	const helpFooter = generateHelpFooter();
	const examplesSection = generateExamplesSection();
	const agentFlagsSection = generateAgentFlagsSection();

	console.log(
		`
c8ctl - Camunda 8 CLI v${version}

Usage: c8ctl <command> [resource] [options]

Commands:
${commandLines}${pluginSection}

Flags:
${flagsSection}

Search Flags:
${searchFlagsSection}

Resource Aliases:
${resourceAliases}

━━━ Agent Flags (for programmatic / AI-agent consumption) ━━━

${agentFlagsSection}

  Note: In JSON output mode (c8ctl output json), help is returned as structured JSON.
        Use 'c8ctl output json && c8ctl help' to get machine-readable command reference.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Examples:
${examplesSection}${pluginExamples}

For detailed help on specific commands with all available flags:
${helpFooter}

Feedback & Issues:
  https://github.com/camunda/c8ctl/issues
  Or run: c8ctl feedback
`.trim(),
	);
}

// ─── Derived verb help ───────────────────────────────────────────────────────

/**
 * Show available resources for a verb. Derived from COMMAND_REGISTRY.
 */
export function showVerbResources(verb: string): void {
	// Resolve verb aliases (e.g. "rm" → "remove", "w" → "watch")
	let resolvedVerb = verb;
	if (!lookupVerb(verb)) {
		for (const [v, d] of registryEntries()) {
			if (d.aliases?.includes(verb)) {
				resolvedVerb = v;
				break;
			}
		}
	}

	const def = lookupVerb(resolvedVerb);
	if (!def) {
		console.log(`\nUnknown command: ${verb}`);
		console.log('Run "c8ctl help" for usage information.');
		return;
	}

	const resources = def.resources;

	// For "help" verb, show all verbs that have detailed help + virtual topics
	if (resolvedVerb === "help") {
		const helpTopics: string[] = [];
		for (const [v, d] of registryEntries()) {
			if (d.hasDetailedHelp) helpTopics.push(v);
		}
		helpTopics.push("profiles", "profile", "plugin", "plugins");
		const placeholder = deriveResourcePlaceholder(resolvedVerb, def);
		console.log(`\nUsage: c8ctl ${resolvedVerb} ${placeholder}\n`);
		console.log(`Available resources:\n  ${helpTopics.join(", ")}`);
		return;
	}

	if (resources.length === 0 && !def.requiresResource) {
		const placeholder = deriveResourcePlaceholder(resolvedVerb, def);
		console.log(`\nUsage: c8ctl ${resolvedVerb} ${placeholder}\n`);
		console.log(`Argument:\n  ${placeholder || "(none)"}`);
		return;
	}

	const displayNames = resources.map((r) => resourceDisplayName(r));
	const placeholder = deriveResourcePlaceholder(resolvedVerb, def);
	console.log(`\nUsage: c8ctl ${resolvedVerb} ${placeholder}\n`);
	console.log(`Available resources:\n  ${displayNames.join(", ")}`);
}

/**
 * Show detailed help for a verb, derived entirely from COMMAND_REGISTRY.
 * Renders: title, usage, aliases, per-resource flags, verb-level flags.
 */
function showGenericVerbHelp(verb: string): void {
	const def = lookupVerb(verb);
	if (!def) {
		console.log(`\nNo detailed help available for: ${verb}`);
		console.log('Run "c8ctl help" for general usage information.');
		return;
	}
	const lines: string[] = [];
	const FLAG_COL = 32;

	// Title
	lines.push(`c8ctl ${verb} - ${def.helpDescription ?? def.description}`);
	lines.push("");

	// Usage
	const resource = deriveResourcePlaceholder(verb, def);
	lines.push(`Usage: c8ctl ${verb} ${resource} [flags]`.trim());

	// Aliases
	if (def.aliases?.length) {
		lines.push("");
		lines.push(`Alias: ${def.aliases.join(", ")}`);
	}

	// Per-resource sections (when resourceFlags exist)
	if (def.resourceFlags && Object.keys(def.resourceFlags).length > 0) {
		lines.push("");
		lines.push("Resources and their available flags:");

		for (const res of def.resources) {
			const canonical = RESOURCE_ALIASES[res] ?? res;
			const displayName = resourceDisplayName(res);

			// Positionals for this resource
			const positionals = def.resourcePositionals?.[canonical];
			const posStr = positionals
				? ` ${positionals.map((p) => (p.required ? `<${p.name}>` : `[${p.name}]`)).join(" ")}`
				: "";

			lines.push("");
			lines.push(`  ${displayName}${posStr}`);

			// Resource-specific flags
			const resFlags = def.resourceFlags[canonical];
			if (resFlags) {
				for (const [name, flagDef] of flagEntries(resFlags)) {
					lines.push(formatFlag(name, flagDef, FLAG_COL));
				}
			}

			// SEARCH_FLAGS for list/search commands
			if (verb === "list" || verb === "search") {
				for (const [name, flagDef] of flagEntries(SEARCH_FLAGS)) {
					lines.push(formatFlag(name, flagDef, FLAG_COL));
				}
			}

			// --profile always applicable
			lines.push(
				formatFlag(
					"profile",
					{ type: "string", description: "Use specific profile" },
					FLAG_COL,
				),
			);
		}
	} else if (def.resources.length > 0) {
		// Simple resource list with positionals (no per-resource flags)
		lines.push("");
		lines.push("Resources:");
		for (const res of def.resources) {
			const canonical = RESOURCE_ALIASES[res] ?? res;
			const displayName = resourceDisplayName(res);
			const positionals = def.resourcePositionals?.[canonical];
			const posStr = positionals
				? ` ${positionals.map((p) => (p.required ? `<${p.name}>` : `[${p.name}]`)).join(" ")}`
				: "";
			lines.push(`  ${displayName}${posStr}`);
		}
	}

	// Verb-level flags (excluding search flags already shown per-resource)
	const verbFlags = Object.entries(def.flags).filter(
		([name]) => !(name in SEARCH_FLAGS),
	);
	if (verbFlags.length > 0) {
		lines.push("");
		lines.push("Flags:");
		for (const [name, flagDef] of verbFlags) {
			lines.push(formatFlag(name, flagDef, FLAG_COL));
		}
		// Add --profile if not already shown via resourceFlags
		if (!def.resourceFlags || Object.keys(def.resourceFlags).length === 0) {
			lines.push(
				formatFlag(
					"profile",
					{ type: "string", description: "Use specific profile" },
					FLAG_COL,
				),
			);
		}
	} else if (
		!def.resourceFlags ||
		Object.keys(def.resourceFlags).length === 0
	) {
		// No verb flags and no resource flags — still show --profile
		lines.push("");
		lines.push("Flags:");
		lines.push(
			formatFlag(
				"profile",
				{ type: "string", description: "Use specific profile" },
				FLAG_COL,
			),
		);
	}

	console.log(`\n${lines.join("\n")}`);
}

/**
 * Show help for a "virtual topic" that spans multiple verbs.
 * Collects all verbs that operate on the given resource.
 */
function showVirtualTopicHelp(topic: string, resource: string): void {
	const lines: string[] = [];
	const FLAG_COL = 32;

	lines.push(
		`c8ctl ${topic} - ${topic.charAt(0).toUpperCase() + topic.slice(1)} management`,
	);
	lines.push("");
	lines.push(`Usage: c8ctl <command> ${resource} [args] [flags]`);
	lines.push("");

	// Find all verbs that operate on this resource
	for (const [verb, def] of registryEntries()) {
		const canonical = RESOURCE_ALIASES[resource] ?? resource;
		if (!def.resources.some((r) => (RESOURCE_ALIASES[r] ?? r) === canonical))
			continue;

		const positionals = def.resourcePositionals?.[canonical];
		const posStr = positionals
			? ` ${positionals.map((p) => (p.required ? `<${p.name}>` : `[${p.name}]`)).join(" ")}`
			: "";

		lines.push(`  ${verb} ${resource}${posStr}`);
		lines.push(`    ${def.description}`);

		// Show flags for this verb (filtered to resource-specific or verb-level)
		const resFlags = def.resourceFlags?.[canonical];
		if (resFlags) {
			for (const [name, flagDef] of flagEntries(resFlags)) {
				lines.push(formatFlag(name, flagDef, FLAG_COL));
			}
		}
		for (const [name, flagDef] of flagEntries(def.flags)) {
			lines.push(formatFlag(name, flagDef, FLAG_COL));
		}
		lines.push("");
	}

	console.log(`\n${lines.join("\n").trimEnd()}`);
}

/**
 * Show detailed help for a specific command.
 * Dispatches to the generic renderer for all verbs.
 */
export async function showCommandHelp(command: string): Promise<void> {
	const logger = getLogger();

	// JSON mode: emit structured help for machine/agent consumption
	if (logger.mode === "json") {
		const version = getVersion();
		const pluginCommandsInfo = getPluginCommandsInfo();
		const allHelp = buildHelpJson(version, pluginCommandsInfo);
		const commandEntry = allHelp.commands.find((c) => c.verb === command);
		logger.json({
			command,
			...(commandEntry ?? {
				verb: command,
				description: `No detailed help available for: ${command}`,
			}),
			globalFlags: allHelp.globalFlags,
			searchFlags: allHelp.searchFlags,
			agentFlags: allHelp.agentFlags,
		});
		return;
	}

	// Virtual help topics that span multiple verbs
	if (command === "profiles" || command === "profile") {
		showVirtualTopicHelp("profiles", "profile");
		return;
	}
	if (command === "plugin" || command === "plugins") {
		showVirtualTopicHelp("plugin", "plugin");
		return;
	}

	// Resolve verb aliases (e.g. "w" → "watch")
	let resolvedVerb = command;
	if (!lookupVerb(command)) {
		for (const [v, d] of registryEntries()) {
			if (d.aliases?.includes(command)) {
				resolvedVerb = v;
				break;
			}
		}
	}

	// If the verb is still not in the registry, check if it's a plugin command.
	// Delegate to the plugin's own handler which renders its own help output.
	if (!lookupVerb(resolvedVerb) && isPluginCommand(resolvedVerb)) {
		// Plugin handlers show help when called with no valid subcommand
		await executePluginCommand(resolvedVerb, []);
		return;
	}

	showGenericVerbHelp(resolvedVerb);
}
