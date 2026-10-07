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

export function mergeFacts(all: PlanFacts[]): PlanFacts {
	return {
		moved: chainMoves(all.flatMap((f) => f.moved)),
		set: all.flatMap((f) => f.set),
		notes: all.flatMap((f) => f.notes),
		guardSkipped: all.flatMap((f) => f.guardSkipped),
		templateSkipped: all.flatMap((f) => f.templateSkipped),
		noMatch: all.flatMap((f) => f.noMatch),
		feelSkipped: all.flatMap((f) => f.feelSkipped),
	};
}

/** A value moved twice (a to b, then b to c) is one move (a to c). */
function chainMoves(moves: MovedFact[]): MovedFact[] {
	const out: MovedFact[] = [];
	for (const move of moves) {
		const index = out.findIndex((m) => m.to.key === move.from.key);
		if (index === -1) {
			out.push(move);
		} else {
			out[index] = {
				from: out[index].from,
				to: move.to,
				transformed: out[index].transformed || move.transformed,
			};
		}
	}
	return out;
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
	facts: PlanFacts;
	usedRecipe: boolean;
	refusal: string | null;
}): MigrationReport {
	const claimedFrom = (v: ElementValue) =>
		facts.moved.some(
			(m) =>
				m.from.key === v.key &&
				(m.from.bindingType === null || m.from.bindingType === v.bindingType),
		);
	const claimedTo = (v: ElementValue) =>
		facts.moved.some(
			(m) =>
				m.to.key === v.key &&
				(m.to.bindingType === null || m.to.bindingType === v.bindingType),
		) ||
		facts.set.some(
			(s) =>
				s.key === v.key &&
				(s.bindingType === null || s.bindingType === v.bindingType),
		);

	const moved: MovedItem[] = facts.moved.map((m) => {
		const from = fieldOf(fromTemplate, m.from.key, m.from.bindingType);
		const to = fieldOf(toTemplate, m.to.key, m.to.bindingType);
		const fromValue = find(before, m.from.key, m.from.bindingType)?.value;
		const toValue = find(after, m.to.key, m.to.bindingType)?.value;
		const item: MovedItem = { from, to };
		if (m.transformed && fromValue !== undefined && toValue !== undefined) {
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

	for (const s of facts.set) {
		const field = fieldOf(toTemplate, s.key, s.bindingType);
		added.push({
			...field,
			value: s.value,
			...withNames(toTemplate, field, s.value),
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
