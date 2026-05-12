/**
 * c8ctl-plugin-element-template
 *
 * Apply Camunda element templates to BPMN elements and inspect template properties.
 *
 * Usage:
 *   c8ctl element-template apply <template> <element-id> [<file.bpmn>] [--in-place] [--set key=value]
 *   c8ctl element-template info <template>
 *   c8ctl element-template get-properties <template> [<name>...] [--group <id>] [--detailed]
 *   c8ctl element-template get <template>
 *   c8ctl element-template search <query>
 *   c8ctl element-template sync [--prune]
 *
 * <template> can be a local path, an https:// URL, or an OOTB template id
 * (optionally pinned, e.g. io.camunda.connectors.HttpJson.v2@13).
 * GitHub blob URLs are auto-rewritten to raw.githubusercontent.com.
 */

import type {
	PluginCommands,
	PluginMetadata,
} from "../../src/plugin-loader.ts";
import type {} from "../../src/runtime.ts";
import { applySubcommand } from "./apply.ts";
import { getSubcommand } from "./get.ts";
import { getPropertiesSubcommand } from "./get-properties.ts";
import { infoSubcommand } from "./info.ts";
import { searchSubcommand } from "./search.ts";
import { syncSubcommand } from "./sync.ts";

const c8ctl = globalThis.c8ctl!;

/**
 * Reinject flags pre-parsed by the host (#366/#367) back into the args
 * array as `--name value` / `--name` tokens, so the plugin's hand-rolled
 * `parseArgs` still sees them. Repeated string flags arrive as arrays.
 */
function injectFlagsIntoArgs(
	args: readonly string[],
	flags: Record<string, unknown> | undefined,
): string[] {
	const out = [...args];
	if (!flags) {
		return out;
	}
	for (const [name, value] of Object.entries(flags)) {
		if (value === undefined || value === null) {
			continue;
		}
		if (typeof value === "boolean") {
			if (value) {
				out.push(`--${name}`);
			}
		} else if (Array.isArray(value)) {
			for (const item of value) {
				if (item !== undefined && item !== null) {
					out.push(`--${name}`, String(item));
				}
			}
		} else {
			out.push(`--${name}`, String(value));
		}
	}
	return out;
}

/**
 * Subcommand union derived from the metadata literal type. Keeping this
 * tied to `metadata` rather than restating the names means adding a
 * subcommand to the metadata `subcommands` array surfaces as a missing-key
 * error in `subcommandHandlers` below.
 */
type Subcommand =
	(typeof metadata.commands)["element-template"]["subcommands"][number]["name"];

/**
 * Exhaustive dispatch table. The `Record<Subcommand, ...>` constraint
 * makes adding a metadata subcommand without a matching handler a type
 * error.
 */
const subcommandHandlers: Record<
	Subcommand,
	(args: string[]) => Promise<void>
> = {
	search: searchSubcommand,
	info: infoSubcommand,
	"get-properties": getPropertiesSubcommand,
	apply: applySubcommand,
	get: getSubcommand,
	sync: syncSubcommand,
};

function isSubcommand(name: string): name is Subcommand {
	return Object.hasOwn(subcommandHandlers, name);
}

async function elementTemplateHandler(
	args: string[] | undefined,
	flags?: Record<string, unknown>,
): Promise<void> {
	const reinjected = injectFlagsIntoArgs(args ?? [], flags);
	const subcommand = reinjected[0];
	const subArgs = reinjected.slice(1);

	if (!subcommand || !isSubcommand(subcommand)) {
		const logger = c8ctl.getLogger();
		const lead = subcommand
			? `Unknown subcommand '${subcommand}'.`
			: "c8ctl element-template requires a subcommand.";
		const validSubcommands = Object.keys(subcommandHandlers);
		logger.info(`${lead} Available: ${validSubcommands.join(", ")}`);
		logger.info("Run 'c8ctl element-template --help' for full usage.");
		process.exitCode = 1;
		return;
	}

	try {
		await subcommandHandlers[subcommand](subArgs);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const logger = c8ctl.getLogger();
		logger.error(`Failed to element-template ${subcommand}: ${message}`);
		process.exitCode = 1;
	}
}

// ---------------------------------------------------------------------------
// Plugin API
// ---------------------------------------------------------------------------

