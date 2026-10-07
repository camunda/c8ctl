/**
 * Presentation of a migration report for the CLI: coloured text with emoji
 * markers for people, a plain data shape for `--json`.
 */

import type { Field, MigrationReport } from "./migration/report.ts";

export interface RenderOptions {
	elementId: string;
	color: boolean;
	dryRun: boolean;
}

type Style = (text: string) => string;

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
	{ elementId, color, dryRun }: RenderOptions,
): string {
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
	}: {
		elementId: string;
		action: "change" | "update";
		recipe: RecipeSource;
		dryRun: boolean;
		file?: string;
	},
) {
	return {
		elementId,
		action,
		dryRun,
		...(file ? { file } : {}),
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
