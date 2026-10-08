/**
 * Resolves one recipe source against an element's current values: which
 * values to write on the target template and what happened along the way.
 *
 * Pure: reads a snapshot of the element's values and never sees another
 * entry's write, so the result does not depend on entry order.
 */

import { findPropertiesByTarget, splitBindingPrefix } from "./binding.ts";
import type { ElementValue } from "./element-values.ts";
import type { Entry, Guard, Note } from "./recipe.ts";
import type { MigrationTemplate } from "./types.ts";

export interface Write {
	/** Target key, without binding-type prefix. */
	key: string;
	bindingType: string | null;
	value: string;
	entry: Entry;
}

/** A value moved to another key, possibly translated on the way. */
export interface MovedFact {
	from: { key: string; bindingType: string | null };
	to: { key: string; bindingType: string | null };
	transformed: boolean;
}

export interface PlanFacts {
	moved: MovedFact[];
	/** Values written from a `set` entry. */
	set: { key: string; bindingType: string | null; value: string }[];
	/** Notes of the entries that took effect. */
	notes: Note[];
	/** A guard rejected an entry whose source value is populated. */
	guardSkipped: { from: string; to: string }[];
	/** A `template` entry lacked source values. */
	templateSkipped: { to: string; missing: string[] }[];
	/** A value map had no matching rule and no default. */
	noMatch: { from: string; to: string }[];
	/** A FEEL expression was moved as-is; its value map was not applied. */
	feelSkipped: { from: string; to: string }[];
}

export interface StepPlan {
	writes: Write[];
	facts: PlanFacts;
}

const TEMPLATE_REF = /\$\{([^}]+)\}/g;

/** Compile a `*`-only glob to an anchored regex. */
export function globToRegex(pattern: string): RegExp {
	const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`^${escaped.replace(/\*/g, ".*")}$`);
}

function lookup(
	values: ElementValue[],
	path: string,
): ElementValue | undefined {
	const { bindingType, key } = splitBindingPrefix(path);
	const matches = values.filter(
		(v) =>
			v.key === key && (bindingType === null || v.bindingType === bindingType),
	);
	if (matches.length > 1) {
		const types = new Set(matches.map((v) => v.bindingType));
		const qualified = [...types].map(
			(type) =>
				`${type === "zeebe:taskHeader" ? "header" : type.replace("zeebe:", "")}:${key}`,
		);
		throw new Error(
			`${types.size > 1 ? "Ambiguous" : "Duplicate"} source path "${path}"; use ${qualified.join(", ")}${types.size === 1 ? " after removing duplicate backing entries" : ""}`,
		);
	}
	return matches[0];
}

function evalGuard(guard: Guard, values: ElementValue[]): boolean {
	const value = lookup(values, guard.path)?.value;
	if (guard.kind === "exists") {
		return guard.exists ? value !== undefined : value === undefined;
	}
	let result: boolean;
	if (guard.kind === "equals") {
		result = value === guard.value;
	} else if (guard.kind === "matches") {
		result = value !== undefined && globToRegex(guard.pattern).test(value);
	} else {
		result = value !== undefined && guard.values.includes(value);
	}
	return guard.not ? !result : result;
}

function isPopulated(value: string | undefined): value is string {
	return value !== undefined && value !== "";
}

