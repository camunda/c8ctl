/**
 * `c8ctl element-template get-properties` — list settable properties of a
 * template. Default render is a condensed table of name + description
 * rows grouped by section. `--detailed` swaps in per-property detail cards.
 */

import { styleText } from "node:util";
import type {} from "../../../src/runtime.ts";
import {
	BINDING_TYPE_SHORTHANDS,
	globToRegex,
	type Logger,
	type PropertyDetail,
	type Template,
	type TemplateProperty,
} from "../helpers.ts";
import { loadTemplate } from "../template-ref.ts";
import { formatKeyedCard, parseInspectArgs } from "./info.ts";

if (!globalThis.c8ctl) throw new Error("c8ctl runtime not initialised");
const c8ctl = globalThis.c8ctl;

export async function getPropertiesSubcommand(args: string[]): Promise<void> {
	const logger = c8ctl.getLogger();
	const usage =
		"Usage: c8ctl element-template get-properties <template> [<name>...] [--group <id>...] [--detailed | -d]\n" +
		"  Default: condensed list (name + description). --detailed shows full cards.\n" +
		"  Names may include shell-style globs — quote to avoid shell expansion: 'auth*'";

	const parsed = parseInspectArgs(args, usage, {
		allowPropertyNames: true,
		allowFilters: true,
	});

	const {
		template,
		allDetails,
		groupLabelMap,
		sourceByDetail,
		autoResolvedVersion,
	} = await loadTemplate(parsed.templateArg);

	if (autoResolvedVersion) {
		logger.warn(
			`Resolved latest version (${template.version}) of ${template.id}. ` +
				`Use '${template.id}@${template.version}' to pin.`,
		);
	}

	// Resolve positional names if any (literals or globs). Each arg must
	// match at least one property — typos shouldn't silently produce no
	// output. With no positionals, default to all properties.
	let details =
		parsed.propertyArgs.length > 0
			? parsed.propertyArgs.flatMap((arg) =>
					filterByPropertyArg(allDetails, arg, parsed.templateArg),
				)
			: allDetails;

	// --group intersects with positional matches.
	details = applyGroupFilter(details, parsed.groups, groupLabelMap);

	// Dedupe by object reference — the same property detail object is
	// returned when it matches multiple positionals (e.g. `url` and
	// `u*` together). NOT by binding name+type: distinct properties
	// sometimes share those (operation-conditional duplicates that
	// bind to the same field with different `condition` clauses).
	const seen = new Set<PropertyDetail>();
	details = details.filter((d) => {
		if (seen.has(d)) {
			return false;
		}
		seen.add(d);
		return true;
	});

	// Each filter is individually validated (positional names via
	// filterByPropertyArg, group ids via applyGroupFilter), but their
	// intersection can still be empty when a property exists somewhere
	// and a group exists, just not together. Surface that as an error
	// to match the README contract that filters error on no-match.
	if (
		details.length === 0 &&
		(parsed.propertyArgs.length > 0 || parsed.groups.length > 0)
	) {
		const nameClause =
			parsed.propertyArgs.length > 0
				? `name${parsed.propertyArgs.length > 1 ? "s" : ""} ${parsed.propertyArgs.map((a) => `"${a}"`).join(", ")}`
				: "";
		const groupClause =
			parsed.groups.length > 0
				? `group${parsed.groups.length > 1 ? "s" : ""} ${parsed.groups.map((g) => `"${g}"`).join(", ")}`
				: "";
		const what = [nameClause, groupClause].filter(Boolean).join(" and ");
		throw new Error(`No properties match ${what}.`);
	}

	const total = allDetails.length;

	if (c8ctl.outputMode === "json") {
		const projector = parsed.detailed
			? buildShowProperty
			: buildCondensedProperty;
		logger.json(
			buildJsonPayload(template, details, projector, total, sourceByDetail),
		);
		return;
	}

	// Summary line at the top — gives an at-a-glance answer to "how
	// many am I seeing, out of how many available". Especially useful
	// after a filter to confirm scope.
	logger.output(
		styleText("dim", `Showing ${details.length} of ${total} properties.`),
	);
	logger.output("");

	if (parsed.detailed) {
		// Detail-card view — full per-property fields.
		for (let i = 0; i < details.length; i++) {
			for (const line of formatPropertyCard(details[i])) {
				logger.output(line);
			}
			if (i < details.length - 1) {
				logger.output("");
			}
		}
		return;
	}

	// Default: condensed list — group heading + name + description.
	renderCondensedTable(details, groupLabelMap, logger);

	// Trailing hint — point users at name filtering and --detailed.
	logger.output("");
	logger.output(
		styleText(
			"dim",
			"Filter by name (supports globs):\n" +
				`  c8ctl element-template get-properties ${parsed.templateArg} 'auth*' url\n` +
				"For full details on each property:\n" +
				`  c8ctl element-template get-properties ${parsed.templateArg} --detailed`,
		),
	);
}

