/**
 * Runtime type guards for narrowing values in tests without `as T` casts.
 *
 * These helpers replace `x as Record<string, unknown>` patterns with
 * assertions that throw a descriptive error on failure — giving better
 * diagnostics than a silent cast when a future change breaks the assumption.
 */

import assert from "node:assert";

export function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Assert `v` is a non-array object and return it typed as a record.
 * Throws with a descriptive message on failure.
 */
export function asRecord(v: unknown, label = "value"): Record<string, unknown> {
	assert.ok(isRecord(v), `expected ${label} to be an object`);
	return v;
}

/**
 * Extract `out.body` as a record. Used by dry-run tests.
 */
export function getBody(out: Record<string, unknown>): Record<string, unknown> {
	return asRecord(out.body, "dry-run body");
}

/**
 * Extract `out.body.filter` as a record. Used by read-command dry-run tests.
 */
export function getFilter(
	out: Record<string, unknown>,
): Record<string, unknown> {
	return asRecord(getBody(out).filter, "dry-run body.filter");
}

/**
 * Narrow a JSON array of objects to `Record<string, unknown>[]`.
 */
export function asRecordArray(
	v: unknown,
	label = "value",
): Record<string, unknown>[] {
	assert.ok(Array.isArray(v), `expected ${label} to be an array`);
	return v.map((item, i) => asRecord(item, `${label}[${i}]`));
}
