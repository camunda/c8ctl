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
} from "./command-registry.ts";
import { getUserDataDir } from "./config.ts";
import { getLogger } from "./logger.ts";
import {
	getPluginCommandsInfo,
	type PluginCommandInfo,
} from "./plugin-loader.ts";
import { c8ctl } from "./runtime.ts";

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
	/**
	 * True for plugin commands that opted into the #366 passthrough
	 * contract. The completion generators use this to (a) treat the
	 * verb like a fileComplete verb at the resource position and (b)
	 * restrict flag completion to GLOBAL_FLAGS, since c8ctl cannot
	 * know what flags the wrapped external tool accepts.
	 */
	passthrough: boolean;
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
			passthrough: false,
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
			passthrough: cmd.passthrough === true,
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

/**
 * Collect only the GLOBAL_FLAGS, formatted as `--name` literals.
 * Used by passthrough-verb completion branches: c8ctl has no way to
 * know what flags the wrapped external tool accepts, but the global
 * c8ctl flags (e.g. `--profile`, `--json`, `--verbose`) DO still apply
 * because `stripGlobalFlags()` consumes and applies them before
 * forwarding the rest to the plugin handler. So globals are exactly
 * the right suggestion set for `c8ctl <passthrough-verb> --<TAB>`.
 */
function deriveGlobalFlagNames(): string[] {
	return Object.keys(GLOBAL_FLAGS).map((n) => `--${n}`);
}