/**
 * Project a property into the JSON shape that mirrors the **condensed
 * get-properties text output** — just identification (binding) and the
 * descriptive text the row surfaces. Group is included so consumers
 * can resolve the section heading via the top-level `groups` table.
 */
function buildCondensedProperty(
	prop: TemplateProperty,
): Record<string, unknown> {
	return {
		id: prop.id,
		binding: prop.binding,
		label: prop.label,
		description: prop.description,
		group: prop.group,
		choices: prop.choices,
	};
}

/**
 * Project a property into the JSON shape that mirrors the
 * **--detailed get-properties card** — every field the card surfaces.
 * Schema field names verbatim.
 */
function buildShowProperty(prop: TemplateProperty): Record<string, unknown> {
	return {
		id: prop.id,
		binding: prop.binding,
		type: prop.type,
		optional: prop.optional,
		value: prop.value,
		feel: prop.feel,
		group: prop.group,
		condition: prop.condition,
		label: prop.label,
		description: prop.description,
		constraints: prop.constraints,
		choices: prop.choices,
	};
}

/**
 * JSON payload for `get-properties`. `projectProp` decides which
 * per-property shape to use (condensed vs detailed) so JSON mirrors
 * text density per mode.
 */
function buildJsonPayload(
	template: Template,
	details: PropertyDetail[],
	projectProp: (prop: TemplateProperty) => Record<string, unknown>,
	totalCount: number,
	sourceByDetail: WeakMap<PropertyDetail, TemplateProperty>,
): Record<string, unknown> {
	const properties = details
		.map((d) => sourceByDetail.get(d))
		.filter((p): p is TemplateProperty => Boolean(p))
		.map(projectProp);

	return {
		count: properties.length,
		total: totalCount,
		groups: template.groups ?? [],
		properties,
	};
}

/**
 * Filter details to those whose `groupId` is in the requested list.
 * Empty list means no filter. Unknown group ids throw with the list of
 * valid ids — group ids are short and bounded so we always show them.
 */
function applyGroupFilter(
	details: PropertyDetail[],
	groups: string[],
	groupLabelMap: Map<string, string>,
): PropertyDetail[] {
	if (groups.length === 0) {
		return details;
	}
	// Valid group IDs: the template's declared groups table PLUS any group id
	// referenced directly on property details (templates that use property.group
	// without a matching groups entry still render a heading — so the filter
	// must accept those ids too).
	const validFromTemplate = new Set(groupLabelMap.keys());
	const validFromDetails = new Set(
		details
			.map((d) => d.groupId)
			.filter((id): id is string => id !== undefined),
	);
	const valid = new Set([...validFromTemplate, ...validFromDetails]);
	for (const g of groups) {
		if (!valid.has(g)) {
			const known = [...valid].join(", ") || "(none defined on this template)";
			throw new Error(
				`Unknown group id "${g}". Use the template's group id (not its label).\n` +
					`Available group ids: ${known}`,
			);
		}
	}
	const set = new Set(groups);
	return details.filter((d) => d.groupId !== undefined && set.has(d.groupId));
}

/**
 * Render the condensed one-line-per-property listing grouped by
 * section.
 */
function renderCondensedTable(
	details: PropertyDetail[],
	groupLabelMap: Map<string, string>,
	logger: Logger,
): void {
	const grouped = new Map<string, PropertyDetail[]>();
	const ungrouped: PropertyDetail[] = [];
	for (const detail of details) {
		if (detail.groupId) {
			const list = grouped.get(detail.groupId) ?? [];
			list.push(detail);
			grouped.set(detail.groupId, list);
		} else {
			ungrouped.push(detail);
		}
	}

	// Global name-column width so the description column anchors at the
	// same x-position across all groups.
	const nameWidth = Math.max(0, ...details.map((d) => (d.name ?? "?").length));

	type GroupEntry = { groupId: string | null; group: PropertyDetail[] };
	const groupEntries: GroupEntry[] = [...grouped.entries()].map(
		([groupId, group]) => ({ groupId, group }),
	);
	if (ungrouped.length > 0) {
		groupEntries.push({ groupId: null, group: ungrouped });
	}

	for (let i = 0; i < groupEntries.length; i++) {
		const { groupId, group } = groupEntries[i];
		const label = groupId ? (groupLabelMap.get(groupId) ?? groupId) : "Other";
		// Show "Label (id)" so the --group filter token is self-documenting.
		// Skip the parenthetical when label and id are identical.
		const heading =
			groupId && label !== groupId
				? `${styleText("bold", label)} ${styleText("dim", `(${groupId})`)}`
				: styleText("bold", label);
		logger.output(heading);
		for (const detail of group) {
			logger.output(formatCondensedRow(detail, { nameWidth }));
		}
		if (i < groupEntries.length - 1) {
			logger.output("");
		}
	}
}

