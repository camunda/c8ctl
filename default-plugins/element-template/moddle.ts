/**
 * Typed accessors for the moddle object graph — the single place in the
 * plugin where the untyped `moddleElement.get(name)` boundary is crossed.
 *
 * moddle's `get()` is declared to return `unknown`: its schema is dynamic
 * (driven by the loaded moddle extensions) and isn't expressed in the type
 * system. Historically every read site cast the result with `as` and pinned a
 * `biome-ignore lint/plugin` suppression next to it. Instead, all reads now
 * funnel through these guard-based accessors, which narrow `get()`'s result
 * with runtime checks rather than assertions. That keeps the rest of the
 * plugin cast-free and confines the moddle contract to this one module.
 *
 * Because the accessors narrow with type guards (never `as`), this file itself
 * carries no suppression — see `tests/unit/no-plugin-ignore-boundary.test.ts`,
 * which forbids the `biome-ignore lint/plugin` comment outside an explicit
 * allow-list (moddle is not on it).
 */

export type ModdleElement = {
	$type: string;
	get(name: string): unknown;
	[key: string]: unknown;
};

/**
 * Structural guard for a moddle element. A moddle element is an object that
 * exposes a `get` method; that is the only shape this plugin relies on. The
 * `$type` string is asserted by the predicate but not verified at runtime —
 * every real moddle element carries one, and the accessors only ever read it
 * for diagnostics/filtering.
 */
export function isModdleElement(value: unknown): value is ModdleElement {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	if (!("get" in value)) {
		return false;
	}
	return typeof value.get === "function";
}

/** Read a string-valued moddle property, or `undefined` if absent/other type. */
export function getModdleString(
	element: ModdleElement,
	name: string,
): string | undefined {
	const value = element.get(name);
	return typeof value === "string" ? value : undefined;
}

/** Read a number-valued moddle property, or `undefined` if absent/other type. */
export function getModdleNumber(
	element: ModdleElement,
	name: string,
): number | undefined {
	const value = element.get(name);
	return typeof value === "number" ? value : undefined;
}

/** Read a child moddle element, or `undefined` if absent/not an element. */
export function getModdleElement(
	element: ModdleElement,
	name: string,
): ModdleElement | undefined {
	const value = element.get(name);
	return isModdleElement(value) ? value : undefined;
}

/**
 * Read a moddle collection property as a list of moddle elements. Returns an
 * empty array when the property is absent, not an array, or holds non-element
 * entries — callers treat "no backing collection" and "empty collection"
 * identically.
 */
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
