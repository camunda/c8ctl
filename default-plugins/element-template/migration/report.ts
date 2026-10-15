/**
 * The migration report: what an element lost, gained and moved. Plain data;
 * rendering belongs to the caller.
 *
 * Built from the element's values before and after the migration plus what
 * the recipe steps reported, so it describes the outcome rather than the
 * intent of the recipe.
 */

import {
	bindingTargetKey,
	type FieldKey,
	findPropertiesByTarget,
	sameTarget,
} from "./binding.ts";
import type { ElementValue } from "./element-values.ts";
import type { MovedFact, PlanFacts } from "./plan.ts";
import type { Note } from "./recipe.ts";
import type {
	MigrationTemplate,
	TemplateBinding,
	TemplateProperty,
} from "./types.ts";

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
	/** Group ID of the template property. */
	group?: string;
	groupLabel?: string;
	propertyId?: string;
}

/**
 * Where a value on the target came from. `fixed` (a Hidden property) is not
 * reported yet, because Hidden values are left out of the report. A source
 * value that a Hidden property replaced is reported as dropped instead.
 */
export type ValueSource = "recipe" | "map" | "default" | "fixed";

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
	/** The stored value on the target. */
	value: string;
	valueName?: string;
	/** Set when the value was rewritten on the way, or differs after the move. */
	valueChange?: ValueChange;
	source: "recipe" | "map";
}

export interface MigrationReport {
	from: TemplateRef;
	to: TemplateRef;
	/** The recipe declared for this change was used. */
	usedRecipe: boolean;
	/** Why a declared recipe was not used. */
	refusal: string | null;
	dropped: (Field & {
		value: string;
		valueName?: string;
		/**
		 * Why a value whose field still exists was lost: a Hidden target
		 * property reset it, or a move or set overwrote it.
		 */
		cause?: "hidden" | "displaced";
	})[];
	added: (Field & {
		value: string;
		valueName?: string;
		source: ValueSource;
	})[];
	changed: (Field & { valueChange: ValueChange; source: ValueSource })[];
	moved: MovedItem[];
	/** Values whose key and value did not change. */
	kept: Field[];
	notes: Note[];
	skipped: {
		guard: PlanFacts["guardSkipped"];
		template: PlanFacts["templateSkipped"];
		noMatch: PlanFacts["noMatch"];
		feel: PlanFacts["feelSkipped"];
		/** Fields the engine cannot read whose binding the target does not keep. */
		unchecked: Field[];
	};
	/** Nothing was dropped, overwritten, reset by a Hidden property or skipped. */
	lossless: boolean;
}

function templateRef(template: MigrationTemplate): TemplateRef {
	return {
		id: template.id,
		version: template.version ?? 0,
		name: template.name,
		deprecated: Boolean(template.deprecated),
	};
}

const sameField = (a: FieldKey, b: FieldKey) =>
	a.key === b.key && a.bindingType === b.bindingType;

