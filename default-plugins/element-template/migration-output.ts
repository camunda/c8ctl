/**
 * Presentation of a migration report for the CLI: coloured text with emoji
 * markers for people, a plain data shape for `--json`.
 */

import { isRecord } from "../../src/core/index.ts";
import { bindingTargetKey, sameTarget } from "./migration/binding.ts";
import type { ElementValue } from "./migration/element-values.ts";
import type {
	Field,
	MigrationReport,
	ValueSource,
} from "./migration/report.ts";
import type { MigrationTemplate } from "./migration/types.ts";

/** Uses existing property/group identity metadata, not a custom sensitivity flag. */
export interface MigrationRedactionContext {
	templates?: readonly MigrationTemplate[];
	/** Before/after values also cover credentials absent from the report diff. */
	values?: readonly ElementValue[];
	report?: MigrationReport;
}

export interface RenderOptions {
	elementId: string;
	elementName?: string;
	color: boolean;
	recipe: RecipeOrigin;
	/** The `--recipe` argument, as given; shown when `recipe` is `file`. */
	recipePath?: string;
	/** Orders rows like the Modeler properties panel. */
	targetTemplate?: MigrationTemplate;
	/** Set when the element is lossy: whether `--allow-lossy` was passed. */
	authorization?: "required" | "authorized";
	/** Stream width when it is a TTY. */
	columns?: number;
	redaction?: MigrationRedactionContext;
}

type Style = (text: string) => string;

type MigrationRedactor = ReturnType<typeof migrationRedactor>;

function migrationRedactor(context: MigrationRedactionContext) {
	const sensitiveName = (identity: string) => {
		// Token limits such as maxCompletionTokens or budgetTokens are no credentials.
		const name = identity.replace(
			/(?:max(?:imum)?|budget)[ ._-]?(?:[a-z]+[ ._-]?)?tokens/gi,
			"",
		);
		return /password|passwd|secret|token|credential|api[._ -]?key|private[._ -]?key|authorization/i.test(
			name,
		);
	};
	const sensitive = (field: Field) =>
		sensitiveName(
			`${field.key} ${field.label ?? ""} ${field.group ?? ""} ${field.groupLabel ?? ""}`,
		) ||
		(context.templates ?? []).some((template) =>
			template.properties.some(
				(property) =>
					sameTarget(
						{
							key: bindingTargetKey(property.binding),
							bindingType: property.binding?.type,
						},
						field,
					) &&
					(("secret" in property && property.secret === true) ||
						sensitiveName(
							`${property.id ?? ""} ${property.label ?? ""} ${property.group ?? ""} ${template.groups?.find((group) => group.id === property.group)?.label ?? ""}`,
						)),
			),
		);
	const secrets = new Set<string>();
	const remember = (...values: (string | undefined)[]) => {
		for (const value of values) {
			if (value) {
				secrets.add(value);
				secrets.add(JSON.stringify(value).slice(1, -1));
			}
		}
	};
	for (const value of context.values ?? []) {
		if (sensitive(value)) remember(value.value);
	}
	for (const template of context.templates ?? []) {
		for (const property of template.properties) {
			const key = bindingTargetKey(property.binding);
			if (
				key !== undefined &&
				sensitive({ key, bindingType: property.binding?.type ?? null }) &&
				typeof property.value === "string"
			)
				remember(property.value);
		}
	}
	if (context.report) {
		for (const item of [...context.report.dropped, ...context.report.added]) {
			if (sensitive(item)) remember(item.value, item.valueName);
		}
		for (const item of context.report.changed) {
			if (sensitive(item))
				remember(
					item.valueChange.from,
					item.valueChange.to,
					item.valueChange.fromName,
					item.valueChange.toName,
				);
		}
		for (const item of context.report.moved) {
			if (sensitive(item.from) || sensitive(item.to))
				remember(
					item.value,
					item.valueName,
					item.valueChange?.from,
					item.valueChange?.to,
					item.valueChange?.fromName,
					item.valueChange?.toName,
				);
		}
	}
	// A single replacement avoids partial matches and rescanning redaction markers.
	const pattern = [...secrets]
		.sort((a, b) => b.length - a.length)
		.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		.join("|");
	const matcher = pattern ? new RegExp(pattern, "g") : undefined;
	const text = (message: string) =>
		matcher ? message.replace(matcher, "[REDACTED]") : message;
	return { sensitive, text };
}