/** Same as deriveAllFlags() but restricted to GLOBAL_FLAGS only. */
function deriveGlobalFlags(): {
	name: string;
	description: string;
	type: string;
	short?: string;
}[] {
	const out: {
		name: string;
		description: string;
		type: string;
		short?: string;
	}[] = [];
	for (const [name, def] of Object.entries(GLOBAL_FLAGS)) {
		const short = "short" in def ? def.short : undefined;
		out.push({
			name,
			description: def.description,
			type: def.type,
			short,
		});
	}
	return out;
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
	const globalFlags = deriveGlobalFlagNames();
	const helpResources = deriveHelpResources();

	// All verb names (including aliases)
	const allVerbs = new Set<string>();
	for (const v of verbInfos) {
		allVerbs.add(v.verb);
		for (const a of v.aliases) allVerbs.add(a);
	}

	const verbsStr = [...allVerbs].join(" ");
	const flagsStr = allFlags.join(" ");
	const globalFlagsStr = globalFlags.join(" ");

	// Passthrough verbs (#366) get file-completion at the resource
	// position and global-flag-only completion at later positions.
	const passthroughVerbs = verbInfos.filter((v) => v.passthrough);
	const passthroughVerbsStr = passthroughVerbs.map((v) => v.verb).join(" ");

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

		if (v.fileComplete || v.passthrough) {
			// deploy/run/watch and #366 passthrough verbs complete with
			// files. Include aliases in the case pattern so e.g. `c8ctl
			// w <TAB>` (alias for `watch`) gets file completion too.
			const filePattern =
				v.aliases.length > 0 ? `${v.verb}|${v.aliases.join("|")}` : v.verb;
			caseBranches.push(
				`        ${filePattern})\n          COMPREPLY=( $(compgen -f -- "\${cur}") )\n          ;;`,
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

  # All flags (global + per-command)
  local flags="${flagsStr}"

  # GLOBAL_FLAGS only — used after a passthrough verb (#366), where
  # c8ctl cannot know what flags the wrapped external tool accepts.
  local global_flags="${globalFlagsStr}"

  # Passthrough verbs (#366): only c8ctl globals are meaningful flags;
  # everything else is forwarded verbatim to the external tool.
  local passthrough_verbs="${passthroughVerbsStr}"

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
      local verb="\${words[1]}"
      local flag_set="\${flags}"
      # If the current verb is a passthrough plugin command, restrict
      # flag completion to GLOBAL_FLAGS only.
      for pt in \${passthrough_verbs}; do
        if [[ "\${verb}" == "\${pt}" ]]; then
          flag_set="\${global_flags}"
          break
        fi
      done
      if [[ \${cur} == -* ]]; then
        COMPREPLY=( $(compgen -W "\${flag_set}" -- "\${cur}") )
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
	const globalFlagsOnly = deriveGlobalFlags();
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
	const toZshFlagEntry = (f: {
		name: string;
		description: string;
		type: string;
		short?: string;
	}) => {
		const desc = escZsh(f.description);
		if (f.short) {
			return `    '-${f.short}[${desc}]'\n    '--${f.name}[${desc}]${f.type === "string" ? `:${f.name}:` : ""}'`;
		}
		return `    '--${f.name}[${desc}]${f.type === "string" ? `:${f.name}:` : ""}'`;
	};
	const flagEntryLines = allFlags.map(toZshFlagEntry);
	const globalFlagEntryLines = globalFlagsOnly.map(toZshFlagEntry);

	// Passthrough verbs (#366) for the case branch in the default arm.
	const passthroughVerbs = verbInfos.filter((v) => v.passthrough);

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

		if (v.fileComplete || v.passthrough) {
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

	return `#compdef c8ctl c8
# c8ctl-completion-version: ${c8ctl.version}

_c8ctl() {
  local -a verbs resources flags global_flags

  verbs=(
${verbEntries.join("\n")}
  )

  flags=(
${flagEntryLines.join("\n")}
  )

  # GLOBAL_FLAGS only — used after a passthrough verb (#366), where
  # c8ctl cannot know what flags the wrapped external tool accepts.
  global_flags=(
${globalFlagEntryLines.join("\n")}
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
      # Passthrough verbs (#366): only c8ctl globals are meaningful;
      # everything else is forwarded verbatim to the wrapped tool.
      case "\${words[2]}" in
${passthroughVerbs.map((v) => `        ${v.verb}) _arguments \${global_flags[@]}; return ;;`).join("\n") || "        # (no passthrough verbs registered)"}
      esac
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
	const globalFlags = deriveGlobalFlags();
	const helpResources = deriveHelpResources();

	// Passthrough contract (#366): once the user has typed a passthrough
	// verb, only c8ctl GLOBAL_FLAGS are meaningful (everything else is
	// forwarded to the wrapped tool, whose flag surface c8ctl can't
	// know). bash and zsh handle this by switching to a globals-only
	// flag set; fish handles it via a `not __fish_seen_subcommand_from`
	// predicate on every non-global flag so they disappear when a
	// passthrough verb is the current subcommand.
	const passthroughTokens: string[] = [];
	for (const v of verbInfos) {
		if (!v.passthrough) continue;
		passthroughTokens.push(v.verb, ...v.aliases);
	}
	const nonGlobalGuard =
		passthroughTokens.length > 0
			? ` -n 'not __fish_seen_subcommand_from ${passthroughTokens.join(" ")}'`
			: "";
	const globalNames = new Set(globalFlags.map((f) => f.name));

	const lines: string[] = [
		"# c8ctl fish completion",
		"",
		"# Remove all existing completions for c8ctl and c8",
		"complete -c c8ctl -e",
		"complete -c c8 -e",
		"",
	];

	// Global flags — always offered, regardless of which verb is active.
	lines.push("# Global flags (always offered)");
	for (const f of globalFlags) {
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

	// Non-global flags — suppressed under passthrough verbs (#366).
	lines.push(
		passthroughTokens.length > 0
			? `# Non-global flags (suppressed under passthrough verbs: ${passthroughTokens.join(", ")})`
			: "# Non-global flags",
	);
	for (const f of allFlags) {
		if (globalNames.has(f.name)) continue;
		const desc = escFish(f.description);
		const req = f.type === "string" ? " -r" : "";
		if (f.short) {
			lines.push(
				`complete -c c8ctl${nonGlobalGuard} -s ${f.short} -l ${f.name} -d '${desc}'${req}`,
			);
			lines.push(
				`complete -c c8${nonGlobalGuard} -s ${f.short} -l ${f.name} -d '${desc}'${req}`,
			);
		} else {
			lines.push(
				`complete -c c8ctl${nonGlobalGuard} -l ${f.name} -d '${desc}'${req}`,
			);
			lines.push(
				`complete -c c8${nonGlobalGuard} -l ${f.name} -d '${desc}'${req}`,
			);
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

		if (v.fileComplete || v.passthrough) {
			// Both `fileComplete` verbs (deploy/run/watch — they take file
			// paths as their resource argument) and `passthrough` verbs
			// (#366 — c8ctl can't know what the wrapped tool accepts, so
			// offering file paths is the only sensible default) want file
			// completion at the resource position. Emit explicit
			// `complete -F` so fish offers files instead of falling back
			// to the generic verb suggestion list. bash/zsh already handle
			// this in their own branches above.
			const seenFrom = [v.verb, ...v.aliases].join(" ");
			const label = v.passthrough
				? `Files for passthrough verb '${v.verb}' (#366)`
				: `Files for '${v.verb}' command`;
			lines.push(`# ${label}`);
			lines.push(
				`complete -c c8ctl -n '__fish_seen_subcommand_from ${seenFrom}' -F`,
			);
			lines.push(
				`complete -c c8 -n '__fish_seen_subcommand_from ${seenFrom}' -F`,
			);
			lines.push("");
			continue;
		}

		if (v.resources.length === 0) continue;

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
 *
 * Throws on missing/unknown shell; framework wrapper adds the
 * `Failed to completion ...` prefix. Do NOT reintroduce `process.exit` —
 * `tests/unit/no-process-exit-in-handlers.test.ts` enforces this.
 */
export function showCompletion(shell?: string): void {
	if (!shell) {
		throw new Error(
			"Shell type required. Usage: c8 completion <bash|zsh|fish>",
		);
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
			throw new Error(
				`Unknown shell: ${shell}. Supported shells: bash, zsh, fish. Usage: c8 completion <bash|zsh|fish>`,
			);
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
	// Reject control characters (newlines, null, etc.) that could inject
	// additional commands into the shell RC file.
	for (const ch of completionFilePath) {
		const code = ch.charCodeAt(0);
		if (code <= 0x1f || code === 0x7f) {
			throw new Error("Completion file path contains control characters.");
		}
	}
	const escaped = completionFilePath.replaceAll("'", "'\\''");
	return `source '${escaped}'`;
}

/** Generate the comment+source block for the RC file. */
function buildRcBlock(completionFilePath: string): string {
	return `\n# c8ctl shell completion\n${buildSourceLine(completionFilePath)}\n`;
}

/** Check if the RC file already contains the source line.
 *  Checks for both the current single-quoted source line and the legacy
 *  double-quoted form, so upgrades are detected without false-positiving
 *  on the raw path appearing in unrelated lines. */
function rcAlreadyConfigured(
	rcFile: string,
	completionFilePath: string,
): boolean {
	if (!existsSync(rcFile)) return false;
	try {
		const content = readFileSync(rcFile, "utf-8");
		// Check for current single-quoted source line
		if (content.includes(buildSourceLine(completionFilePath))) return true;
		// Check for legacy double-quoted source line
		const escaped = completionFilePath.replaceAll('"', '\\"');
		if (content.includes(`source "${escaped}"`)) return true;
		return false;
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

/** Extract the version from a completion file's header lines.
 *  Scans the first few lines so the header can appear after
 *  shell-required directives like zsh's #compdef. */
export function extractCompletionVersion(filePath: string): string | undefined {
	if (!existsSync(filePath)) return undefined;
	try {
		const content = readFileSync(filePath, "utf-8");
		const lines = content.split("\n").slice(0, 5);
		for (const line of lines) {
			if (line.startsWith(VERSION_HEADER_PREFIX)) {
				return line.slice(VERSION_HEADER_PREFIX.length).trim();
			}
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
		throw new Error(
			"Could not detect shell. Specify with: c8ctl completion install --shell <bash|zsh|fish>",
		);
	}

	if (!["bash", "zsh", "fish"].includes(shell)) {
		throw new Error(
			`Unsupported shell: ${shell}. Supported shells: bash, zsh, fish`,
		);
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
		logger.info(`Target path: ${completionFile}`);
		if (rcFile) {
			logger.info(
				`Add this line manually to your shell config:\n  ${buildSourceLine(completionFile)}`,
			);
		}
		throw new Error(`Failed to install completions: ${msg}`);
	}
}

/**
 * Refresh the installed completion file if the CLI version has changed.
 *
 * Called on every CLI invocation — no-op if completions are not installed
 * or if the embedded version matches the running CLI version.
 * Synchronous write (~1ms for a few KB).
 */
export function refreshCompletionsIfStale(): void {
	// Skip in dry-run mode — refresh is a side effect
	if (c8ctl.dryRun) return;

	// Use the same source of truth as generateForShell() for version headers
	const currentVersion = c8ctl.version;

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
