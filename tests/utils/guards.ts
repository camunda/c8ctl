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

/**
 * Assert `v` is a string and return it. Throws with a descriptive message
 * on failure.
 */
export function asString(v: unknown, label = "value"): string {
	assert.ok(typeof v === "string", `expected ${label} to be a string`);
	return v;
}

/**
 * Extract `out.url` as a string. Used by dry-run tests.
 */
export function getUrl(out: Record<string, unknown>): string {
	return asString(out.url, "dry-run url");
}

/**
 * Assert `v` is an Error instance and return it. Throws with a descriptive
 * message on failure. Useful for narrowing in catch blocks.
 */
export function asError(v: unknown, label = "error"): Error {
	assert.ok(v instanceof Error, `expected ${label} to be an Error`);
	return v;
}

/**
 * Extract stderr/stdout/message from a Node `child_process` error (e.g. the
 * object thrown by `execSync` on a non-zero exit). Falls back through
 * `stderr`, `stdout`, then `message`.
 */
export function getExecErrorOutput(v: unknown): string {
	if (isRecord(v)) {
		for (const key of ["stderr", "stdout", "message"] as const) {
			const val = v[key];
			if (typeof val === "string" && val.length > 0) return val;
			if (val != null) {
				const s = String(val);
				if (s.length > 0 && s !== "[object Object]") return s;
			}
		}
	}
	return String(v);
}

/**
 * Extract a single field from a Node `child_process` error object. Returns
 * an empty string when the field is missing or the value is not a string.
 */
export function getExecField(
	v: unknown,
	field: "stdout" | "stderr" | "message",
): string {
	if (isRecord(v)) {
		const val = v[field];
		if (typeof val === "string") return val;
		if (val != null) return String(val);
	}
	return "";
}
