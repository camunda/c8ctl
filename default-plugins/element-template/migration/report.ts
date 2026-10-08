/**
 * The migration report: what an element lost, gained and moved. Plain data;
 * rendering belongs to the caller.
 *
 * Built from the element's values before and after the migration plus what
 * the recipe steps reported, so it describes the outcome rather than the
 * intent of the recipe.
 */

import { bindingTargetKey } from "./binding.ts";
import type { ElementValue } from "./element-values.ts";
import type { MovedFact, PlanFacts } from "./plan.ts";
import type { Note } from "./recipe.ts";
import type { MigrationTemplate, TemplateProperty } from "./types.ts";

export interface ReportFacts extends PlanFacts {
	/** Expected stored values, including FEEL normalization. */
	moved: (MovedFact & { value?: string })[];
	/** Step snapshots prevent removed lineage from being revived later. */
	after?: ElementValue[];
	failedWrites?: boolean;
}

export interface Field {
	key: string;
	bindingType: string | null;
	label?: string;
	group?: string;
}

export interface TemplateRef {
	id: string;
	version: number;
	name?: string;
	deprecated: boolean;
}

export interface ValueChange {
	from: string;
	to: string;
	fromName?: string;
	toName?: string;
}

export interface MovedItem {
	from: Field;
	to: Field;
	/** Set when the value was rewritten on the way, or differs after the move. */
	valueChange?: ValueChange;
}

export interface MigrationReport {
	from: TemplateRef;
	to: TemplateRef;
	/** The recipe declared for this change was used. */
	usedRecipe: boolean;
	/** Why a declared recipe was not used. */
	refusal: string | null;
	dropped: (Field & { value: string; valueName?: string })[];
	added: (Field & { value: string; valueName?: string })[];
	changed: (Field & { valueChange: ValueChange })[];
	moved: MovedItem[];
	notes: Note[];
	skipped: {
		guard: PlanFacts["guardSkipped"];
		template: PlanFacts["templateSkipped"];
		noMatch: PlanFacts["noMatch"];
		feel: PlanFacts["feelSkipped"];
	};
	/** Nothing was dropped or skipped. */
	lossless: boolean;
}

export function templateRef(template: MigrationTemplate): TemplateRef {
	return {
		id: template.id,
		version: template.version ?? 0,
		name: template.name,
		deprecated: Boolean(template.deprecated),
	};
}

export function mergeFacts(all: ReportFacts[]): ReportFacts {
	let moved: ReportFacts["moved"] = [];
	let set: PlanFacts["set"] = [];
	let failedWrites = false;
	for (const facts of all) {
		const same = (
			a: { key: string; bindingType: string | null },
			b: { key: string; bindingType: string | null },
		) => a.key === b.key && a.bindingType === b.bindingType;
		// All moves read the pre-step snapshot, never another move's result.
		const priorMoved = moved;
		const priorSet = set;
		const overwritten = (field: { key: string; bindingType: string | null }) =>
			facts.moved.some((move) => same(move.to, field)) ||
			facts.set.some((write) => same(write, field));
		const forwarded = (field: { key: string; bindingType: string | null }) =>
			facts.moved.some((move) => same(move.from, field));
		failedWrites ||= priorMoved.some(
			(move) => overwritten(move.to) && !forwarded(move.to),
		);
		moved = priorMoved.filter(
			(move) => !overwritten(move.to) && !forwarded(move.to),
		);
		set = priorSet.filter((write) => !overwritten(write) && !forwarded(write));
		for (const move of facts.moved) {
			const addition = priorSet.find((write) => same(write, move.from));
			if (addition) {
				set.push({ ...move.to, value: move.value ?? addition.value });
			} else {
				const prior = priorMoved.find((item) => same(item.to, move.from));
				moved.push({
					...move,
					from: prior?.from ?? move.from,
					transformed: Boolean(prior?.transformed) || move.transformed,
				});
			}
		}
		for (const write of facts.set) {
			moved = moved.filter((move) => !same(move.to, write));
			set = set.filter((prior) => !same(prior, write));
			set.push(write);
		}
		if (facts.after) {
			const after = facts.after;
			const surviving = (
				field: { key: string; bindingType: string | null },
				value: string | undefined,
			) => {
				const actual = find(after, field.key, field.bindingType);
				return (
					actual !== undefined &&
					(value === undefined || actual.value === value)
				);
			};
			failedWrites ||=
				moved.some((move) => !surviving(move.to, move.value)) ||
				set.some((write) => !surviving(write, write.value));
			moved = moved.filter((move) => surviving(move.to, move.value));
			set = set.filter((write) => surviving(write, write.value));
		}
		failedWrites ||= Boolean(facts.failedWrites);
	}
	return {
		moved,
		set,
		failedWrites,
		notes: all.flatMap((f) => f.notes),
		guardSkipped: all.flatMap((f) => f.guardSkipped),
		templateSkipped: all.flatMap((f) => f.templateSkipped),
		noMatch: all.flatMap((f) => f.noMatch),
		feelSkipped: all.flatMap((f) => f.feelSkipped),
	};
}

