/**
 * Generates the Command Reference section of README.md from COMMAND_REGISTRY,
 * and optionally a standalone Docusaurus-compatible markdown page.
 *
 * Usage:
 *   node --experimental-strip-types scripts/sync-readme-commands.ts          # update README
 *   node --experimental-strip-types scripts/sync-readme-commands.ts --check  # CI check (exit 1 if stale)
 *   node --experimental-strip-types scripts/sync-readme-commands.ts --docs   # generate docs/command-reference.md
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	CommandDef,
	FlagDef,
	PositionalDef,
} from "../src/command-registry.ts";
import {
	COMMAND_REGISTRY,
	GLOBAL_FLAGS,
	RESOURCE_ALIASES,
	SEARCH_FLAGS,
} from "../src/command-registry.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, "..");
const README_PATH = resolve(ROOT, "README.md");
const DOCS_PATH = resolve(ROOT, "docs", "command-reference.md");

export const START_MARKER = "<!-- command-reference:start -->";
export const END_MARKER = "<!-- command-reference:end -->";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Deduplicate resource aliases: collapse entries where the alias is just the plural form of the canonical. */
export function uniqueAliases(): Array<{ alias: string; canonical: string }> {
	const seen = new Map<string, string[]>();
	for (const [alias, canonical] of Object.entries(RESOURCE_ALIASES)) {
		// Skip plural/singular forms that match the canonical name itself
		if (alias === canonical) continue;
		const list = seen.get(canonical) ?? [];
		list.push(alias);
		seen.set(canonical, list);
	}

	const result: Array<{ alias: string; canonical: string }> = [];
	for (const [canonical, aliases] of seen) {
		// Only include short aliases (not plural forms like "process-instances")
		for (const alias of aliases) {
			if (!alias.includes("-") && alias !== `${canonical}s`) {
				result.push({ alias, canonical });
			}
		}
	}
	return result.sort((a, b) => a.canonical.localeCompare(b.canonical));
}

/** Format a flag name for display: `--name` or `--name` / `-s` */
export function formatFlag(name: string, def: FlagDef): string {
	const long = `\`--${name}\``;
	return def.short ? `${long} / \`-${def.short}\`` : long;
}

/** Render a flags table */
export function renderFlagsTable(flags: Record<string, FlagDef>): string[] {
	const entries = Object.entries(flags);
	if (entries.length === 0) return [];

	const lines: string[] = [];
	lines.push("| Flag | Type | Required | Description |");
	lines.push("|------|------|----------|-------------|");
	for (const [name, def] of entries) {
		const req = def.required ? "Yes" : "";
		lines.push(
			`| ${formatFlag(name, def)} | ${def.type} | ${req} | ${def.description} |`,
		);
	}
	return lines;
}

/** Render positionals for a resource */
export function renderPositionals(
	positionals: readonly PositionalDef[],
): string {
	return positionals
		.map((p) => {
			const req = p.required ? "required" : "optional";
			return `\`<${p.name}>\` (${req})`;
		})
		.join(", ");
}

/** Get the display description for a verb */
function verbDescription(def: CommandDef): string {
	return def.helpDescription ?? def.description;
}

/** Resolve resource short name to canonical, returning the display form */
export function resourceDisplay(resource: string): string {
	// Only show the canonical form when it differs from the requested resource.
	const canonical = RESOURCE_ALIASES[resource];
	return canonical && canonical !== resource
		? `${resource} (${canonical})`
		: resource;
}

// ─── Generation ──────────────────────────────────────────────────────────────

/**
 * Generate the shared command reference body (sections + verb entries).
 * The `headingBase` parameter sets the markdown heading level for top sections:
 *   - headingBase=3 → ### Global Flags, #### verb (README, nested under ## Command Reference)
 *   - headingBase=2 → ## Global Flags, ### verb (standalone docs page, title is h1)
 */