export function mergeFacts(all: ReportFacts[]): ReportFacts {
	let moved: ReportFacts["moved"] = [];
	let set: PlanFacts["set"] = [];
	let failedWrites = false;
	for (const facts of all) {
		// All moves read the pre-step snapshot, never another move's result.
		const priorMoved = moved;
		const priorSet = set;
		const overwritten = (field: FieldKey) =>
			facts.moved.some((move) => sameField(move.to, field)) ||
			facts.set.some((write) => sameField(write, field));
		const forwarded = (field: FieldKey) =>
			facts.moved.some((move) => sameField(move.from, field));
		failedWrites ||= priorMoved.some(
			(move) => overwritten(move.to) && !forwarded(move.to),
		);
		moved = priorMoved.filter(
			(move) => !overwritten(move.to) && !forwarded(move.to),
		);
		set = priorSet.filter((write) => !overwritten(write) && !forwarded(write));
		for (const move of facts.moved) {
			const addition = priorSet.find((write) => sameField(write, move.from));
			if (addition) {
				set.push({ ...move.to, value: move.value ?? addition.value });
			} else {
				const prior = priorMoved.find((item) => sameField(item.to, move.from));
				moved.push({
					...move,
					from: prior?.from ?? move.from,
					transformed: Boolean(prior?.transformed) || move.transformed,
				});
			}
		}
		for (const write of facts.set) {
			moved = moved.filter((move) => !sameField(move.to, write));
			set = set.filter((prior) => !sameField(prior, write));
			set.push(write);
		}
		if (facts.after) {
			const after = facts.after;
			const surviving = (field: FieldKey, value: string | undefined) => {
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
	return findPropertiesByTarget(
		template?.properties ?? [],
		key,
		bindingType,
	)[0];
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
	if (property?.group) {
		field.group = property.group;
		const groupLabel = template?.groups?.find(
			(g) => g.id === property.group,
		)?.label;
		if (groupLabel) {
			field.groupLabel = groupLabel;
		}
	}
	if (property?.id) {
		field.propertyId = property.id;
	}
	return field;
}

/**
 * Sort `items` like the Modeler properties panel: by group order, then by
 * property order of `template`. Ungrouped and unknown fields go last.
 */
function inTemplateOrder<T>(
	template: MigrationTemplate | undefined,
	items: T[],
	fieldKey: (item: T) => FieldKey,
): T[] {
	const groups = template?.groups ?? [];
	const properties = template?.properties ?? [];
	const position = (item: T) => {
		const { key, bindingType } = fieldKey(item);
		const property = propertyFor(template, key, bindingType);
		const group = groups.findIndex((g) => g.id === property?.group);
		return [
			group === -1 ? groups.length : group,
			property ? properties.indexOf(property) : properties.length,
		];
	};
	return items
		.map((item) => ({ item, position: position(item) }))
		.sort(
			(a, b) => a.position[0] - b.position[0] || a.position[1] - b.position[1],
		)
		.map(({ item }) => item);
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
	return values.find((v) => sameTarget(v, { key, bindingType }));
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
	// A set over a prior value is reported as changed or kept, not added.
	const addedSets = survivingSets.filter(
		(s) => !find(before, s.key, s.bindingType),
	);
	const claimedFrom = (v: ElementValue) =>
		survivingMoves.some((m) => sameTarget(v, m.from));
	const claimedTo = (v: ElementValue) =>
		survivingMoves.some((m) => sameTarget(v, m.to)) ||
		addedSets.some((s) => sameTarget(v, s));

	const moved: MovedItem[] = survivingMoves.map((m) => {
		const from = fieldOf(fromTemplate, m.from.key, m.from.bindingType);
		const to = fieldOf(toTemplate, m.to.key, m.to.bindingType);
		const fromValue = find(before, m.from.key, m.from.bindingType)?.value;
		// Surviving moves always have a target value.
		const toValue = find(after, m.to.key, m.to.bindingType)?.value ?? "";
		const item: MovedItem = {
			from,
			to,
			value: toValue,
			...withNames(toTemplate, to, toValue),
			source: m.map ? "map" : "recipe",
		};
		if ((m.transformed || fromValue !== toValue) && fromValue !== undefined) {
			item.valueChange = {
				from: fromValue,
				to: toValue,
				...nameOf("fromName", choiceName(fromTemplate, from, fromValue)),
				...nameOf("toName", choiceName(toTemplate, to, toValue)),
			};
		}
		return item;
	});

	// A move whose destination the Modeler removed (an inactive conditional
	// binding) lost its value even when another move still claims the source.
	const lostBySource = (v: ElementValue) =>
		facts.moved.some(
			(m) =>
				!survivingMoves.includes(m) &&
				sameTarget(v, m.from) &&
				find(after, m.to.key, m.to.bindingType) === undefined,
		);
	// A populated value still bound after the migration can be lost too: a
	// Hidden target property resets it, or a move or set writes over it.
	const causeOf = (v: ElementValue): "hidden" | "displaced" | undefined => {
		const actual = find(after, v.key, v.bindingType);
		if (!actual || actual.value === v.value || claimedFrom(v)) return;
		if (
			survivingMoves.some((m) => sameTarget(v, m.to)) ||
			survivingSets.some((s) => sameTarget(v, s))
		)
			return "displaced";
		if (
			isHidden(toTemplate, v.key, v.bindingType) &&
			!isHidden(fromTemplate, v.key, v.bindingType)
		)
			return "hidden";
	};
	const dropped: MigrationReport["dropped"] = before
		.filter((v) => v.value !== "")
		.flatMap((v) => {
			const cause = causeOf(v);
			if (
				!cause &&
				(claimedFrom(v) || find(after, v.key, v.bindingType)) &&
				!lostBySource(v)
			)
				return [];
			const field = fieldOf(fromTemplate, v.key, v.bindingType);
			return [
				{
					...field,
					value: v.value,
					...withNames(fromTemplate, field, v.value),
					...(cause ? { cause } : {}),
				},
			];
		});

	const added: MigrationReport["added"] = after
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
				source: "default",
			};
		});

	for (const s of addedSets) {
		const field = fieldOf(toTemplate, s.key, s.bindingType);
		const actual = find(after, s.key, s.bindingType)?.value ?? "";
		added.push({
			...field,
			value: actual,
			...withNames(toTemplate, field, actual),
			source: "recipe",
		});
	}

	const changed: MigrationReport["changed"] = after
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
				source: survivingSets.some((s) => sameTarget(v, s))
					? "recipe"
					: "default",
			};
		});

	const kept = after
		.filter(
			(v) =>
				v.value !== "" &&
				find(before, v.key, v.bindingType)?.value === v.value &&
				!claimedTo(v) &&
				!isHidden(toTemplate, v.key, v.bindingType),
		)
		.map((v) => fieldOf(toTemplate, v.key, v.bindingType));

	const skipped = {
		guard: facts.guardSkipped,
		template: facts.templateSkipped,
		noMatch: facts.noMatch,
		feel: facts.feelSkipped,
		unchecked: uncheckedFields(fromTemplate, toTemplate),
	};

	return {
		from: templateRef(fromTemplate),
		to: templateRef(toTemplate),
		usedRecipe,
		refusal,
		dropped: inTemplateOrder(fromTemplate, dropped, (item) => item),
		added: inTemplateOrder(toTemplate, added, (item) => item),
		changed: inTemplateOrder(toTemplate, changed, (item) => item),
		moved: inTemplateOrder(toTemplate, moved, (item) => item.to),
		kept: inTemplateOrder(toTemplate, kept, (item) => item),
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
			skipped.noMatch.length === 0 &&
			skipped.unchecked.length === 0,
	};
}