/** Custom fields with no credential-like identity cannot be inferred as sensitive. */
export function redactMigrationDiagnostic(
	message: string,
	context: MigrationRedactionContext = {},
): string {
	return migrationRedactor(context).text(message);
}

function redactReport(
	report: MigrationReport,
	redactor: MigrationRedactor,
): MigrationReport {
	const { sensitive, text } = redactor;
	const change = { from: "[REDACTED]", to: "[REDACTED]" };
	const redacted = structuredClone(report);
	const scrub = (value: unknown): void => {
		if (Array.isArray(value) || isRecord(value)) {
			for (const [key, child] of Object.entries(value)) {
				if (typeof child === "string") {
					if (Array.isArray(value)) value[Number(key)] = text(child);
					else value[key] = text(child);
				} else scrub(child);
			}
		}
	};
	scrub(redacted);
	return {
		...redacted,
		dropped: redacted.dropped.map((item, index) =>
			sensitive(report.dropped[index])
				? { ...item, value: "[REDACTED]", valueName: undefined }
				: item,
		),
		added: redacted.added.map((item, index) =>
			sensitive(report.added[index])
				? { ...item, value: "[REDACTED]", valueName: undefined }
				: item,
		),
		changed: redacted.changed.map((item, index) =>
			sensitive(report.changed[index])
				? { ...item, valueChange: change }
				: item,
		),
		moved: redacted.moved.map((item, index) =>
			sensitive(report.moved[index].from) || sensitive(report.moved[index].to)
				? {
						...item,
						value: "[REDACTED]",
						valueName: undefined,
						...(item.valueChange ? { valueChange: change } : {}),
					}
				: item,
		),
	};
}

function styles(color: boolean) {
	const wrap =
		(open: number, close: number): Style =>
		(text) =>
			color ? `\u001b[${open}m${text}\u001b[${close}m` : text;
	return {
		bold: wrap(1, 22),
		dim: wrap(2, 22),
		red: wrap(31, 39),
		green: wrap(32, 39),
		yellow: wrap(33, 39),
		blue: wrap(34, 39),
		cyan: wrap(36, 39),
	};
}

/** `name vN`, with `(deprecated)` once, in lower case. */
function templateName(ref: MigrationReport["from"]): string {
	const name = (ref.name ?? ref.id).replace(/\s*\(deprecated\)/i, "");
	return `${name}${ref.deprecated ? " (deprecated)" : ""} v${ref.version}`;
}

function valueText(value: string, name: string | undefined): string {
	return name && name !== value ? name : value;
}

/** Whether colour should be used on `stream`, honouring NO_COLOR and FORCE_COLOR. */
export function shouldUseColor(stream: { isTTY?: boolean }): boolean {
	if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") {
		return false;
	}
	if (
		process.env.FORCE_COLOR !== undefined &&
		process.env.FORCE_COLOR !== "0"
	) {
		return true;
	}
	return stream.isTTY === true;
}

const MAX_LABEL_WIDTH = 28;
const MAX_VALUE_WIDTH = 40;
const NARROW_COLUMNS = 100;

type Marker = "+" | "~" | ">" | "-";
type Segment = [text: string, paint?: Style];

interface Row {
	marker: Marker;
	group: string | undefined;
	groupLabel: string | undefined;
	label: string;
	/** Group and label as the reader sees them, for collision checks. */
	identity: string;
	/** Binding key shown when two rows share an identity. */
	key: string;
	value: Segment[];
	source: string;
	/** Key rename of a `>` row without a source. */
	rename?: { from: string; to: string };
	rank: [number, number];
}

function truncate(text: string): string {
	return text.length > MAX_VALUE_WIDTH
		? `${text.slice(0, MAX_VALUE_WIDTH - 1)}…`
		: text;
}

function plain(segments: Segment[]): string {
	return segments.map(([text]) => text).join("");
}