function propertyFor(
	template: MigrationTemplate | undefined,
	key: string,
	bindingType: string | null,
): TemplateProperty | undefined {
	return template?.properties.find(
		(p) =>
			bindingTargetKey(p.binding) === key &&
			(bindingType === null || p.binding?.type === bindingType),
	);
}

function fieldOf(
	template: MigrationTemplate | undefined,
	key: string,
	bindingType: string | null,
): Field {
	const property = propertyFor(template, key, bindingType);
	const field: Field = {
		key,
		bindingType: bindingType ?? property?.binding?.type ?? null,
	};
	if (property?.label) {
		field.label = property.label;
	}
	const groupLabel = template?.groups?.find(
		(g) => g.id === property?.group,
	)?.label;
	if (groupLabel && groupLabel !== property?.label) {
		field.group = groupLabel;
	}
	return field;
}

function choiceName(
	template: MigrationTemplate | undefined,
	field: Field,
	value: string,
): string | undefined {
	const property = propertyFor(template, field.key, field.bindingType);
	return property?.choices?.find((c) => c.value === value)?.name;
}

function find(values: ElementValue[], key: string, bindingType: string | null) {
	return values.find(
		(v) =>
			v.key === key && (bindingType === null || v.bindingType === bindingType),
	);
}

function isHidden(
	template: MigrationTemplate,
	key: string,
	bindingType: string,
): boolean {
	return propertyFor(template, key, bindingType)?.type === "Hidden";
}

function withNames(
	template: MigrationTemplate | undefined,
	field: Field,
	value: string,
): { valueName?: string } {
	const name = choiceName(template, field, value);
	return name ? { valueName: name } : {};
}

