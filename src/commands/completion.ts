/**
 * Shell completion commands — derived from COMMAND_REGISTRY + plugins.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import {
	COMMAND_REGISTRY,
	type CommandDef,
	type FlagDef,
	GLOBAL_FLAGS,
	RESOURCE_ALIASES,
} from "../command-registry.ts";
import { getUserDataDir } from "../config.ts";
import { getLogger } from "../logger.ts";
import {
	getPluginCommandsInfo,
	type PluginCommandInfo,
} from "../plugin-loader.ts";
import { c8ctl } from "../runtime.ts";

// ─── Typed helpers (same pattern as help.ts) ─────────────────────────────────

/** Typed entries for COMMAND_REGISTRY — avoids per-loop casts. */
function registryEntries(): [string, CommandDef][] {
	return Object.entries(COMMAND_REGISTRY);
}

/** Typed entries for a flag record — avoids per-loop casts. */
function flagEntries(flags: Record<string, FlagDef>): [string, FlagDef][] {
	return Object.entries(flags);
}

// ─── Derived completion data ─────────────────────────────────────────────────

/** Reverse map: canonical resource → all names that resolve to it (including itself). */
function buildCanonicalToAliases(): Map<string, string[]> {
	const map = new Map<string, string[]>();

	// Seed with every known canonical name from the registry
	for (const [, def] of registryEntries()) {
		for (const r of def.resources) {
			const canonical = RESOURCE_ALIASES[r] ?? r;
			if (!map.has(canonical)) {
				map.set(canonical, [canonical]);
			}
		}
	}

	// Add every alias
	for (const [alias, canonical] of Object.entries(RESOURCE_ALIASES)) {
		if (!map.has(canonical)) {
			map.set(canonical, [canonical]);
		}
		const arr = map.get(canonical) ?? [];
		if (!arr.includes(alias)) {
			arr.push(alias);
		}
	}

	return map;
}

/** All accepted forms for a verb's resources (canonical + all aliases). */
function resourceFormsForVerb(
	def: CommandDef,
	canonicalToAliases: Map<string, string[]>,
): string[] {
	const seen = new Set<string>();
	for (const r of def.resources) {
		const canonical = RESOURCE_ALIASES[r] ?? r;
		for (const form of canonicalToAliases.get(canonical) ?? [canonical]) {
			seen.add(form);
		}
	}
	return [...seen];
}

interface VerbInfo {
	verb: string;
	description: string;
	resources: string[];
	/** Verb aliases (e.g. "rm" → remove). */
	aliases: string[];
	/** File-path argument instead of resources (deploy/run/watch). */
	fileComplete: boolean;
}

function deriveVerbInfos(pluginCommandsInfo: PluginCommandInfo[]): VerbInfo[] {
	const canonicalToAliases = buildCanonicalToAliases();
	const infos: VerbInfo[] = [];

	for (const [verb, def] of registryEntries()) {
		// Skip mcp-proxy — not a user-facing verb
		if (verb === "mcp-proxy") continue;

		const resources = resourceFormsForVerb(def, canonicalToAliases);
		const fileComplete =
			!def.requiresResource &&
			def.resources.length === 0 &&
			["deploy", "run", "watch"].includes(verb);

		infos.push({
			verb,
			description: def.description,
			resources,
			aliases: def.aliases ?? [],
			fileComplete,
		});
	}

	// Plugin-provided verbs (e.g. cluster)
	for (const cmd of pluginCommandsInfo) {
		// Skip if already in registry
		if (cmd.commandName in COMMAND_REGISTRY) continue;

		infos.push({
			verb: cmd.commandName,
			description: cmd.description ?? "",
			resources: (cmd.subcommands ?? []).map((s) => s.name),
			aliases: [],
			fileComplete: false,
		});
	}

	return infos;
}

/** Collect all unique flag names across all commands + global + search flags. */
function deriveAllFlagNames(): string[] {
	const names = new Set<string>();

	for (const name of Object.keys(GLOBAL_FLAGS)) {
		names.add(name);
	}

	for (const [, def] of registryEntries()) {
		for (const [name] of flagEntries(def.flags)) {
			names.add(name);
		}
		if (def.resourceFlags) {
			for (const rf of Object.values(def.resourceFlags)) {
				for (const name of Object.keys(rf)) {
					names.add(name);
				}
			}
		}
	}

	return [...names].map((n) => `--${n}`);
}

