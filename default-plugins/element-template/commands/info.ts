/**
 * `c8ctl element-template info` — show a keyed card of template-level
 * metadata.
 *
 * Also hosts the shared inspect-arg parser (used by `info` and
 * `get-properties`), the template-header renderer (used by `info` and
 * `search`), and the generic keyed-card layout used by both header and
 * property-detail cards.
 */

import { styleText } from "node:util";
import type {} from "../../../src/runtime.ts";
import { parseEngineVersionFlag, type Template } from "../helpers.ts";
import { loadTemplate } from "../template-ref.ts";

if (!globalThis.c8ctl) throw new Error("c8ctl runtime not initialised");
const c8ctl = globalThis.c8ctl;

export type InspectArgs = {
	templateArg: string;
	propertyArgs: string[];
	groups: string[];
	detailed: boolean;
};

/**
 * Parse the shared inspect args: `<template> [<name>...] [--group <id>...]`.
 * `--group` is repeatable. Comma-separated values are NOT split — pass
 * `--group a --group b` for multiple ids.
 */
export function parseInspectArgs(
	args: string[],
	usage: string,
	{
		allowPropertyNames,
		allowFilters,
	}: { allowPropertyNames: boolean; allowFilters: boolean },
): InspectArgs {
	let templateArg: string | undefined;
	const propertyArgs: string[] = [];
	const groups: string[] = [];
	let detailed = false;
	let afterDoubleDash = false;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (!afterDoubleDash && arg === "--") {
			afterDoubleDash = true;
			continue;
		}
		if (!afterDoubleDash && (arg === "--group" || arg.startsWith("--group="))) {
			if (!allowFilters) {
				throw new Error(`Unknown flag: --group. ${usage}`);
			}
			const value =
				arg === "--group" ? args[++i] : arg.slice("--group=".length);
			if (value === undefined || value === "") {
				throw new Error(`--group requires a value (group id). ${usage}`);
			}
			groups.push(value);
			continue;
		}
		if (!afterDoubleDash && (arg === "--detailed" || arg === "-d")) {
			if (!allowFilters) {
				throw new Error(`Unknown flag: ${arg}. ${usage}`);
			}
			detailed = true;
			continue;
		}
		if (!afterDoubleDash && arg.startsWith("-")) {
			throw new Error(`Unknown flag: ${arg}. ${usage}`);
		}
		if (templateArg === undefined) {
			templateArg = arg;
			continue;
		}
		if (!allowPropertyNames) {
			throw new Error(`Unexpected argument: ${arg}. ${usage}`);
		}
		propertyArgs.push(arg);
	}

	if (!templateArg) {
		throw new Error(`Missing template argument. ${usage}`);
	}
	return { templateArg, propertyArgs, groups, detailed };
}

/**
 * Project a template into the JSON summary shape — only the fields
 * the text output surfaces (name/id/version, description, applies-to,
 * engines, docs link), but using the element-templates JSON schema's
 * own field names. No invented derivations; no full-template dump.
 */
export function buildTemplateSummary(
	template: Template,
): Record<string, unknown> {
	return {
		name: template.name,
		id: template.id,
		version: template.version,
		description: template.description,
		documentationRef: template.documentationRef,
		appliesTo: template.appliesTo,
		elementType: template.elementType,
		engines: template.engines,
	};
}

/**
 * Render template-level metadata as a keyed card.
 */
export function formatTemplateHeaderLines(
	template: Template,
	fallbackName: string | undefined,
	{ autoResolvedVersion = false }: { autoResolvedVersion?: boolean } = {},
): string[] {
	const fields: [string, string][] = [];
	if (template.id) {
		fields.push(["ID", template.id]);
	}
	if (template.version !== undefined) {
		const versionCell = autoResolvedVersion
			? `${template.version}  ${styleText("dim", "(latest; @<n> to pin)")}`
			: String(template.version);
		fields.push(["Version", versionCell]);
	}
	const appliesValue = formatAppliesToValue(template);
	if (appliesValue) {
		fields.push(["Applies to", appliesValue]);
	}
	if (template.engines?.camunda) {
		fields.push(["Engines", template.engines.camunda]);
	}
	if (template.description) {
		fields.push(["Description", template.description]);
	}
	if (template.documentationRef) {
		fields.push(["Docs", styleText("dim", template.documentationRef)]);
	}

	return formatKeyedCard({
		title: template.name ?? fallbackName ?? "Template",
		fields,
	});
}

/**
 * Resolve `appliesTo` and `elementType.value` into a single value cell.
 */
export function formatAppliesToValue(template: Template): string | null {
	const applies = Array.isArray(template.appliesTo)
		? template.appliesTo.filter((v): v is string => Boolean(v))
		: [];
	const elementType = template.elementType?.value;
	if (applies.length === 0 && !elementType) {
		return null;
	}

	const left =
		applies.length === 0
			? null
			: applies.length === 1
				? applies[0]
				: applies.length === 2
					? applies.join(" or ")
					: `${applies.slice(0, -1).join(", ")}, or ${applies[applies.length - 1]}`;

	if (left && elementType && !applies.includes(elementType)) {
		return `${left} → ${elementType}`;
	}
	if (left) {
		return left;
	}
	return elementType ?? null;
}

/**
 * Generic keyed-card renderer used by both the template header and the
 * property detail card.
 */
export function formatKeyedCard({
	title,
	subtitle,
	fields,
}: {
	title: string;
	subtitle?: string;
	fields: [string, string][];
}): string[] {
	const lines: string[] = [];
	const titleParts = [styleText("bold", title)];
	if (subtitle) {
		titleParts.push(styleText("dim", subtitle));
	}
	lines.push(titleParts.join(" "));

	if (fields.length === 0) {
		return lines;
	}

	const keyWidth = Math.max(0, ...fields.map(([k]) => k.length));
	for (const [key, value] of fields) {
		const paddedKey = key.padEnd(keyWidth);
		const styledKey = key ? styleText("dim", paddedKey) : paddedKey;
		lines.push(`  ${styledKey}  ${value}`);
	}
	return lines;
}

export async function infoSubcommand(args: string[]): Promise<void> {
	const logger = c8ctl.getLogger();
	const usage =
		"Usage: c8ctl element-template info <template> [--engine-version <x.y.z>]";
	const { engineVersion, rest } = parseEngineVersionFlag(args, usage);

	const parsed = parseInspectArgs(rest, usage, {
		allowPropertyNames: false,
		allowFilters: false,
	});

	const { template, autoResolvedVersion, engineVersionIgnoredByPinnedVersion } =
		await loadTemplate(parsed.templateArg, {
			executionPlatformVersion: engineVersion,
		});
	if (engineVersionIgnoredByPinnedVersion && engineVersion) {
		logger.warn(
			`Ignoring --engine-version ${engineVersion} because ${parsed.templateArg} pins a template version.`,
		);
	}

	if (c8ctl.outputMode === "json") {
		logger.json(buildTemplateSummary(template));
		return;
	}

	// Template metadata card. The version row carries a dim parenthetical
	// when the version was auto-resolved from an OOTB id.
	for (const line of formatTemplateHeaderLines(template, parsed.templateArg, {
		autoResolvedVersion,
	})) {
		logger.output(line);
	}
	logger.output("");

	// Trailing hint — point at get-properties for the property listing.
	logger.output(
		styleText(
			"dim",
			"For settable properties, run:\n" +
				`  c8ctl element-template get-properties ${parsed.templateArg}`,
		),
	);
}
