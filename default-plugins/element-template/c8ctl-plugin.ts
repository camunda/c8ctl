/**
 * c8ctl-plugin-element-template
 *
 * Apply Camunda element templates to BPMN elements and inspect template properties.
 *
 * Usage:
 *   c8ctl element-template apply <template> <element-id> [<file.bpmn>] [--in-place] [--set key=value]
 *   c8ctl element-template edit <element-id> [<file.bpmn>] [--in-place] --set key=value
 *   c8ctl element-template update <element-id> [<file.bpmn>] [--to-version <n>] [--recipe <file>] [--in-place]
 *   c8ctl element-template change <template> <element-id> [<file.bpmn>] [--recipe <file>] [--in-place]
 *   c8ctl element-template change --successor <element-id> [<file.bpmn>] [--recipe <file>] [--in-place]
 *   c8ctl element-template info <template> [--engine-version <x.y.z>]
 *   c8ctl element-template get-properties <template> [<name>...] [--group <id>] [--detailed] [--engine-version <x.y.z>]
 *   c8ctl element-template get <template>
 *   c8ctl element-template search <query> [--engine-version <x.y.z>]
 *   c8ctl element-template sync [--prune]
 *
 * <template> can be a local path, an https:// URL, or an OOTB template id
 * (optionally pinned, e.g. io.camunda.connectors.HttpJson.v2@13).
 * GitHub blob URLs are auto-rewritten to raw.githubusercontent.com.
 */

import type {} from "../../src/core/runtime.ts";
import type {
	PluginCommands,
	PluginMetadata,
} from "../../src/framework/plugins/plugin-loader.ts";
import { applySubcommand } from "./commands/apply.ts";
import { changeSubcommand } from "./commands/change.ts";
import { editSubcommand } from "./commands/edit.ts";
import { getSubcommand } from "./commands/get.ts";
import { getPropertiesSubcommand } from "./commands/get-properties.ts";
import { infoSubcommand } from "./commands/info.ts";
import { searchSubcommand } from "./commands/search.ts";
import { syncSubcommand } from "./commands/sync.ts";
import { updateSubcommand } from "./commands/update.ts";