function pad(text: string, width: number): string {
	return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function fieldLabel(field: Field): string {
	return field.label ?? field.key;
}

function groupName(field: Field): string | undefined {
	return field.groupLabel ?? field.group;
}

function sourceText(source: ValueSource): string {
	switch (source) {
		case "recipe":
			return "set by recipe";
		case "map":
			return "--map";
		case "default":
			return "template default";
		case "fixed":
			return "fixed by template";
	}
}

/** Where a moved field came from: its label, or its group and label. */
function wasText(from: Field, to: Field): string {
	const label = fieldLabel(from);
	if (groupName(from) !== groupName(to)) {
		const group = groupName(from);
		return `was ${group ? `${group} › ` : ""}${label}`;
	}
	return label !== fieldLabel(to) ? `was ${label}` : "";
}

/** Position of `field` in the property panel of `template`. */
function rankOf(
	template: MigrationTemplate | undefined,
	field: Field,
): [number, number] {
	const groups = template?.groups ?? [];
	const properties = template?.properties ?? [];
	const property = properties.findIndex(
		(p) =>
			(field.propertyId !== undefined && p.id === field.propertyId) ||
			sameTarget(
				{ key: bindingTargetKey(p.binding), bindingType: p.binding?.type },
				field,
			),
	);
	const declared = groups.findIndex((g) => g.id === field.group);
	// Groups the template does not declare follow its order of first use.
	const group =
		field.group === undefined
			? groups.length + properties.length + 1
			: declared !== -1
				? declared
				: groups.length +
					Math.max(
						0,
						properties.findIndex((p) => p.group === field.group),
					);
	return [group, property === -1 ? properties.length : property];
}

/** `from.* → to.* (n)` for renames that share prefixes, one per rename otherwise. */
function renameLines(renames: { from: string; to: string }[]): string[] {
	const dir = (key: string) => key.slice(0, key.lastIndexOf(".") + 1);
	const base = (key: string) => key.slice(key.lastIndexOf(".") + 1);
	const buckets = new Map<string, { from: string; to: string }[]>();
	for (const rename of renames) {
		const same = base(rename.from) === base(rename.to);
		const bucket = same ? `${dir(rename.from)}\u0000${dir(rename.to)}` : "";
		const list = buckets.get(bucket || `\u0001${rename.from}`) ?? [];
		list.push(rename);
		buckets.set(bucket || `\u0001${rename.from}`, list);
	}
	const lines: string[] = [];
	for (const [bucket, list] of buckets) {
		if (list.length > 1 && !bucket.startsWith("\u0001")) {
			const [from, to] = bucket.split("\u0000");
			lines.push(`${from}* → ${to}* (${list.length})`);
		} else {
			for (const r of list) lines.push(`${r.from} → ${r.to}`);
		}
	}
	return lines;
}

function rowsOf(
	report: MigrationReport,
	targetTemplate: MigrationTemplate | undefined,
	s: ReturnType<typeof styles>,
): { rows: Row[]; dropped: Row[] } {
	const shown = (value: string, name: string | undefined, stored: boolean) => {
		const text = valueText(value, name);
		return truncate(stored && text !== value ? `${text} [${value}]` : text);
	};
	const base = (field: Field) => ({
		group: field.group,
		groupLabel: groupName(field),
		label: fieldLabel(field),
		identity: `${groupName(field) ?? ""}\u0000${fieldLabel(field)}`,
		key: field.key,
		rank: rankOf(targetTemplate, field),
	});
	const change = (c: {
		from: string;
		to: string;
		fromName?: string;
		toName?: string;
	}): Segment[] => [
		[shown(c.from, c.fromName, false), s.red],
		[" → ", s.dim],
		[shown(c.to, c.toName, true), s.green],
	];

	const rows: Row[] = [];
	for (const a of report.added) {
		rows.push({
			...base(a),
			marker: "+",
			value: [[shown(a.value, a.valueName, true), s.green]],
			source: sourceText(a.source),
		});
	}
	for (const c of report.changed) {
		rows.push({
			...base(c),
			marker: "~",
			value: change(c.valueChange),
			source: sourceText(c.source),
		});
	}
	for (const m of report.moved) {
		const common = base(m.to);
		if (m.valueChange) {
			rows.push({
				...common,
				marker: "~",
				value: change(m.valueChange),
				source: sourceText(m.source),
			});
			continue;
		}
		const was = wasText(m.from, m.to);
		rows.push({
			...common,
			marker: ">",
			value: [[shown(m.value, m.valueName, false)]],
			source: was,
			...(!was && m.from.key !== m.to.key
				? { rename: { from: m.from.key, to: m.to.key } }
				: {}),
		});
	}
	rows.sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1]);

	const dropped: Row[] = report.dropped.map((d) => {
		const group = groupName(d);
		return {
			...base(d),
			marker: "-",
			label: `${group ? `${group} › ` : ""}${fieldLabel(d)}`,
			value: [[shown(d.value, d.valueName, false), s.red]],
			source: "",
		};
	});
	return { rows, dropped };
}

