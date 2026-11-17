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

/** Read values needed to redact migration diagnostics. */
export function enumerateElementValues(
	extensionElements: ModdleElement | undefined,
): ElementValue[] {
	const values = getModdleList(extensionElements, "values");
	const find = (type: string) => values.find((value) => value.$type === type);
	const out: ElementValue[] = [];
	const push = (
		bindingType: string,
		key: string | undefined,
		value: string | undefined,
	) => {
		if (key !== undefined && value !== undefined) {
			out.push({ bindingType, key, value, isFeel: value.startsWith("=") });
		}
	};

	const ioMapping = find("zeebe:IoMapping");
	for (const parameter of getModdleList(ioMapping, "inputParameters")) {
		push(
			"zeebe:input",
			getModdleString(parameter, "target"),
			getModdleString(parameter, "source"),
		);
	}
	for (const parameter of getModdleList(ioMapping, "outputParameters")) {
		push(
			"zeebe:output",
			getModdleString(parameter, "source"),
			getModdleString(parameter, "target"),
		);
	}
	for (const header of getModdleList(find("zeebe:TaskHeaders"), "values")) {
		push(
			"zeebe:taskHeader",
			getModdleString(header, "key"),
			getModdleString(header, "value"),
		);
	}
	for (const property of getModdleList(
		find("zeebe:Properties"),
		"properties",
	)) {
		push(
			"zeebe:property",
			getModdleString(property, "name"),
			getModdleString(property, "value"),
		);
	}

	const taskDefinition = find("zeebe:TaskDefinition");
	if (taskDefinition) {
		const retries =
			getModdleString(taskDefinition, "retries") ??
			stringifyNumber(getModdleNumber(taskDefinition, "retries"));
		push("zeebe:taskDefinition", "retries", retries);
	}
	const agentDefinition = find("zeebe:AgentDefinition");
	if (agentDefinition) {
		push(
			"zeebe:agentDefinition",
			"agentType",
			getModdleString(agentDefinition, "agentType"),
		);
	}
	const adHoc = find("zeebe:AdHoc");
	if (adHoc) {
		for (const name of AD_HOC_PROPERTIES) {
			push("zeebe:adHoc", name, getModdleString(adHoc, name));
		}
	}
	return out;
}

function stringifyNumber(value: number | undefined): string | undefined {
	return value === undefined ? undefined : String(value);
}

export function getExtensionElements(
	businessObject: ModdleElement,
): ModdleElement | undefined {
	return getModdleElement(businessObject, "extensionElements");
}
