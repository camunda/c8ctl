/**
 * Shared moddle-tree lookup for element-template bindings: locating the
 * extension containers on a BPMN element's `extensionElements`, and
 * resolving which moddle child + property a given template binding writes
 * to. Used by both `apply` and `edit` so the binding resolution logic —
 * which BPMN location a `zeebe:input`/`zeebe:output`/etc. binding maps to —
 * isn't duplicated between the two.
 *
 * This is a hand-rolled, 5-binding-type stand-in for the real dispatch
 * logic inside bpmn-js-element-templates (`propertyUtil#setPropertyValue`,
 * which handles 15+ binding types plus FEEL/Boolean casting). That logic
 * isn't exported today — see bpmn-io/bpmn-js-element-templates#235/#236,
 * which adds a `bpmn-js-element-templates/util` subpath exporting
 * `getPropertyValue`/`setPropertyValue`/`validateProperty`/`applyConditions`/
 * `isConditionMet`. Once #236 merges and ships in a release, this module
 * should be replaced by calls into that subpath instead of maintained here.
 */

import type { TemplateBinding } from "./helpers.ts";

export type ModdleElement = {
	$type: string;
	get(name: string): unknown;
	[key: string]: unknown;
};

export type ExtensionContainers = {
	ioMapping: ModdleElement | undefined;
	taskHeaders: ModdleElement | undefined;
	taskDefinition: ModdleElement | undefined;
	zeebeProperties: ModdleElement | undefined;
};

/**
 * Find the first child of `extensionElements` whose moddle `$type` matches.
 * Avoids importing bpmn-js's `is()` helper just for one shape check.
 */
export function findExtensionByType(
	extensionElements: ModdleElement | undefined,
	type: string,
): ModdleElement | undefined {
	if (!extensionElements) {
		return undefined;
	}
	// biome-ignore lint/plugin: moddle API contract boundary — get() returns untyped collections
	const values = extensionElements.get("values") as ModdleElement[] | undefined;
	return values?.find((v) => v.$type === type);
}

/** Locate the extension containers each binding type reads/writes to. */
export function findExtensionContainers(
	extensionElements: ModdleElement | undefined,
): ExtensionContainers {
	return {
		ioMapping: findExtensionByType(extensionElements, "zeebe:IoMapping"),
		taskHeaders: findExtensionByType(extensionElements, "zeebe:TaskHeaders"),
		taskDefinition: findExtensionByType(
			extensionElements,
			"zeebe:TaskDefinition",
		),
		zeebeProperties: findExtensionByType(extensionElements, "zeebe:Properties"),
	};
}

/**
 * Resolve which existing moddle child + property a binding writes to.
 * Returns `undefined` when the backing moddle entry doesn't exist yet
 * (e.g. its gating condition wasn't met when the template was applied) —
 * callers decide whether that's a create-it-via-reapply case (`apply`) or
 * a hard error (`edit`, which never creates new entries).
 */
export function resolveBindingTarget(
	binding: TemplateBinding,
	containers: ExtensionContainers,
): { child: ModdleElement; property: string } | undefined {
	switch (binding.type) {
		case "zeebe:input": {
			// biome-ignore lint/plugin: moddle API contract boundary — get() returns untyped collections
			const inputs = (containers.ioMapping?.get("inputParameters") ??
				[]) as ModdleElement[];
			const child = inputs.find((p) => p.target === binding.name);
			return child ? { child, property: "source" } : undefined;
		}
		case "zeebe:output": {
			// biome-ignore lint/plugin: moddle API contract boundary — get() returns untyped collections
			const outputs = (containers.ioMapping?.get("outputParameters") ??
				[]) as ModdleElement[];
			const child = outputs.find((p) => p.source === binding.source);
			return child ? { child, property: "target" } : undefined;
		}
		case "zeebe:taskHeader": {
			// biome-ignore lint/plugin: moddle API contract boundary — get() returns untyped collections
			const headers = (containers.taskHeaders?.get("values") ??
				[]) as ModdleElement[];
			const child = headers.find((h) => h.key === binding.key);
			return child ? { child, property: "value" } : undefined;
		}
		case "zeebe:property": {
			// biome-ignore lint/plugin: moddle API contract boundary — get() returns untyped collections
			const props = (containers.zeebeProperties?.get("properties") ??
				[]) as ModdleElement[];
			const child = props.find((p) => p.name === binding.name);
			return child ? { child, property: "value" } : undefined;
		}
		case "zeebe:taskDefinition": {
			return containers.taskDefinition && binding.property
				? { child: containers.taskDefinition, property: binding.property }
				: undefined;
		}
		default:
			return undefined;
	}
}