/** Collect all flags with descriptions and types for rich completions (zsh/fish). */
function deriveAllFlags(): {
	name: string;
	description: string;
	type: string;
	short?: string;
}[] {
	const seen = new Map<
		string,
		{ description: string; type: string; short?: string }
	>();

	function addFlags(flags: Record<string, FlagDef>) {
		for (const [name, def] of flagEntries(flags)) {
			if (!seen.has(name)) {
				seen.set(name, {
					description: def.description,
					type: def.type,
					short: def.short,
				});
			}
		}
	}

	addFlags(GLOBAL_FLAGS);

	for (const [, def] of registryEntries()) {
		addFlags(def.flags);
		if (def.resourceFlags) {
			for (const rf of Object.values(def.resourceFlags)) {
				addFlags(rf);
			}
		}
	}

	return [...seen].map(([name, info]) => ({
		name,
		...info,
	}));
}

/** Get resources for the `help` verb: verbs with hasDetailedHelp + special topics. */
function deriveHelpResources(): { name: string; description: string }[] {
	const items: { name: string; description: string }[] = [];

	for (const [verb, def] of registryEntries()) {
		if (def.hasDetailedHelp) {
			items.push({ name: verb, description: `Show ${verb} command help` });
		}
	}

	// Special topics that aren't verbs but have help pages
	items.push(
		{
			name: "profiles",
			description: "Show profile management help",
		},
		{
			name: "profile",
			description: "Alias for profile management help",
		},
		{
			name: "plugin",
			description: "Show plugin management help",
		},
		{
			name: "plugins",
			description: "Alias for plugin management help",
		},
	);

	// Plugin verbs
	const pluginCmds = getPluginCommandsInfo();
	for (const cmd of pluginCmds) {
		if (
			!items.some((i) => i.name === cmd.commandName) &&
			!(cmd.commandName in COMMAND_REGISTRY)
		) {
			items.push({
				name: cmd.commandName,
				description: cmd.description
					? `Show ${cmd.commandName} command help`
					: `No detailed help; use c8ctl help for general usage`,
			});
		}
	}

	return items;
}

// ─── Bash completion ─────────────────────────────────────────────────────────

function generateBashCompletion(): string {
	const pluginCmds = getPluginCommandsInfo();
	const verbInfos = deriveVerbInfos(pluginCmds);
	const allFlags = deriveAllFlagNames();
	const helpResources = deriveHelpResources();

	// All verb names (including aliases)
	const allVerbs = new Set<string>();
	for (const v of verbInfos) {
		allVerbs.add(v.verb);
		for (const a of v.aliases) allVerbs.add(a);
	}

	const verbsStr = [...allVerbs].join(" ");
	const flagsStr = allFlags.join(" ");

	// Build per-verb resource variables
	const resourceVars: string[] = [];
	const caseBranches: string[] = [];

	for (const v of verbInfos) {
		if (v.verb === "help") {
			// Help completes to verbs/topics, not resources
			resourceVars.push(
				`  local help_resources="${helpResources.map((r) => r.name).join(" ")}"`,
			);
			caseBranches.push(
				`        help)\n          COMPREPLY=( $(compgen -W "\${help_resources}" -- "\${cur}") )\n          ;;`,
			);
			continue;
		}

		if (v.fileComplete) {
			// deploy/run/watch complete with files
			caseBranches.push(
				`        ${v.verb})\n          COMPREPLY=( $(compgen -f -- "\${cur}") )\n          ;;`,
			);
			continue;
		}

		if (v.resources.length === 0) continue;

		const varName = `${v.verb.replace(/-/g, "_")}_resources`;
		resourceVars.push(`  local ${varName}="${v.resources.join(" ")}"`);

		// Include aliases in the case pattern
		const casePattern =
			v.aliases.length > 0 ? `${v.verb}|${v.aliases.join("|")}` : v.verb;

		caseBranches.push(
			`        ${casePattern})\n          COMPREPLY=( $(compgen -W "\${${varName}}" -- "\${cur}") )\n          ;;`,
		);
	}

	return `# c8ctl-completion-version: ${c8ctl.version}
# c8ctl bash completion
_c8ctl_completions() {
  local cur prev words cword
  
  # Initialize completion variables (standalone, no bash-completion dependency)
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  words=("\${COMP_WORDS[@]}")
  cword=\${COMP_CWORD}

  # Commands (verbs)
  local verbs="${verbsStr}"
  
  # Resources by verb
${resourceVars.join("\n")}

  # Global flags
  local flags="${flagsStr}"

  case \${cword} in
    1)
      # Complete verbs
      COMPREPLY=( $(compgen -W "\${verbs}" -- "\${cur}") )
      ;;
    2)
      # Complete resources based on verb
      local verb="\${words[1]}"
      case "\${verb}" in
${caseBranches.join("\n")}
      esac
      ;;
    *)
      # Complete flags or files
      if [[ \${cur} == -* ]]; then
        COMPREPLY=( $(compgen -W "\${flags}" -- "\${cur}") )
      else
        COMPREPLY=( $(compgen -f -- "\${cur}") )
      fi
      ;;
  esac
}

complete -F _c8ctl_completions c8ctl
complete -F _c8ctl_completions c8
`;
}

