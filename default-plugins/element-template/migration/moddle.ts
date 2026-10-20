/**
 * Typed accessors for the untyped moddle object graph. All reads narrow with
 * runtime guards, never type assertions.
 */

export type ModdleElement = {
	$type: string;
	get(name: string): unknown;
	[key: string]: unknown;
};

export function isModdleElement(value: unknown): value is ModdleElement {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	if (!("get" in value)) {
		return false;
	}
	return typeof value.get === "function";
}

export function getModdleString(
	element: ModdleElement,
	name: string,
): string | undefined {
	const value = element.get(name);
	return typeof value === "string" ? value : undefined;
}

export function getModdleNumber(
	element: ModdleElement,
	name: string,
): number | undefined {
	const value = element.get(name);
	return typeof value === "number" ? value : undefined;
}

export function getModdleElement(
	element: ModdleElement,
	name: string,
): ModdleElement | undefined {
	const value = element.get(name);
	return isModdleElement(value) ? value : undefined;
}

/** A collection property as a list of moddle elements; empty when absent. */
export function getModdleList(
	element: ModdleElement | undefined,
	name: string,
): ModdleElement[] {
	if (!element) {
		return [];
	}
	const value = element.get(name);
	return Array.isArray(value) ? value.filter(isModdleElement) : [];
}
