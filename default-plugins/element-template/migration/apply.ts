/**
 * Applies a migration to one element of a headless modeler.
 *
 * Each step is applied the way the library applies a template, with the
 * recipe's values forced on top: a clone of the step's template is
 * pre-seeded with the resolved values, applied, the values are written to
 * the extension tree, and the template is applied once more so bindings
 * whose condition the writes just satisfied materialise.
 */

import {
	findExtensionContainers,
	findPropertiesByTarget,
	maybePrependFeel,
	resolveBindingTarget,
} from "./binding.ts";
import {
	type ElementValue,
	enumerateElementValues,
	getExtensionElements,
} from "./element-values.ts";
import {
	getModdleNumber,
	getModdleString,
	type ModdleElement,
} from "./moddle.ts";
import { buildStepPlan, type PlanFacts, validateTargets } from "./plan.ts";
import type { Recipe } from "./recipe.ts";
import { buildReport, type MigrationReport, mergeFacts } from "./report.ts";
import {
	type Application,
	resolveApplications,
	resolveSteps,
} from "./steps.ts";
import type { MigrationTemplate } from "./types.ts";

export interface BpmnElement {
	businessObject: ModdleElement;
}

export interface MigrationModeler {
	elementTemplates: {
		set(templates: MigrationTemplate[]): void;
		applyTemplate(
			element: BpmnElement,
			template: MigrationTemplate,
		): BpmnElement | undefined;
	};
	modeling: {
		updateModdleProperties(
			element: BpmnElement,
			moddleElement: ModdleElement,
			properties: Record<string, unknown>,
		): void;
	};
}

export interface AppliedTemplate {
	id: string;
	version: number;
}

/** The template an element is bound to, or `undefined` when it has none. */
export function readAppliedTemplate(
	businessObject: ModdleElement,
): AppliedTemplate | undefined {
	const id = getModdleString(businessObject, "modelerTemplate");
	if (id === undefined) {
		return undefined;
	}
	const asString = getModdleString(businessObject, "modelerTemplateVersion");
	const version =
		asString !== undefined && asString !== ""
			? Number(asString)
			: getModdleNumber(businessObject, "modelerTemplateVersion");
	return version === undefined || !Number.isSafeInteger(version) || version < 0
		? undefined
		: { id, version };
}

export interface MigrationResult {
	element: BpmnElement;
	report: MigrationReport;
}

function valuesOf(element: BpmnElement): ElementValue[] {
	return enumerateElementValues(getExtensionElements(element.businessObject));
}

function applyApplication(
	modeler: MigrationModeler,
	catalog: MigrationTemplate[],
	element: BpmnElement,
	application: Application,
): { element: BpmnElement; facts: PlanFacts } | null {
	const { template, step } = application;
	const applied = readAppliedTemplate(element.businessObject);
	if (applied?.id === template.id && applied.version === template.version) {
		return null;
	}

	const { writes, facts } = buildStepPlan(
		step?.entries ?? [],
		valuesOf(element),
		template,
	);
	for (const source of valuesOf(element)) {
		if (
			writes.some(
				(write) =>
					write.key === source.key && write.bindingType === source.bindingType,
			)
		)
			continue;
		const properties = findPropertiesByTarget(
			template.properties,
			source.key,
			source.bindingType,
		);
		if (
			source.value !== "" &&
			properties.some((property) => property.type !== "Hidden")
		) {
			writes.push({
				key: source.key,
				bindingType: source.bindingType,
				value: source.value,
				entry: {
					kind: "set",
					to: source.key,
					value: source.value,
					when: [],
					label: "carry-over",
				},
			});
		}
	}

	// Seed the template so optional and empty targets materialise on apply.
	const clone = structuredClone(template);
	for (const w of writes) {
		for (const property of findPropertiesByTarget(
			clone.properties,
			w.key,
			w.bindingType,
		)) {
			if (w.entry.label === "carry-over" && property.type === "Hidden")
				continue;
			property.value = maybePrependFeel(property, w.value);
		}
	}
	modeler.elementTemplates.set(
		catalog.map((t) =>
			t.id === clone.id && t.version === clone.version ? clone : t,
		),
	);

	let current =
		modeler.elementTemplates.applyTemplate(element, clone) ?? element;

	// Re-applying keeps existing values, so write each resolved value directly.
	for (const w of writes) {
		const containers = findExtensionContainers(
			getExtensionElements(current.businessObject),
		);
		for (const property of findPropertiesByTarget(
			clone.properties,
			w.key,
			w.bindingType,
		)) {
			if (w.entry.label === "carry-over" && property.type === "Hidden")
				continue;
			if (!property.binding) {
				continue;
			}
			const target = resolveBindingTarget(property.binding, containers);
			if (target) {
				modeler.modeling.updateModdleProperties(current, target.child, {
					[target.property]: maybePrependFeel(property, w.value),
				});
			}
		}
	}

	current = modeler.elementTemplates.applyTemplate(current, clone) ?? current;
	return { element: current, facts };
}

/**
 * Migrate `element` from the template it is on to `target`.
 *
 * `templates` must hold every template the change may need: the applied one
 * (for a precise carry-over), the intermediate versions a recipe climbs and
 * the target. `fromTemplate` is a stub with no properties when the applied
 * template is not available. Throws when a required step template is missing
 * or the recipe writes to a path the target does not bind; nothing is
 * modified in that case.
 */
export function migrateElement({
	modeler,
	element,
	fromTemplate,
	target,
	templates,
	recipe,
}: {
	modeler: MigrationModeler;
	element: BpmnElement;
	fromTemplate: MigrationTemplate;
	target: MigrationTemplate;
	templates: MigrationTemplate[];
	recipe?: Recipe;
}): MigrationResult {
	const applied = readAppliedTemplate(element.businessObject);
	if (
		!applied ||
		applied.id !== fromTemplate.id ||
		applied.version !== fromTemplate.version
	) {
		throw new Error(
			"Migration context does not match the element's applied template.",
		);
	}
	const { steps, refusal } = resolveSteps({
		appliedId: fromTemplate.id,
		appliedVersion: fromTemplate.version ?? 0,
		target,
		templates,
		recipe,
	});
	const applications = resolveApplications(templates, steps, target);
	for (const { step, template } of applications) {
		if (step) {
			validateTargets(step.entries, template);
		}
	}

	const catalog = [fromTemplate, ...applications.map((a) => a.template)].filter(
		(t, i, all) =>
			all.findIndex((o) => o.id === t.id && o.version === t.version) === i,
	);

	const before = valuesOf(element);
	const allFacts: PlanFacts[] = [];
	let current = element;
	for (const application of applications) {
		const result = applyApplication(modeler, catalog, current, application);
		if (result) {
			current = result.element;
			allFacts.push(result.facts);
		}
	}

	const report = buildReport({
		fromTemplate,
		toTemplate: target,
		before,
		after: valuesOf(current),
		facts: mergeFacts(allFacts),
		usedRecipe: steps.length > 0,
		refusal,
	});
	return { element: current, report };
}