export function generateCommandContent(headingBase: number): string[] {
	const h = (level: number) => "#".repeat(headingBase + level);
	const lines: string[] = [];

	// ── Global Flags ──
	lines.push(`${h(0)} Global Flags`);
	lines.push("");
	lines.push("These flags are accepted by every command.");
	lines.push("");
	lines.push(...renderFlagsTable(GLOBAL_FLAGS));
	lines.push("");

	// ── Resource Aliases ──
	const aliases = uniqueAliases();
	if (aliases.length > 0) {
		lines.push(`${h(0)} Resource Aliases`);
		lines.push("");
		lines.push("| Alias | Resource |");
		lines.push("|-------|----------|");
		for (const { alias, canonical } of aliases) {
			lines.push(`| \`${alias}\` | \`${canonical}\` |`);
		}
		lines.push("");
	}

	// ── Search Flags ──
	const searchFlagEntries = Object.entries(SEARCH_FLAGS);
	if (searchFlagEntries.length > 0) {
		lines.push(`${h(0)} Search Flags`);
		lines.push("");
		lines.push("These flags are available on `list` and `search` commands.");
		lines.push("");
		lines.push(...renderFlagsTable(SEARCH_FLAGS));
		lines.push("");
	}

	// ── Commands ──
	lines.push(`${h(0)} Commands`);
	lines.push("");

	const registry: Record<string, CommandDef> = COMMAND_REGISTRY;

	for (const [verb, def] of Object.entries(registry)) {
		lines.push(`${h(1)} \`${verb}\``);
		lines.push("");
		lines.push(verbDescription(def));
		lines.push("");

		// Usage (from helpResource)
		if (def.helpResource) {
			lines.push(`**Usage:** \`c8ctl ${verb} ${def.helpResource}\``);
			lines.push("");
		}

		// Aliases
		if (def.aliases && def.aliases.length > 0) {
			lines.push(
				`**Aliases:** ${def.aliases.map((a) => `\`${a}\``).join(", ")}`,
			);
			lines.push("");
		}

		// Resources
		if (def.resources.length > 0) {
			const resourceList = def.resources
				.map((r) => resourceDisplay(r))
				.join(", ");
			lines.push(`**Resources:** ${resourceList}`);
			lines.push("");
		}

		// Positionals (per-resource)
		if (def.resourcePositionals) {
			const positionalEntries = Object.entries(def.resourcePositionals);
			if (positionalEntries.length > 0) {
				lines.push("**Positional arguments:**");
				lines.push("");
				for (const [resource, positionals] of positionalEntries) {
					lines.push(`- **${resource}:** ${renderPositionals(positionals)}`);
				}
				lines.push("");
			}
		}

		// Flags — filter out search flags and global flags (shown separately)
		const verbFlags = filterVerbSpecificFlags(def);

		if (def.resourceFlags && Object.keys(def.resourceFlags).length > 0) {
			// Show per-resource flag breakdown
			if (Object.keys(verbFlags).length > 0) {
				lines.push("**Verb-level flags:**");
				lines.push("");
				lines.push(...renderFlagsTable(verbFlags));
				lines.push("");
			}

			lines.push("**Resource-specific flags:**");
			lines.push("");
			for (const [resource, rFlags] of Object.entries(def.resourceFlags)) {
				if (Object.keys(rFlags).length === 0) continue;
				lines.push(`<details>`);
				lines.push(`<summary><code>${resource}</code></summary>`);
				lines.push("");
				lines.push(...renderFlagsTable(rFlags));
				lines.push("");
				lines.push(`</details>`);
				lines.push("");
			}
		} else if (Object.keys(verbFlags).length > 0) {
			lines.push("**Flags:**");
			lines.push("");
			lines.push(...renderFlagsTable(verbFlags));
			lines.push("");
		}

		// Examples
		if (def.helpExamples && def.helpExamples.length > 0) {
			lines.push("**Examples:**");
			lines.push("");
			lines.push("```bash");
			for (const ex of def.helpExamples) {
				const padding = 60 - ex.command.length;
				const pad = padding > 2 ? " ".repeat(padding) : "  ";
				lines.push(`${ex.command}${pad}# ${ex.description}`);
			}
			lines.push("```");
			lines.push("");
		}

		lines.push("---");
		lines.push("");
	}

	// Remove trailing ---
	if (lines[lines.length - 1] === "" && lines[lines.length - 2] === "---") {
		lines.splice(lines.length - 2, 2);
	}

	return lines;
}

/** Generate the README command reference section (nested under ## Command Reference). */
export function generate(): string {
	const lines: string[] = [];

	lines.push("## Command Reference");
	lines.push("");
	lines.push(
		"<!-- Auto-generated from COMMAND_REGISTRY. Do not edit manually.",
	);
	lines.push(
		"     Run: node --experimental-strip-types scripts/sync-readme-commands.ts -->",
	);
	lines.push("");

	lines.push(...generateCommandContent(3));

	return lines.join("\n");
}