export const metadata = {
	name: "element-template",
	description: "Apply, inspect, and export Camunda element templates",
	commands: {
		"element-template": {
			description: "Apply, inspect, and export Camunda element templates",
			helpDescription:
				"Apply Camunda element templates to BPMN elements, inspect template metadata and properties, " +
				"search the out-of-the-box template catalogue, export raw template JSON, " +
				"and manage the local template cache.\n\n" +
				"<template> is a local path, an https:// URL, or an OOTB template id (optionally @<version>).",
			subcommands: [
				{
					name: "search",
					description: "Search out-of-the-box element templates",
				},
				{
					name: "info",
					description: "Show template metadata and a compact property table",
				},
				{
					name: "get-properties",
					description:
						"Show detail cards for one or more properties (or all if none given)",
				},
				{
					name: "apply",
					description: "Apply a Camunda element template to a BPMN element",
				},
				{
					name: "get",
					description: "Print the raw template JSON to stdout (pipe-friendly)",
				},
				{
					name: "sync",
					description: "Refresh the local OOTB element template cache",
				},
			],
			examples: [
				{
					command: 'c8ctl element-template search "AWS S3"',
					description: "Search OOTB templates by name",
				},
				{
					command: 'c8ctl element-template search "AWS" --limit 5',
					description: "Cap the number of results (default 20)",
				},
				{
					command:
						"c8ctl element-template info io.camunda.connectors.HttpJson.v2",
					description:
						"Show the template metadata card (id, version, applies-to, engines, docs)",
				},
				{
					command:
						"c8ctl element-template get-properties io.camunda.connectors.HttpJson.v2",
					description:
						"List every settable property as a condensed name + description row",
				},
				{
					command:
						"c8ctl element-template get-properties io.camunda.connectors.HttpJson.v2 --detailed 'authentication.*'",
					description:
						"Drill into specific properties as full detail cards (quote globs to avoid shell expansion)",
				},
				{
					command:
						"c8ctl element-template get-properties io.camunda.connectors.HttpJson.v2 --group authentication --group endpoint",
					description:
						"Filter to one or more group ids (use the id, not the label — `info` shows the available group ids)",
				},
				{
					command:
						"c8ctl element-template apply io.camunda.connectors.HttpJson.v2 Task_1 process.bpmn",
					description:
						"Apply an OOTB template (latest compatible with the BPMN engine version)",
				},
				{
					command:
						"c8ctl element-template apply io.camunda.connectors.HttpJson.v2@13 Task_1 process.bpmn",
					description: "Apply a specific OOTB template version",
				},
				{
					command:
						"c8ctl element-template apply template.json Task_1 process.bpmn",
					description: "Apply a template from a local file or URL",
				},
				{
					command:
						"c8ctl element-template get io.camunda.connectors.HttpJson.v2 > template.json",
					description:
						"Print the raw template JSON to stdout (redirect to save a copy)",
				},
				{
					command:
						"c8ctl element-template get io.camunda.connectors.HttpJson.v2 --no-icon",
					description:
						"Drop the icon field (large base64 blob) for pipe-friendly output",
				},
				{
					command: "c8ctl element-template sync",
					description: "Refresh the local OOTB element template cache",
				},
			],
		},
	},
} as const satisfies PluginMetadata;

export const commands = {
	"element-template": {
		flags: {
			"in-place": {
				type: "boolean",
				short: "i",
				description: "Modify the BPMN file in place [apply]",
			},
			set: {
				type: "string",
				multiple: true,
				description: "Set a template property value (repeatable) [apply]",
			},
			detailed: {
				type: "boolean",
				short: "d",
				description:
					"Render full detail cards instead of the condensed list [get-properties]",
			},
			group: {
				type: "string",
				multiple: true,
				description:
					"Filter to one or more group ids (repeatable) [get-properties]",
			},
			prune: {
				type: "boolean",
				description: "Drop cached entries no longer in the index [sync]",
			},
			"no-icon": {
				type: "boolean",
				description:
					"Drop the icon field (often a large base64 blob) from the output [get]",
			},
			limit: {
				type: "string",
				description: "Cap the number of matches (default 20) [search]",
			},
		},
		handler: elementTemplateHandler,
	},
} satisfies PluginCommands;