// ─── Zsh completion ──────────────────────────────────────────────────────────

function generateZshCompletion(): string {
	const pluginCmds = getPluginCommandsInfo();
	const verbInfos = deriveVerbInfos(pluginCmds);
	const allFlags = deriveAllFlags();
	const helpResources = deriveHelpResources();

	// Verb entries: 'verb:description'
	const verbEntries = verbInfos.map((v) => {
		const items = [`    '${v.verb}:${escZsh(v.description)}'`];
		for (const a of v.aliases) {
			items.push(`    '${a}:${escZsh(v.description)}'`);
		}
		return items.join("\n");
	});

	// Flag entries: '--flag[description]:hint:' or '--flag[description]'
	const flagEntryLines = allFlags.map((f) => {
		const desc = escZsh(f.description);
		if (f.short) {
			return `    '-${f.short}[${desc}]'\n    '--${f.name}[${desc}]${f.type === "string" ? `:${f.name}:` : ""}'`;
		}
		return `    '--${f.name}[${desc}]${f.type === "string" ? `:${f.name}:` : ""}'`;
	});

	// Per-verb resource case branches
	const resourceCases: string[] = [];
	for (const v of verbInfos) {
		if (v.verb === "help") {
			const entries = helpResources.map(
				(r) => `            '${r.name}:${escZsh(r.description)}'`,
			);
			resourceCases.push(
				`        help)\n          resources=(\n${entries.join("\n")}\n          )\n          _describe 'resource' resources\n          ;;`,
			);
			continue;
		}

		if (v.fileComplete) {
			const casePattern =
				v.aliases.length > 0 ? `${v.verb}|${v.aliases.join("|")}` : v.verb;
			resourceCases.push(
				`        ${casePattern})\n          _files\n          ;;`,
			);
			continue;
		}

		if (v.resources.length === 0) continue;

		const entries = v.resources.map(
			(r) =>
				`            '${r}:${escZsh(capitalize(v.verb))} ${resourceDisplayName(r)}'`,
		);
		const casePattern =
			v.aliases.length > 0 ? `${v.verb}|${v.aliases.join("|")}` : v.verb;
		resourceCases.push(
			`        ${casePattern})\n          resources=(\n${entries.join("\n")}\n          )\n          _describe 'resource' resources\n          ;;`,
		);
	}

	return `# c8ctl-completion-version: ${c8ctl.version}
#compdef c8ctl c8

_c8ctl() {
  local -a verbs resources flags

  verbs=(
${verbEntries.join("\n")}
  )

  flags=(
${flagEntryLines.join("\n")}
  )

  case $CURRENT in
    2)
      _describe 'command' verbs
      ;;
    3)
      case "\${words[2]}" in
${resourceCases.join("\n")}
      esac
      ;;
    *)
      _arguments \${flags[@]}
      ;;
  esac
}

if (( $+functions[compdef] )); then
  compdef _c8ctl c8ctl c8
fi
`;
}

