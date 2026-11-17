import type { TemplateBinding, TemplateProperty } from "./helpers.ts";

export function bindingTargetKey(
	binding: TemplateBinding | undefined,
): string | undefined {
	if (!binding) return undefined;
	switch (binding.type) {
		case "zeebe:input":
		case "zeebe:property":
			return binding.name;
		case "zeebe:output":
			return binding.source;
		case "zeebe:taskHeader":
			return binding.key;
		case "zeebe:taskDefinition":
		case "zeebe:agentDefinition":
		case "zeebe:adHoc":
			return binding.property;
		default:
			return undefined;
	}
}

export function sameTarget(
	candidate: {
		key: string | undefined;
		bindingType: string | null | undefined;
	},
	target: { key: string; bindingType: string | null },
): boolean {
	return (
		candidate.key === target.key &&
		(target.bindingType === null ||
			candidate.bindingType === target.bindingType)
	);
}

export function maybePrependFeel(
	property: TemplateProperty,
	value: string,
): string {
	if (property.feel !== "required" || value === "" || value.startsWith("=")) {
		return value;
	}
	return `=${value}`;
}