export function renderReportText(
	report: MigrationReport,
	{
		elementId,
		elementName,
		color,
		recipe,
		recipePath,
		targetTemplate,
		authorization,
		columns,
		redaction,
	}: RenderOptions,
): string {
	const redactor = migrationRedactor({ ...redaction, report });
	elementId = redactor.text(elementId);
	elementName = elementName ? redactor.text(elementName) : undefined;
	report = redactReport(report, redactor);
	const s = styles(color);
	const lines: string[] = [];

	lines.push(
		s.bold(elementName ? `${elementName} (${elementId})` : elementId),
		`  ${s.dim(templateName(report.from))}  ${s.dim("→")}  ${s.bold(templateName(report.to))}`,
		s.dim(
			`  ${report.from.id}@${report.from.version} → ${report.to.id}@${report.to.version}`,
		),
	);
	if (report.refusal) {
		lines.push(s.yellow(`  recipe not used: ${redactor.text(report.refusal)}`));
	} else if (recipe === "file") {
		lines.push(
			s.dim(`  recipe: ${recipePath ? redactor.text(recipePath) : "file"}`),
		);
	} else if (recipe === "embedded") {
		lines.push(s.dim(`  recipe: embedded in ${report.to.id}`));
	} else {
		lines.push(s.dim("  no recipe: values carried over by key"));
	}

	const { rows, dropped } = rowsOf(report, targetTemplate, s);
	const all = [...rows, ...dropped];
	const labelWidth = Math.min(
		MAX_LABEL_WIDTH,
		Math.max(0, ...all.map((r) => r.label.length)),
	);
	const valueWidth = Math.max(0, ...all.map((r) => plain(r.value).length));
	const narrow = columns !== undefined && columns < NARROW_COLUMNS;
	const valueColumn = 2 + 2 + labelWidth + 2;

	const colorOf = (marker: Marker): Style =>
		marker === "+"
			? s.green
			: marker === "-"
				? s.red
				: marker === "~"
					? s.yellow
					: s.cyan;
	const collides = new Set<string>();
	const seen = new Map<string, string>();
	for (const r of all) {
		const first = seen.get(r.identity);
		if (first === undefined) seen.set(r.identity, r.key);
		else if (first !== r.key) collides.add(r.identity);
	}

	const emit = (r: Row) => {
		const paint =
			r.marker === "+" || r.marker === "-" ? colorOf(r.marker) : undefined;
		const label = pad(r.label, labelWidth);
		const value = r.value
			.map(([text, style]) => (style ? style(text) : text))
			.join("");
		const gap = " ".repeat(Math.max(0, valueWidth - plain(r.value).length));
		const markerText = s.bold(colorOf(r.marker)(r.marker));
		const labelText = paint ? paint(label) : label;
		if (r.source && !narrow) {
			lines.push(
				`  ${markerText} ${labelText}  ${value}${gap}  ${s.dim(r.source)}`,
			);
		} else {
			lines.push(`  ${markerText} ${labelText}  ${value}`.trimEnd());
			if (r.source) lines.push(`${" ".repeat(valueColumn)}${s.dim(r.source)}`);
		}
		if (collides.has(r.identity)) {
			lines.push(`${" ".repeat(valueColumn)}${s.dim(r.key)}`);
		}
	};

	let current: string | undefined | null = null;
	let groupRenames: { from: string; to: string }[] = [];
	const flushRenames = () => {
		const out = renameLines(groupRenames);
		out.forEach((text, i) => {
			const lead =
				i === 0 ? "keys renamed: " : " ".repeat("keys renamed: ".length);
			lines.push(s.dim(`    ${lead}${text}`));
		});
		groupRenames = [];
	};
	for (const r of rows) {
		if (current !== r.group) {
			if (current !== null) flushRenames();
			current = r.group;
			lines.push("", `  ${s.bold(r.groupLabel ?? "(no group)")}`);
		}
		emit(r);
		if (r.rename) groupRenames.push(r.rename);
	}
	if (current !== null) flushRenames();

	if (dropped.length > 0) {
		lines.push("", `  ${s.bold("Dropped")}`);
		for (const r of dropped) emit(r);
	}

	if (report.notes.length > 0) {
		lines.push("", `  ${s.bold("Notes")}`);
		for (const note of report.notes) {
			lines.push(
				note.level === "warning"
					? s.yellow(`  ⚠️  ${note.message}`)
					: s.blue(`  ℹ️  ${note.message}`),
			);
		}
	}

	const { guard, template, noMatch, feel } = report.skipped;
	if (guard.length + template.length + noMatch.length + feel.length > 0) {
		lines.push("", `  ${s.bold("Needs attention")}`);
		for (const g of guard) {
			lines.push(`  Condition not met, not moved: ${g.from} → ${g.to}`);
		}
		for (const t of template) {
			lines.push(`  Not composed, missing ${t.missing.join(", ")}: ${t.to}`);
		}
		for (const n of noMatch) {
			lines.push(
				`  No value rule matched, target default kept: ${n.from} → ${n.to}`,
			);
		}
		for (const f of feel) {
			lines.push(
				`  FEEL expression moved as-is, value rules not applied: ${f.from} → ${f.to}`,
			);
		}
	}

	const updated =
		report.added.length + report.changed.length + report.moved.length;
	const lost =
		report.dropped.length + guard.length + template.length + noMatch.length;
	const tail =
		authorization === "required"
			? ". Requires --allow-lossy before writing."
			: authorization === "authorized"
				? ". Authorized with --allow-lossy."
				: "";
	const counts = `${updated} updated, ${report.kept.length} kept unchanged, ${lost} lost${tail}`;
	lines.push(
		"",
		report.lossless ? s.green(`  ✅ ${counts}`) : s.yellow(`  ⚠️  ${counts}`),
	);
	return `${lines.join("\n")}\n`;
}