export function buildStepPlan(
	entries: Entry[],
	sourceValues: ElementValue[],
	template?: MigrationTemplate,
): StepPlan {
	const facts: PlanFacts = {
		moved: [],
		set: [],
		notes: [],
		guardSkipped: [],
		templateSkipped: [],
		noMatch: [],
		feelSkipped: [],
	};
	const writes: Write[] = [];

	const write = (entry: Entry, to: string, value: string) => {
		const target = splitBindingPrefix(to);
		if (template) {
			validateTargets([entry], template);
			target.bindingType =
				findPropertiesByTarget(
					template.properties,
					target.key,
					target.bindingType,
				)[0].binding?.type ?? null;
		}
		writes.push({
			key: target.key,
			bindingType: target.bindingType,
			value,
			entry,
		});
		if (entry.note) {
			facts.notes.push(entry.note);
		}
		return target;
	};

	for (const entry of entries) {
		const active = entry.when.every((g) => evalGuard(g, sourceValues));

		if (entry.kind === "set") {
			if (active) {
				const target = write(entry, entry.to, entry.value);
				facts.set.push({
					key: target.key,
					bindingType: target.bindingType,
					value: entry.value,
				});
			}
			continue;
		}

		if (entry.kind === "template") {
			const refs = [...entry.template.matchAll(TEMPLATE_REF)].map((m) => m[1]);
			const resolved = refs.map((ref) => lookup(sourceValues, ref)?.value);
			if (!active) {
				if (resolved.some(isPopulated)) {
					facts.guardSkipped.push({ from: entry.template, to: entry.to });
				}
				continue;
			}
			const missing = refs.filter((_, i) => !isPopulated(resolved[i]));
			if (missing.length > 0) {
				facts.templateSkipped.push({ to: entry.to, missing });
				continue;
			}
			let i = 0;
			write(
				entry,
				entry.to,
				entry.template.replace(TEMPLATE_REF, () => resolved[i++] ?? ""),
			);
			continue;
		}

		const source = lookup(sourceValues, entry.from);
		if (!active) {
			if (source && isPopulated(source.value)) {
				facts.guardSkipped.push({ from: entry.from, to: entry.to });
			}
			continue;
		}
		if (!source) {
			continue;
		}

		let value = source.value;
		let transformed = false;
		if (entry.valueMap) {
			if (source.isFeel) {
				facts.feelSkipped.push({ from: entry.from, to: entry.to });
			} else {
				const rule = entry.valueMap.rules.find((r) =>
					globToRegex(r.match).test(source.value),
				);
				const mapped = rule?.value ?? entry.valueMap.default;
				if (mapped === undefined) {
					facts.noMatch.push({ from: entry.from, to: entry.to });
					continue;
				}
				value = mapped;
				transformed = value !== source.value;
			}
		}
		const target = write(entry, entry.to, value);
		facts.moved.push({
			from: { key: source.key, bindingType: source.bindingType },
			to: { key: target.key, bindingType: target.bindingType },
			transformed,
		});
	}

	assertNoAmbiguousWrites(writes);
	return { writes, facts };
}

/** Two active writes to the same target make the recipe ambiguous. */
function assertNoAmbiguousWrites(writes: Write[]): void {
	const seen = new Map<string, Write>();
	for (const w of writes) {
		const id = `${w.bindingType ?? ""} ${w.key}`;
		const previous = seen.get(id);
		if (previous) {
			throw new Error(
				`Ambiguous migration: ${previous.entry.label} and ${w.entry.label} both write to "${w.key}"`,
			);
		}
		seen.set(id, w);
	}
}

/**
 * Fails when an entry writes to a path the target template does not bind,
 * or binds under several binding types without a prefix.
 */
export function validateTargets(
	entries: Entry[],
	template: MigrationTemplate,
): void {
	const label = `${template.id}${template.version === undefined ? "" : `@${template.version}`}`;
	for (const entry of entries) {
		const { bindingType, key } = splitBindingPrefix(entry.to);
		const matches = findPropertiesByTarget(
			template.properties,
			key,
			bindingType,
		);
		if (matches.length === 0) {
			throw new Error(
				`${entry.label}: target path "${entry.to}" is not a binding in template ${label}`,
			);
		}
		const types = new Set(matches.map((m) => m.binding?.type));
		if (types.size > 1) {
			throw new Error(
				`${entry.label}: target path "${entry.to}" is bound by several binding types in template ${label}; add a prefix such as input: or header:`,
			);
		}
	}
}
