/**
 * Presentation of a migration report for the CLI: coloured text with emoji
 * markers for people, a plain data shape for `--json`.
 */

import { isRecord } from "../../src/core/index.ts";
import { bindingTargetKey } from "./migration/binding.ts";
import type { ElementValue } from "./migration/element-values.ts";
import type { Field, MigrationReport } from "./migration/report.ts";
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
	color: boolean;
	dryRun: boolean;
	redaction?: MigrationRedactionContext;
}

type Style = (text: string) => string;

function migrationRedactor(context: MigrationRedactionContext) {
	const sensitiveName = (identity: string) => {
		const name = identity.replace(/max(?:imum)?[ ._-]?tokens/gi, "");
		return /password|passwd|secret|token|credential|api[._ -]?key|private[._ -]?key|authorization/i.test(
			name,
		);
	};
	const sensitive = (field: Field) =>
		sensitiveName(`${field.key} ${field.label ?? ""} ${field.group ?? ""}`) ||
		(context.templates ?? []).some((template) =>
			template.properties.some(
				(property) =>
					bindingTargetKey(property.binding) === field.key &&
					(field.bindingType === null ||
						property.binding?.type === field.bindingType) &&
					sensitiveName(
						`${property.id ?? ""} ${property.label ?? ""} ${property.group ?? ""} ${template.groups?.find((group) => group.id === property.group)?.label ?? ""}`,
					),
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
			if (item.valueChange && (sensitive(item.from) || sensitive(item.to)))
				remember(
					item.valueChange.from,
					item.valueChange.to,
					item.valueChange.fromName,
					item.valueChange.toName,
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
	context: MigrationRedactionContext = {},
): MigrationReport {
	const { sensitive, text } = migrationRedactor({ ...context, report });
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
			item.valueChange &&
			(sensitive(report.moved[index].from) || sensitive(report.moved[index].to))
				? { ...item, valueChange: change }
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

function templateName(ref: MigrationReport["from"]): string {
	const name = ref.name ?? ref.id;
	const tag =
		ref.deprecated && !/deprecated/i.test(name) ? " (deprecated)" : "";
	return `${name} v${ref.version}${tag}`;
}

function fieldName(field: Field): string {
	const label = field.label ?? field.key;
	return field.group ? `${field.group} › ${label}` : label;
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

export function renderReportText(
	report: MigrationReport,
	{ elementId, color, dryRun, redaction }: RenderOptions,
): string {
	elementId = redactMigrationDiagnostic(elementId, { ...redaction, report });
	report = redactReport(report, redaction);
	const s = styles(color);
	const lines: string[] = [];
	const section = (
		marker: string,
		title: string,
		count: number,
		paint: Style,
	) => {
		lines.push("", paint(s.bold(`${marker} ${title} (${count})`)));
	};
	const item = (text: string) => lines.push(`   ${text}`);

	lines.push(
		`${s.bold(`🔄 ${elementId}`)}  ${s.dim(templateName(report.from))} → ${s.bold(templateName(report.to))}`,
	);
	if (report.refusal) {
		lines.push(s.yellow(`   ⚠️  Recipe not used: ${report.refusal}`));
	} else if (report.usedRecipe) {
		lines.push(s.dim("   📜 Applied the migration recipe"));
	} else {
		lines.push(s.dim("   ℹ️  No recipe: values carried over by key"));
	}

	if (report.dropped.length > 0) {
		section("➖", "Dropped", report.dropped.length, s.yellow);
		for (const d of report.dropped) {
			item(`${fieldName(d)}  ${s.bold(valueText(d.value, d.valueName))}`);
		}
	}

	if (report.added.length > 0) {
		section("➕", "Added", report.added.length, s.green);
		for (const a of report.added) {
			item(`${fieldName(a)}  ${s.bold(valueText(a.value, a.valueName))}`);
		}
	}

	if (report.moved.length > 0) {
		section("↪️ ", "Moved", report.moved.length, s.green);
		for (const m of report.moved) {
			const from = fieldName(m.from);
			const fullTo = fieldName(m.to);
			const sameGroup =
				m.from.group !== undefined && m.from.group === m.to.group;
			const to =
				sameGroup && from !== fullTo ? (m.to.label ?? m.to.key) : fullTo;
			const change = m.valueChange;
			if (change) {
				const values = `${valueText(change.from, change.fromName)} → ${s.bold(valueText(change.to, change.toName))}`;
				item(
					from === to
						? `${from}  ${values}`
						: `${from} → ${s.bold(to)}  ${values}`,
				);
			} else {
				item(`${s.dim(from)} → ${s.bold(to)}`);
			}
		}
	}

	if (report.changed.length > 0) {
		section("✏️ ", "Changed", report.changed.length, s.cyan);
		for (const c of report.changed) {
			const { from, to, fromName, toName } = c.valueChange;
			item(
				`${fieldName(c)}  ${valueText(from, fromName)} → ${s.bold(valueText(to, toName))}`,
			);
		}
	}

	if (report.notes.length > 0) {
		section("💬", "Notes", report.notes.length, s.blue);
		for (const note of report.notes) {
			item(
				note.level === "warning"
					? s.yellow(`⚠️  ${note.message}`)
					: s.blue(`ℹ️  ${note.message}`),
			);
		}
	}

	const { guard, template, noMatch, feel } = report.skipped;
	const skipped = guard.length + template.length + noMatch.length + feel.length;
	if (skipped > 0) {
		section("⏭️ ", "Needs attention", skipped, s.yellow);
		for (const g of guard) {
			item(`Condition not met, not moved: ${g.from} → ${g.to}`);
		}
		for (const t of template) {
			item(`Not composed, missing ${t.missing.join(", ")}: ${t.to}`);
		}
		for (const n of noMatch) {
			item(`No value rule matched, target default kept: ${n.from} → ${n.to}`);
		}
		for (const f of feel) {
			item(
				`FEEL expression moved as-is, value rules not applied: ${f.from} → ${f.to}`,
			);
		}
	}

	lines.push("");
	if (report.lossless) {
		lines.push(s.green("✅ No values lost"));
	} else {
		const count = report.dropped.length;
		lines.push(
			s.yellow(
				count > 0
					? `⚠️  ${count} value${count === 1 ? "" : "s"} dropped, review above`
					: "⚠️  Some values were not migrated, review above",
			),
		);
	}
	if (dryRun) {
		lines.push(s.dim("🔍 Dry run: nothing was written"));
	}
	return `${lines.join("\n")}\n`;
}

export type RecipeSource = "file" | "embedded" | "none";

/** The report as plain data for `--json`. */
export function reportToJson(
	report: MigrationReport,
	{
		elementId,
		action,
		recipe,
		dryRun,
		file,
		redaction,
	}: {
		elementId: string;
		action: "change" | "update";
		recipe: RecipeSource;
		dryRun: boolean;
		file?: string;
		redaction?: MigrationRedactionContext;
	},
) {
	const { text } = migrationRedactor({ ...redaction, report });
	report = redactReport(report, redaction);
	return {
		elementId: text(elementId),
		action,
		dryRun,
		...(file ? { file: text(file) } : {}),
		from: report.from,
		to: report.to,
		recipe: {
			source: recipe,
			used: report.usedRecipe,
			refusal: report.refusal,
		},
		lossless: report.lossless,
		report: {
			dropped: report.dropped,
			added: report.added,
			changed: report.changed,
			moved: report.moved,
			notes: report.notes,
			skipped: report.skipped,
		},
	};
}