/**
 * Editable source fields under a binding type the engine does not read. The
 * Modeler keeps such a value only when the target binds it identically and
 * not as Hidden, so any other case may lose a value the report cannot see.
 */
function uncheckedFields(
	fromTemplate: MigrationTemplate,
	toTemplate: MigrationTemplate,
): Field[] {
	return fromTemplate.properties
		.filter(
			(p) =>
				p.binding &&
				p.type !== "Hidden" &&
				bindingTargetKey(p.binding) === undefined &&
				!toTemplate.properties.some(
					(t) => t.type !== "Hidden" && sameBinding(t.binding, p.binding),
				),
		)
		.map((p) => {
			const binding: Record<string, unknown> = { ...p.binding };
			const field: Field = {
				key: String(binding.name ?? binding.property ?? p.id ?? ""),
				bindingType: p.binding?.type ?? null,
			};
			if (p.label) field.label = p.label;
			if (p.id) field.propertyId = p.id;
			return field;
		});
}

function sameBinding(
	a: TemplateBinding | undefined,
	b: TemplateBinding | undefined,
): boolean {
	if (!a || !b) return false;
	const x: Record<string, unknown> = { ...a };
	const y: Record<string, unknown> = { ...b };
	const keys = Object.keys(x);
	return (
		keys.length === Object.keys(y).length && keys.every((k) => x[k] === y[k])
	);
}

function nameOf(
	field: "fromName" | "toName",
	name: string | undefined,
): { fromName?: string; toName?: string } {
	return name === undefined ? {} : { [field]: name };
}