if (!globalThis.c8ctl) throw new Error("c8ctl runtime not initialised");
const c8ctl = globalThis.c8ctl;

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
	edit: editSubcommand,
	update: updateSubcommand,
	change: changeSubcommand,
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
				"<template> is a local path, an https:// URL, or an OOTB template id (optionally @<version>).\n\n" +
				"apply --set name=value targets a property by binding name (run `get-properties` to discover names). " +
				"Pass --set multiple times to set multiple properties. " +
				"Prefix with a binding type (input | output | header | property | taskDefinition) when the same name " +
				"is bound across multiple types — e.g. --set input:correlationKey=order-42.\n\n" +
				"edit --set name=value updates a property on an element that already has a template applied, " +
				"without re-running template application — it never resets other template-owned content " +
				"(including hand-customized extension values a template doesn't fully control) and doesn't need " +
				"a <template> argument (it reads zeebe:modelerTemplate/-Version off the element). " +
				"The tradeoff: edit can only change bindings that already have a value; a property whose " +
				"gating condition was never met has nothing to edit — use apply --set to materialize it first.\n\n" +
				"update moves an element to a newer version of its template, and change moves it to another template " +
				"(--successor picks the one that declares a migration from the applied template). Values the new template " +
				"binds under another key are moved when the target template carries a migration recipe " +
				"(metadata.migratesFrom) or one is passed with --recipe <file>; the rest carry over by key. " +
				"A report lists what was dropped, added, moved and changed. Use --dry-run to preview without writing.\n\n" +
				"FEEL values: properties with feel=required always store a FEEL expression (prefixed with `=`). " +
				"For those properties, c8ctl auto-prepends `=` when it is missing, so `--set key=orderId` " +
				"writes `=orderId` to the BPMN — equivalent to `--set key==orderId`. " +
				"Properties with feel=optional keep the value verbatim; you must supply the `=` prefix yourself " +
				"when you want to write a FEEL expression for those. " +
				"Three forms for feel=required properties:\n" +
				"  --set key='=value'    canonical: single-quoted FEEL value (explicit =)\n" +
				"  --set 'key==value'    compact: whole argument single-quoted (explicit =)\n" +
				"  --set key=value       shorthand: = auto-prepended (feel=required only)\n" +
				"Leading/trailing whitespace is stripped from values, and whitespace immediately after a " +
				"FEEL `=` prefix is also stripped, so `--set 'key== value'` " +
				"is equivalent to `--set 'key==value'`.",
			subcommands: [
				{
					name: "search",
					description: "Search out-of-the-box element templates",
				},
				{
					name: "info",
					description:
						"Show template metadata (id, version, applies-to, description) and a pointer to get-properties",
				},
				{
					name: "get-properties",
					description:
						"List settable properties (use --detailed for full detail cards)",
				},
				{
					name: "apply",
					description: "Apply a Camunda element template to a BPMN element",
				},
				{
					name: "edit",
					description:
						"Update a property on an element that already has a template applied, without re-applying it",
				},
				{
					name: "update",
					description:
						"Move an element to a newer version of its template, migrating its values",
				},
				{
					name: "change",
					description:
						"Move an element to another template, migrating its values",
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
						"c8ctl element-template info io.camunda.connectors.HttpJson.v2 --engine-version 8.8.0",
					description:
						"Resolve the latest template version compatible with a specific Camunda engine version",
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
						"Filter to one or more group ids (use the id, not the label — group ids appear as headings in `get-properties` output)",
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
						"c8ctl element-template apply io.camunda.connectors.HttpJson.v2 Task_1 process.bpmn --set method=POST --set url=https://api.example.com",
					description:
						"Set property values via --set name=value (one per --set; discover names via get-properties)",
				},
				{
					command:
						"c8ctl element-template apply io.camunda.connectors.HttpJson.v2 Task_1 process.bpmn --set authentication.type=basic --set authentication.username=alice",
					description:
						"Conditional properties: child controls (e.g. authentication.username) apply only when the gating property is also set",
				},
				{
					command:
						"c8ctl element-template apply io.camunda.connectors.HttpJson.v2 Task_1 process.bpmn --set input:method=POST",
					description:
						"Qualify with <binding-type>:name=value when the same name is bound across multiple types",
				},
				{
					command:
						"c8ctl element-template edit Task_1 process.bpmn --set method=PUT",
					description:
						"Update a single property on an already-templated element in place, without touching anything else the template governs",
				},
				{
					command:
						"c8ctl element-template update Task_1 process.bpmn --dry-run",
					description:
						"Preview moving an element to the latest compatible version of its template, with a report of what changes",
				},
				{
					command:
						"c8ctl element-template change --successor Agent_1 process.bpmn --in-place",
					description:
						"Move an element from a deprecated template to the template that supersedes it",
				},
				{
					command:
						"c8ctl element-template change new-template.json Task_1 process.bpmn --recipe recipe.json",
					description:
						"Migrate with a recipe from a file instead of the one embedded in the template",
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
			"allow-lossy": {
				type: "boolean",
				description:
					"Authorize lossy in-place migration or embedded-recipe fallback [update|change]",
			},
			"in-place": {
				type: "boolean",
				short: "i",
				description: "Modify the BPMN file in place [apply|edit|update|change]",
			},
			set: {
				type: "string",
				multiple: true,
				description:
					"Set a property value: name=value (repeatable; binding name from get-properties; = auto-prepended for feel=required properties) [apply|edit]",
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
			successor: {
				type: "boolean",
				description:
					"Move to the template that declares a migration from the applied one [change]",
			},
			recipe: {
				type: "string",
				description:
					"Migration recipe file, used instead of the one embedded in the target template [update|change]",
			},
			"to-version": {
				type: "string",
				description:
					"Move to this template version instead of the latest compatible one [update]",
			},
			prune: {
				type: "boolean",
				description:
					"Drop cached entries no longer in a selected release [sync]",
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
			"engine-version": {
				type: "string",
				description:
					"Filter to template versions compatible with the given Camunda engine version (e.g. 8.8.0) [search|info|get-properties]",
			},
		},
		handler: elementTemplateHandler,
	},
} satisfies PluginCommands;
