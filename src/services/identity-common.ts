/**
 * Helpers shared by the identity services.
 */

import { C8ctlError } from "../core/index.ts";

/** A search body: `{ filter }`, or `{}` when no filter is set. */
export function searchBodyOf(filter: Record<string, unknown>) {
	return Object.keys(filter).length > 0 ? { filter } : {};
}

/** Throw `invalid-input` when a required input is empty. */
export function requireInput(
	value: string | undefined,
	flag: string,
	field = flag,
): void {
	if (!value) {
		throw new C8ctlError("invalid-input", `--${flag} is required`, { field });
	}
}