export function buildReport({
	fromTemplate,
	toTemplate,
	before,
	after,
	facts,
	usedRecipe,
	refusal,
}: {
	/** The template the element was on; a stub with no properties when it is not available. */
	fromTemplate: MigrationTemplate;
	toTemplate: MigrationTemplate;
	before: ElementValue[];
	after: ElementValue[];
	facts: ReportFacts;
	usedRecipe: boolean;
	refusal: string | null;
}): MigrationReport {
	const survivingMoves = facts.moved.filter((m) => {
		const source = find(before, m.from.key, m.from.bindingType);
		const target = find(after, m.to.key, m.to.bindingType);
		return (
			source !== undefined &&
			target !== undefined &&
			(m.value !== undefined
				? target.value === m.value
				: m.transformed
					? source.value === "" || target.value !== ""
					: target.value === source.value)
		);
	});
	const survivingSets = facts.set.filter(
		(s) => find(after, s.key, s.bindingType)?.value === s.value,
	);
	const claimedFrom = (v: ElementValue) =>
		survivingMoves.some(
			(m) =>
				m.from.key === v.key &&
				(m.from.bindingType === null || m.from.bindingType === v.bindingType),
		);
	const claimedTo = (v: ElementValue) =>
		survivingMoves.some(
			(m) =>
				m.to.key === v.key &&
				(m.to.bindingType === null || m.to.bindingType === v.bindingType),
		) ||
		survivingSets.some(
			(s) =>
				s.key === v.key &&
				(s.bindingType === null || s.bindingType === v.bindingType),
		);

	const moved: MovedItem[] = survivingMoves.map((m) => {
		const from = fieldOf(fromTemplate, m.from.key, m.from.bindingType);
		const to = fieldOf(toTemplate, m.to.key, m.to.bindingType);
		const fromValue = find(before, m.from.key, m.from.bindingType)?.value;
		const toValue = find(after, m.to.key, m.to.bindingType)?.value;
		const item: MovedItem = { from, to };
		if (
			(m.transformed || fromValue !== toValue) &&
			fromValue !== undefined &&
			toValue !== undefined
		) {
			item.valueChange = {
				from: fromValue,
				to: toValue,
				...nameOf("fromName", choiceName(fromTemplate, from, fromValue)),
				...nameOf("toName", choiceName(toTemplate, to, toValue)),
			};
		}
		return item;
	});

	const dropped = before
		.filter(
			(v) =>
				v.value !== "" && !claimedFrom(v) && !find(after, v.key, v.bindingType),
		)
		.map((v) => {
			const field = fieldOf(fromTemplate, v.key, v.bindingType);
			return {
				...field,
				value: v.value,
				...withNames(fromTemplate, field, v.value),
			};
		});

	const added = after
		.filter(
			(v) =>
				v.value !== "" &&
				!find(before, v.key, v.bindingType) &&
				!isHidden(toTemplate, v.key, v.bindingType) &&
				!claimedTo(v),
		)
		.map((v) => {
			const field = fieldOf(toTemplate, v.key, v.bindingType);
			return {
				...field,
				value: v.value,
				...withNames(toTemplate, field, v.value),
			};
		});

	for (const s of survivingSets) {
		const field = fieldOf(toTemplate, s.key, s.bindingType);
		const actual = find(after, s.key, s.bindingType)?.value ?? "";
		added.push({
			...field,
			value: actual,
			...withNames(toTemplate, field, actual),
		});
	}

	const changed = after
		.filter((v) => {
			const prior = find(before, v.key, v.bindingType);
			return (
				prior !== undefined &&
				prior.value !== v.value &&
				!claimedTo(v) &&
				!isHidden(toTemplate, v.key, v.bindingType)
			);
		})
		.map((v) => {
			const prior = find(before, v.key, v.bindingType);
			const field = fieldOf(toTemplate, v.key, v.bindingType);
			const fromValue = prior?.value ?? "";
			return {
				...field,
				valueChange: {
					from: fromValue,
					to: v.value,
					...nameOf("fromName", choiceName(fromTemplate, field, fromValue)),
					...nameOf("toName", choiceName(toTemplate, field, v.value)),
				},
			};
		});

	const skipped = {
		guard: facts.guardSkipped,
		template: facts.templateSkipped,
		noMatch: facts.noMatch,
		feel: facts.feelSkipped,
	};

	return {
		from: templateRef(fromTemplate),
		to: templateRef(toTemplate),
		usedRecipe,
		refusal,
		dropped,
		added,
		changed,
		moved,
		notes: facts.notes,
		skipped,
		lossless:
			!facts.failedWrites &&
			survivingMoves.length ===
				facts.moved.filter((move) =>
					find(before, move.from.key, move.from.bindingType),
				).length &&
			survivingSets.length === facts.set.length &&
			dropped.length === 0 &&
			skipped.guard.length === 0 &&
			skipped.template.length === 0 &&
			skipped.noMatch.length === 0,
	};
}

function nameOf(
	field: "fromName" | "toName",
	name: string | undefined,
): { fromName?: string; toName?: string } {
	return name === undefined ? {} : { [field]: name };
}