export const DOCS_FRONTMATTER = [
	"---",
	"id: command-reference",
	'title: "Command reference"',
	'sidebar_label: "Command reference"',
	'description: "Complete reference of all c8ctl CLI commands, flags, resources, and aliases — auto-generated from the command registry."',
	"---",
].join("\n");

export const DOCS_PREAMBLE = [
	"<!-- Auto-generated from COMMAND_REGISTRY. Do not edit manually.",
	"     Run: node --experimental-strip-types scripts/sync-readme-commands.ts --docs -->",
	"",
	":::warning Alpha feature",
	"`c8ctl` is in alpha and is not intended for production use. Commands and flags may change without notice between releases. See [Getting started](getting-started.md) for details.",
	":::",
].join("\n");

/** Generate a standalone Docusaurus-compatible command reference page. */
export function generateDocs(): string {
	const lines: string[] = [];

	lines.push(DOCS_FRONTMATTER);
	lines.push("");
	lines.push(DOCS_PREAMBLE);
	lines.push("");
	lines.push(...generateCommandContent(2));

	return `${lines.join("\n")}\n`;
}

/**
 * Filter out flags that are already shown in the Global Flags or Search Flags sections.
 * Returns only verb-specific flags.
 */
export function filterVerbSpecificFlags(
	def: CommandDef,
): Record<string, FlagDef> {
	const globalKeys = new Set(Object.keys(GLOBAL_FLAGS));
	const searchKeys = new Set(Object.keys(SEARCH_FLAGS));

	// Collect all resource-specific flag keys
	const resourceFlagKeys = new Set<string>();
	if (def.resourceFlags) {
		for (const rFlags of Object.values(def.resourceFlags)) {
			for (const key of Object.keys(rFlags)) {
				resourceFlagKeys.add(key);
			}
		}
	}

	const result: Record<string, FlagDef> = {};
	for (const [name, flagDef] of Object.entries(def.flags)) {
		// Skip if it's a global flag, search flag, or already shown per-resource
		if (globalKeys.has(name)) continue;
		if (searchKeys.has(name)) continue;
		if (resourceFlagKeys.has(name)) continue;
		result[name] = flagDef;
	}
	return result;
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main(): void {
	const checkMode = process.argv.includes("--check");
	const docsMode = process.argv.includes("--docs");

	if (docsMode) {
		const generated = generateDocs();
		if (checkMode) {
			let existing = "";
			try {
				existing = readFileSync(DOCS_PATH, "utf-8");
			} catch {
				// File doesn't exist yet — always out of sync
			}
			if (generated !== existing) {
				console.error(
					"docs/command-reference.md is out of sync with COMMAND_REGISTRY.",
				);
				console.error(
					"Run: node --experimental-strip-types scripts/sync-readme-commands.ts --docs",
				);
				process.exit(1);
			}
			console.log("docs/command-reference.md is up to date.");
			return;
		}
		writeFileSync(DOCS_PATH, generated, "utf-8");
		console.log("docs/command-reference.md updated.");
		return;
	}

	const readme = readFileSync(README_PATH, "utf-8");

	const startIdx = readme.indexOf(START_MARKER);
	const endIdx = readme.indexOf(END_MARKER);

	if (startIdx === -1 || endIdx === -1) {
		console.error(
			`ERROR: README.md is missing ${START_MARKER} and/or ${END_MARKER} markers.`,
		);
		process.exit(1);
	}

	if (startIdx >= endIdx) {
		console.error(
			`ERROR: ${START_MARKER} must appear before ${END_MARKER} in README.md.`,
		);
		process.exit(1);
	}

	const generated = generate();
	const before = readme.slice(0, startIdx + START_MARKER.length);
	const after = readme.slice(endIdx);
	const updated = `${before}\n\n${generated}\n\n${after}`;

	if (checkMode) {
		if (updated !== readme) {
			console.error(
				"README.md command reference is out of sync with COMMAND_REGISTRY.",
			);
			console.error(
				"Run: node --experimental-strip-types scripts/sync-readme-commands.ts",
			);
			process.exit(1);
		}
		console.log("README.md command reference is up to date.");
		return;
	}

	writeFileSync(README_PATH, updated, "utf-8");
	console.log("README.md command reference updated.");
}

// Only run when executed directly (not when imported by tests)
const isDirectExecution =
	process.argv[1] &&
	(resolve(process.argv[1]) === __filename ||
		resolve(process.argv[1]).replace(/\.ts$/, "") ===
			__filename.replace(/\.ts$/, ""));
if (isDirectExecution) {
	main();
}
