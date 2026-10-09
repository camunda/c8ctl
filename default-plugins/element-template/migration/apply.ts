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
import {
	buildStepPlan,
	CARRY_OVER_LABEL,
	carryOverWrites,
	normalizeDestinationValue,
	validateTargets,
} from "./plan.ts";
import type { Recipe } from "./recipe.ts";
import {
	buildReport,
	type MigrationReport,
	mergeFacts,
	type ReportFacts,
} from "./report.ts";
import {
	type Application,
	resolveApplications,
	resolveCatalog,
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
): { element: BpmnElement; facts: ReportFacts } | null {
	const { template, step } = application;
	const applied = readAppliedTemplate(element.businessObject);
	if (applied?.id === template.id && applied.version === template.version) {
		return null;
	}

	const values = valuesOf(element);
	const clone = structuredClone(template);
	const {
		writes: recipeWrites,
		facts,
		activeProperties,
	} = buildStepPlan(step?.entries ?? [], values, clone);
	const writes = [
		...recipeWrites,
		...carryOverWrites(recipeWrites, values, template),
	];

	// Seed the template so optional and empty targets materialise on apply.
	for (const w of writes) {
		for (const property of findPropertiesByTarget(
			clone.properties,
			w.key,
			w.bindingType,
		)) {
			if (!activeProperties.has(property)) continue;
			property.value = normalizeDestinationValue(property, w.value);
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
	const containers = findExtensionContainers(
		getExtensionElements(current.businessObject),
	);
	for (const w of writes) {
		for (const property of findPropertiesByTarget(
			clone.properties,
			w.key,
			w.bindingType,
		)) {
			if (!activeProperties.has(property)) continue;
			if (!property.binding) {
				continue;
			}
			const target = resolveBindingTarget(property.binding, containers);
			if (target) {
				modeler.modeling.updateModdleProperties(current, target.child, {
					[target.property]: normalizeDestinationValue(property, w.value),
				});
			}
		}
	}

	current = modeler.elementTemplates.applyTemplate(current, clone) ?? current;
	const resolvedValue = (key: string, bindingType: string | null) => {
		const write = writes.find(
			(w) => w.key === key && w.bindingType === bindingType,
		);
		const property = findPropertiesByTarget(
			clone.properties,
			key,
			bindingType,
		).find((property) => activeProperties.has(property));
		return write && property
			? normalizeDestinationValue(property, write.value)
			: undefined;
	};
	return {
		element: current,
		facts: {
			...facts,
			after: valuesOf(current),
			moved: facts.moved.map((move) => ({
				...move,
				value: resolvedValue(move.to.key, move.to.bindingType),
			})),
			set: writes
				.filter(
					(write) =>
						(write.entry.kind === "set" &&
							write.entry.label !== CARRY_OVER_LABEL) ||
						write.entry.kind === "template",
				)
				.map((write) => ({
					key: write.key,
					bindingType: write.bindingType,
					value: resolvedValue(write.key, write.bindingType) ?? write.value,
				})),
		},
	};
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
	templates = resolveCatalog(templates, [fromTemplate, target]);
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

	const catalog = resolveCatalog(
		[fromTemplate, ...applications.map((a) => a.template)],
		[fromTemplate, target],
	);

	const before = valuesOf(element);
	const allFacts: ReportFacts[] = [];
	let current = element;
	for (const application of applications) {
		const result = applyApplication(modeler, catalog, current, application);
		if (result) {
			current = result.element;
			allFacts.push(result.facts);
		}
	}

	const finalApplied = readAppliedTemplate(current.businessObject);
	if (
		!finalApplied ||
		finalApplied.id !== target.id ||
		finalApplied.version !== target.version
	) {
		throw new Error("Migration did not apply the target template identity.");
	}

	const report = buildReport({
		fromTemplate,
		toTemplate: target,
		before,
		after: allFacts.at(-1)?.after ?? before,
		facts: mergeFacts(allFacts),
		usedRecipe: steps.length > 0,
		refusal,
	});
	return { element: current, report };
}