/**
 * Build one condensed row: indent · padded name · description-or-label.
 */
function formatCondensedRow(
	detail: PropertyDetail,
	{ nameWidth }: { nameWidth: number },
): string {
	const NAME_INDENT = "  ";
	const COLUMN_GAP = "  ";
	const CONT_INDENT = " ".repeat(NAME_INDENT.length + 4);
	const name = (detail.name ?? "?").padEnd(nameWidth);
	const text = detail.description ?? detail.label ?? "";
	const trailing = text ? `${COLUMN_GAP}${styleText("dim", text)}` : "";
	const lines = [`${NAME_INDENT}${styleText("bold", name)}${trailing}`];

	// Surface `id` only when it adds information — i.e. it exists and
	// differs from the binding name. For most properties (id == name or
	// id missing) this stays a single-line row.
	if (detail.id && detail.id !== detail.name) {
		lines.push(styleText("dim", `${CONT_INDENT}[id: ${detail.id}]`));
	}

	if (detail.choices?.length) {
		const values = detail.choices.map((c) => c.value).join(", ");
		lines.push(styleText("dim", `${CONT_INDENT}[choices: ${values}]`));
	}

	return lines.join("\n");
}

/**
 * Detail card for a single property — keyed two-column layout.
 */
function formatPropertyCard(detail: PropertyDetail): string[] {
	const fields: [string, string][] = [];
	if (detail.id) {
		fields.push(["Id", detail.id]);
	}
	fields.push(["Type", detail.type ?? "String"]);
	fields.push(["Required", detail.required ? "yes" : "no"]);
	if (detail.feel) {
		fields.push(["FEEL", detail.feel]);
	}
	if (detail.default !== undefined && detail.default !== "") {
		fields.push(["Default", formatBadgeValue(detail.default)]);
	}
	if (detail.bindingType) {
		fields.push(["Binding", detail.bindingType]);
	}

	if (detail.label || detail.description) {
		const text = [detail.label, detail.description].filter(Boolean).join(" — ");
		fields.push(["Description", text]);
	}
	if (detail.conditionText) {
		fields.push(["Active when", detail.conditionText]);
	} else if (detail.condition) {
		fields.push(["Conditional", "(see template definition)"]);
	}
	if (detail.pattern) {
		fields.push(["Pattern", detail.pattern.value]);
		if (detail.pattern.message) {
			fields.push(["", detail.pattern.message]);
		}
	}
	if (detail.choices?.length) {
		fields.push(["Choices", detail.choices.map((c) => c.value).join(", ")]);
	}

	return formatKeyedCard({
		title: detail.name ?? "?",
		subtitle: detail.group ? `(${detail.group})` : undefined,
		fields,
	});
}

/**
 * Filter properties by a `<name>` or `<binding-type>:<name>` argument.
 */
function filterByPropertyArg(
	details: PropertyDetail[],
	propertyArg: string,
	templateArg: string | undefined,
): PropertyDetail[] {
	const colon = propertyArg.indexOf(":");
	let nameFilter = propertyArg;
	let typeFilter: string | undefined;
	if (colon !== -1) {
		const prefix = propertyArg.slice(0, colon);
		typeFilter = BINDING_TYPE_SHORTHANDS[prefix];
		if (!typeFilter) {
			const valid = Object.keys(BINDING_TYPE_SHORTHANDS).join(", ");
			throw new Error(
				`Unknown binding type prefix "${prefix}". Valid prefixes: ${valid}`,
			);
		}
		nameFilter = propertyArg.slice(colon + 1);
	}

	const isGlob = nameFilter.includes("*");
	const matcher = isGlob ? globToRegex(nameFilter) : null;

	const matches = details.filter((d) => {
		if (typeFilter && d.bindingType !== typeFilter) {
			return false;
		}
		if (!d.name) {
			return false;
		}
		return matcher ? matcher.test(d.name) : d.name === nameFilter;
	});
	if (matches.length === 0) {
		const hint = templateArg
			? `\nRun 'c8ctl element-template get-properties ${templateArg}' to list all available properties.`
			: "";
		throw new Error(`Property "${propertyArg}" not found.${hint}`);
	}
	return matches;
}

function formatBadgeValue(value: unknown): string {
	if (typeof value === "string") {
		// Multi-line defaults (FEEL expression bodies, JSON snippets) would
		// otherwise wrap and break the badge layout — collapse to a single
		// line and truncate.
		const oneLine = value.replace(/\s+/g, " ").trim();
		return oneLine.length > 60 ? `${oneLine.slice(0, 57)}...` : oneLine;
	}
	return JSON.stringify(value);
}