/** The marker legend, printed once at the end of a run. */
export function renderLegend(color: boolean): string {
	const s = styles(color);
	return [
		s.green("+ new"),
		s.yellow("~ changed"),
		s.cyan("> moved"),
		s.red("- dropped"),
	].join("  ");
}

export type RecipeOrigin = "file" | "embedded" | "none";

/** The report as plain data for `--json`. */
export function reportToJson(
	report: MigrationReport,
	{
		elementId,
		elementName,
		recipe,
		recipePath,
		dryRun,
		file,
		redaction,
	}: {
		elementId: string;
		elementName?: string;
		recipe: RecipeOrigin;
		/** The `--recipe` argument, as given; reported when `recipe` is `file`. */
		recipePath?: string;
		dryRun: boolean;
		file?: string;
		redaction?: MigrationRedactionContext;
	},
) {
	const redactor = migrationRedactor({ ...redaction, report });
	const { text } = redactor;
	report = redactReport(report, redactor);
	return {
		elementId: text(elementId),
		...(elementName ? { elementName: text(elementName) } : {}),
		dryRun,
		...(file ? { file: text(file) } : {}),
		from: report.from,
		to: report.to,
		recipe: {
			source: recipe,
			...(recipe === "file" && recipePath ? { path: text(recipePath) } : {}),
			used: report.usedRecipe,
			refusal: report.refusal,
		},
		lossless: report.lossless,
		counts: {
			moved: report.moved.length,
			added: report.added.length,
			changed: report.changed.length,
			dropped: report.dropped.length,
			kept: report.kept.length,
		},
		report: {
			moved: report.moved,
			added: report.added,
			changed: report.changed,
			dropped: report.dropped,
			kept: report.kept,
			notes: report.notes,
			skipped: report.skipped,
		},
	};
}