// ─── Fish completion ─────────────────────────────────────────────────────────

function generateFishCompletion(): string {
	const pluginCmds = getPluginCommandsInfo();
	const verbInfos = deriveVerbInfos(pluginCmds);
	const allFlags = deriveAllFlags();
	const helpResources = deriveHelpResources();

	const lines: string[] = [
		"# c8ctl fish completion",
		"",
		"# Remove all existing completions for c8ctl and c8",
		"complete -c c8ctl -e",
		"complete -c c8 -e",
		"",
	];

	// Global flags
	lines.push("# Global flags");
	for (const f of allFlags) {
		const desc = escFish(f.description);
		const req = f.type === "string" ? " -r" : "";
		if (f.short) {
			lines.push(
				`complete -c c8ctl -s ${f.short} -l ${f.name} -d '${desc}'${req}`,
			);
			lines.push(
				`complete -c c8 -s ${f.short} -l ${f.name} -d '${desc}'${req}`,
			);
		} else {
			lines.push(`complete -c c8ctl -l ${f.name} -d '${desc}'${req}`);
			lines.push(`complete -c c8 -l ${f.name} -d '${desc}'${req}`);
		}
	}
	lines.push("");

	// Verb completions
	lines.push("# Commands (verbs) - only suggest when no command is given yet");
	for (const v of verbInfos) {
		const desc = escFish(v.description);
		lines.push(
			`complete -c c8ctl -n '__fish_use_subcommand' -a '${v.verb}' -d '${desc}'`,
		);
		lines.push(
			`complete -c c8 -n '__fish_use_subcommand' -a '${v.verb}' -d '${desc}'`,
		);
		for (const a of v.aliases) {
			lines.push(
				`complete -c c8ctl -n '__fish_use_subcommand' -a '${a}' -d '${desc}'`,
			);
			lines.push(
				`complete -c c8 -n '__fish_use_subcommand' -a '${a}' -d '${desc}'`,
			);
		}
	}
	lines.push("");

	// Per-verb resource completions
	for (const v of verbInfos) {
		if (v.verb === "help") {
			lines.push(`# Resources for 'help' command`);
			for (const r of helpResources) {
				const desc = escFish(r.description);
				lines.push(
					`complete -c c8ctl -n '__fish_seen_subcommand_from help' -a '${r.name}' -d '${desc}'`,
				);
				lines.push(
					`complete -c c8 -n '__fish_seen_subcommand_from help' -a '${r.name}' -d '${desc}'`,
				);
			}
			lines.push("");
			continue;
		}

		if (v.fileComplete || v.resources.length === 0) continue;

		const seenFrom = [v.verb, ...v.aliases].join(" ");
		lines.push(`# Resources for '${v.verb}' command`);
		for (const r of v.resources) {
			const desc = escFish(`${capitalize(v.verb)} ${resourceDisplayName(r)}`);
			lines.push(
				`complete -c c8ctl -n '__fish_seen_subcommand_from ${seenFrom}' -a '${r}' -d '${desc}'`,
			);
			lines.push(
				`complete -c c8 -n '__fish_seen_subcommand_from ${seenFrom}' -a '${r}' -d '${desc}'`,
			);
		}
		lines.push("");
	}

	lines.unshift(`# c8ctl-completion-version: ${c8ctl.version}`);

	return `${lines.join("\n")}\n`;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function capitalize(s: string): string {
	return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Human-readable name from resource alias. */
function resourceDisplayName(resource: string): string {
	const canonical = RESOURCE_ALIASES[resource] ?? resource;
	return canonical.replace(/-/g, " ") + (resource !== canonical ? "s" : "");
}

function escZsh(s: string): string {
	return s.replace(/'/g, "'\\''");
}

function escFish(s: string): string {
	return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Show completion command
 */
export function showCompletion(shell?: string): void {
	const logger = getLogger();

	if (!shell) {
		logger.error("Shell type required. Usage: c8 completion <bash|zsh|fish>");
		process.exit(1);
	}

	const normalizedShell = shell.toLowerCase();

	switch (normalizedShell) {
		case "bash":
			console.log(generateBashCompletion());
			break;
		case "zsh":
			console.log(generateZshCompletion());
			break;
		case "fish":
			console.log(generateFishCompletion());
			break;
		default:
			logger.error(`Unknown shell: ${shell}`);
			logger.info("Supported shells: bash, zsh, fish");
			logger.info("Usage: c8 completion <bash|zsh|fish>");
			process.exit(1);
	}
}

// ─── Completion install ──────────────────────────────────────────────────────

/** Version header prefix used to tag generated completion files. */
const VERSION_HEADER_PREFIX = "# c8ctl-completion-version: ";

/** Completions subdirectory under the user data dir. */
const COMPLETIONS_DIR = "completions";

/** Shell file extensions. */
const SHELL_EXTENSIONS: Record<string, string> = {
	bash: "bash",
	zsh: "zsh",
	fish: "fish",
};

/** Detect the user's shell from $SHELL. Returns lowercase shell name or undefined. */
export function detectShell(): string | undefined {
	const shellPath = process.env.SHELL;
	if (!shellPath) return undefined;
	const base = shellPath.split("/").pop();
	if (!base) return undefined;
	const name = base.toLowerCase();
	if (name === "bash" || name === "zsh" || name === "fish") return name;
	return undefined;
}

/** Get the appropriate RC file path for a given shell. */
export function getShellRcFile(shell: string): string | undefined {
	const home = homedir();
	switch (shell) {
		case "bash":
			// macOS uses .bash_profile by default; Linux uses .bashrc
			return platform() === "darwin"
				? join(home, ".bash_profile")
				: join(home, ".bashrc");
		case "zsh":
			return join(home, ".zshrc");
		case "fish":
			// fish auto-loads from completions dir — no rc edit needed
			return undefined;
		default:
			return undefined;
	}
}

/** Get the path where the completion file will be written. */
export function getCompletionFilePath(shell: string): string {
	const ext = SHELL_EXTENSIONS[shell] ?? shell;
	return join(getUserDataDir(), COMPLETIONS_DIR, `c8ctl.${ext}`);
}

/** Get the fish completions dir (fish auto-loads from here). Respects XDG_CONFIG_HOME. */
function getFishCompletionsDir(): string {
	const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
	return join(configHome, "fish", "completions");
}

/** Generate the source line that goes into the shell RC file.
 *  Uses single quotes to prevent shell expansion of the path. */
function buildSourceLine(completionFilePath: string): string {
	const escaped = completionFilePath.replaceAll("'", "'\\''");
	return `source '${escaped}'`;
}

/** Generate the comment+source block for the RC file. */
function buildRcBlock(completionFilePath: string): string {
	return `\n# c8ctl shell completion\n${buildSourceLine(completionFilePath)}\n`;
}

/** Check if the RC file already contains the source line.
 *  Checks for both the raw completion file path and the escaped source line
 *  so upgrades from double-quoted to single-quoted are detected, and paths
 *  containing single quotes don't cause duplicate blocks. */
function rcAlreadyConfigured(
	rcFile: string,
	completionFilePath: string,
): boolean {
	if (!existsSync(rcFile)) return false;
	try {
		const content = readFileSync(rcFile, "utf-8");
		return (
			content.includes(completionFilePath) ||
			content.includes(buildSourceLine(completionFilePath))
		);
	} catch {
		return false;
	}
}

/** Generate the completion script content for a given shell. */
function generateForShell(shell: string): string {
	switch (shell) {
		case "bash":
			return generateBashCompletion();
		case "zsh":
			return generateZshCompletion();
		case "fish":
			return generateFishCompletion();
		default:
			throw new Error(`Unknown shell: ${shell}`);
	}
}

/** Extract the version from a completion file's first line. */
export function extractCompletionVersion(filePath: string): string | undefined {
	if (!existsSync(filePath)) return undefined;
	try {
		const content = readFileSync(filePath, "utf-8");
		const firstLine = content.split("\n")[0];
		if (firstLine.startsWith(VERSION_HEADER_PREFIX)) {
			return firstLine.slice(VERSION_HEADER_PREFIX.length).trim();
		}
		return undefined;
	} catch {
		return undefined;
	}
}

/**
 * Install shell completions: write script to data dir, wire into RC file.
 *
 * Supports --dry-run via the c8ctl runtime flag.
 */
export function installCompletion(shellOverride?: string): void {
	const logger = getLogger();
	const shell = shellOverride?.toLowerCase() ?? detectShell();

	if (!shell) {
		logger.error(
			"Could not detect shell. Specify with: c8ctl completion install --shell <bash|zsh|fish>",
		);
		process.exit(1);
	}

	if (!["bash", "zsh", "fish"].includes(shell)) {
		logger.error(`Unsupported shell: ${shell}`);
		logger.info("Supported shells: bash, zsh, fish");
		process.exit(1);
	}

	const completionFile = getCompletionFilePath(shell);
	const rcFile = getShellRcFile(shell);
	const rcConfigured = rcFile
		? rcAlreadyConfigured(rcFile, completionFile)
		: true;

	// Dry-run support
	if (c8ctl.dryRun) {
		const result: Record<string, unknown> = {
			dryRun: true,
			detectedShell: shell,
			completionFile,
		};
		if (rcFile) {
			result.rcFile = rcFile;
			result.sourceLine = buildSourceLine(completionFile);
			result.rcAlreadyConfigured = rcConfigured;
		}
		if (shell === "fish") {
			result.fishCompletionsDir = getFishCompletionsDir();
		}
		logger.json(result);
		return;
	}

	// Write the completion file
	try {
		const completionDir = join(getUserDataDir(), COMPLETIONS_DIR);
		mkdirSync(completionDir, { recursive: true });
		const script = generateForShell(shell);
		writeFileSync(completionFile, script, "utf-8");
		logger.info(`Completion script written to ${completionFile}`);

		// Fish: also copy to fish auto-load directory
		if (shell === "fish") {
			const fishDir = getFishCompletionsDir();
			mkdirSync(fishDir, { recursive: true });
			writeFileSync(join(fishDir, "c8ctl.fish"), script, "utf-8");
			logger.info(`Fish completion installed to ${fishDir}/c8ctl.fish`);
			logger.info(
				"Completions will be loaded automatically on next shell start.",
			);
			return;
		}

		// Wire into RC file (bash/zsh)
		if (rcFile) {
			if (rcConfigured) {
				logger.info(`RC file already configured: ${rcFile}`);
			} else {
				const block = buildRcBlock(completionFile);
				writeFileSync(rcFile, block, { encoding: "utf-8", flag: "a" });
				logger.info(`Added source line to ${rcFile}`);
			}
		}

		logger.info("Restart your shell or run:");
		logger.info(`  ${buildSourceLine(completionFile)}`);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		logger.error(`Failed to install completions: ${msg}`);
		logger.info(`Target path: ${completionFile}`);
		if (rcFile) {
			logger.info(
				`Add this line manually to your shell config:\n  ${buildSourceLine(completionFile)}`,
			);
		}
		process.exit(1);
	}
}

/**
 * Refresh the installed completion file if the CLI version has changed.
 *
 * Called on every CLI invocation — no-op if completions are not installed
 * or if the embedded version matches the running CLI version.
 * Synchronous write (~1ms for a few KB).
 */
export function refreshCompletionsIfStale(currentVersion: string): void {
	// Skip in dry-run mode — refresh is a side effect
	if (c8ctl.dryRun) return;

	// Check each shell — user may have installed for multiple shells
	for (const shell of ["bash", "zsh", "fish"]) {
		const filePath = getCompletionFilePath(shell);
		const installed = extractCompletionVersion(filePath);
		if (installed === undefined) {
			// No version header — treat existing file as stale, regenerate
			if (!existsSync(filePath)) continue; // not installed for this shell
		} else if (installed === currentVersion) {
			continue; // up to date
		}

		// Stale — regenerate
		try {
			const script = generateForShell(shell);
			writeFileSync(filePath, script, "utf-8");

			// Fish: also update the auto-load copy
			if (shell === "fish") {
				const fishTarget = join(getFishCompletionsDir(), "c8ctl.fish");
				if (existsSync(fishTarget)) {
					writeFileSync(fishTarget, script, "utf-8");
				}
			}
		} catch {
			// Best-effort — don't crash if the write fails
		}
	}
}
