/**
 * Reads every value off a BPMN element's extension tree, keyed by binding.
 */

import { findExtensionContainers } from "./binding.ts";
import {
	getModdleElement,
	getModdleList,
	getModdleNumber,
	getModdleString,
	type ModdleElement,
} from "./moddle.ts";

export interface ElementValue {
	bindingType: string;
	key: string;
	value: string;
	isFeel: boolean;
}

const AD_HOC_PROPERTIES = [
	"activeElementsCollection",
	"outputCollection",
	"outputElement",
];

/**
 * The task definition `type` is deliberately excluded: it identifies the
 * connector and is set by the target template, never carried over.
 */
export function enumerateElementValues(
	extensionElements: ModdleElement | undefined,
): ElementValue[] {
	const containers = findExtensionContainers(extensionElements);
	const out: ElementValue[] = [];
	const push = (
		bindingType: string,
		key: string | undefined,
		value: string | undefined,
	) => {
		if (key === undefined || value === undefined) {
			return;
		}
		out.push({ bindingType, key, value, isFeel: value.startsWith("=") });
	};

	for (const p of getModdleList(containers.ioMapping, "inputParameters")) {
		push(
			"zeebe:input",
			getModdleString(p, "target"),
			getModdleString(p, "source"),
		);
	}
	for (const p of getModdleList(containers.ioMapping, "outputParameters")) {
		push(
			"zeebe:output",
			getModdleString(p, "source"),
			getModdleString(p, "target"),
		);
	}
	for (const h of getModdleList(containers.taskHeaders, "values")) {
		push(
			"zeebe:taskHeader",
			getModdleString(h, "key"),
			getModdleString(h, "value"),
		);
	}
	for (const p of getModdleList(containers.zeebeProperties, "properties")) {
		push(
			"zeebe:property",
			getModdleString(p, "name"),
			getModdleString(p, "value"),
		);
	}

	if (containers.taskDefinition) {
		const retries =
			getModdleString(containers.taskDefinition, "retries") ??
			stringifyNumber(getModdleNumber(containers.taskDefinition, "retries"));
		push("zeebe:taskDefinition", "retries", retries);
	}
	if (containers.agentDefinition) {
		push(
			"zeebe:agentDefinition",
			"agentType",
			getModdleString(containers.agentDefinition, "agentType"),
		);
	}
	if (containers.adHoc) {
		for (const name of AD_HOC_PROPERTIES) {
			push("zeebe:adHoc", name, getModdleString(containers.adHoc, name));
		}
	}

	return out;
}

function stringifyNumber(value: number | undefined): string | undefined {
	return value === undefined ? undefined : String(value);
}

/** The element's `extensionElements`, or `undefined` when it has none. */
export function getExtensionElements(
	businessObject: ModdleElement,
): ModdleElement | undefined {
	return getModdleElement(businessObject, "extensionElements");
}
