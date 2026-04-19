/**
 * Class-of-defect regression guards for `normalizeToError` (src/errors.ts).
 *
 * Defect class: wrapping a non-Error throw with `new Error(String(error))`
 * collapses RFC 9457 problem-detail objects (which the Camunda SDK
 * throws as plain objects, not Errors) to the literal `Error: [object
 * Object]`, losing every actionable field (`title`, `detail`, `status`).
 *
 * `normalizeToError` is the single shared helper used by:
 *   - `handleCommandError` (src/errors.ts)
 *   - the deploy verbose path (src/commands/deployments.ts)
 *   - the watch deploy-failure logger (src/commands/watch.ts)
 *   - the mcp-proxy startup/shutdown failure path (src/commands/mcp-proxy.ts)
 *
 * Pinning the contract here means any future regression at any of those
 * sites that re-introduces `String(error)` stringification fails this
 * suite — without needing to construct an SDK error mock per call site.
 */

import assert from "node:assert";
import { describe, test } from "node:test";
import { normalizeToError } from "../../src/errors.ts";

describe("normalizeToError — Error inputs pass through unchanged", () => {
	test("plain Error is returned by reference (no wrapping)", () => {
		const original = new Error("boom");
		const result = normalizeToError(original);
		assert.strictEqual(result, original);
	});

	test("Error subclass is returned by reference", () => {
		class CustomError extends Error {}
		const original = new CustomError("custom");
		const result = normalizeToError(original);
		assert.strictEqual(result, original);
	});
});

describe("normalizeToError — non-Error throws are not collapsed to '[object Object]'", () => {
	test("RFC 9457 problem detail with title + detail + status", () => {
		const raw = {
			title: "INVALID_ARGUMENT",
			detail: "Process definition has no executable element",
			status: 400,
		};
		const result = normalizeToError(raw, "Deployment request failed");
		assert.strictEqual(
			result.message,
			"INVALID_ARGUMENT: Process definition has no executable element (status 400)",
		);
		assert.ok(!result.message.includes("[object Object]"));
		assert.strictEqual(result.cause, raw);
	});

	test("title only", () => {
		const raw = { title: "NOT_FOUND" };
		const result = normalizeToError(raw);
		assert.strictEqual(result.message, "NOT_FOUND");
		assert.strictEqual(result.cause, raw);
	});

	test("detail only — falls back to default fallbackMessage", () => {
		const raw = { detail: "thing went sideways" };
		const result = normalizeToError(raw);
		assert.strictEqual(result.message, "Operation failed: thing went sideways");
	});

	test("status only — uses caller fallbackMessage", () => {
		const raw = { status: 503 };
		const result = normalizeToError(raw, "MCP proxy failed");
		assert.strictEqual(result.message, "MCP proxy failed (status 503)");
	});

	test("empty object — falls back to default fallbackMessage, never '[object Object]'", () => {
		const result = normalizeToError({});
		assert.strictEqual(result.message, "Operation failed");
		assert.ok(!result.message.includes("[object Object]"));
	});

	test("primitive throw (string) — falls back to fallbackMessage, never '[object Object]'", () => {
		const result = normalizeToError("oops");
		assert.strictEqual(result.message, "Operation failed");
		assert.ok(!result.message.includes("[object Object]"));
		assert.strictEqual(result.cause, "oops");
	});

	test("primitive throw (number) — falls back, preserves cause", () => {
		const result = normalizeToError(42, "Deployment request failed");
		assert.strictEqual(result.message, "Deployment request failed");
		assert.strictEqual(result.cause, 42);
	});

	test("null throw — falls back, never '[object Object]'", () => {
		const result = normalizeToError(null);
		assert.strictEqual(result.message, "Operation failed");
		assert.ok(!result.message.includes("[object Object]"));
	});

	test("undefined throw — falls back, never '[object Object]'", () => {
		const result = normalizeToError(undefined);
		assert.strictEqual(result.message, "Operation failed");
		assert.ok(!result.message.includes("[object Object]"));
	});

	test("non-string title is ignored (defensive against malformed responses)", () => {
		const raw = { title: 42, detail: "boom", status: 500 };
		const result = normalizeToError(raw);
		assert.strictEqual(result.message, "Operation failed: boom (status 500)");
	});

	test("non-number status is ignored (defensive against malformed responses)", () => {
		const raw = { title: "BAD_GATEWAY", status: "502" };
		const result = normalizeToError(raw);
		assert.strictEqual(result.message, "BAD_GATEWAY");
	});

	test("preserves the original value as `cause` so it remains inspectable under --verbose", () => {
		const raw = { title: "X", detail: "y", extra: { nested: true } };
		const result = normalizeToError(raw);
		assert.strictEqual(result.cause, raw);
	});
});
