/**
 * Unit tests for `sanitizeForLogging` in `src/logger.ts`.
 *
 * These tests intentionally import directly from `src/logger.ts` (not
 * `src/commands/**`) — `sanitizeForLogging` is a pure function in the
 * logger module, has no CLI surface of its own, and is exercised end-to-end
 * by the identity CLI tests via password-redaction assertions in
 * `identity-behaviour.test.ts`. Direct unit tests are kept here to:
 *
 *  - Lock in the credential-redaction allow/deny lists at the function
 *    boundary (e.g. password redacted, oAuthUrl preserved).
 *  - Guard against the defect *class* of "built-in instances are coerced
 *    to `{}`" that would silently strip Error.message / Date / URL etc.
 *
 * Previously lived in `tests/unit/identity.test.ts` as the "sanitizeForLogging"
 * suites; relocated here as part of the #341 migration off direct
 * `src/commands/**` imports (#291 boundary).
 */

import assert from "node:assert";
import { describe, test } from "node:test";
import { sanitizeForLogging } from "../../src/logger.ts";
import { asRecord } from "../utils/guards.ts";

describe("sanitizeForLogging — credential redaction", () => {
	test("redacts password from a flat object", () => {
		const result = asRecord(
			sanitizeForLogging({
				username: "alice",
				password: "secret",
			}),
		);
		assert.strictEqual(result.username, "alice");
		assert.strictEqual(result.password, "[REDACTED]");
	});

	test("redacts clientSecret from a nested body object", () => {
		const result = asRecord(
			sanitizeForLogging({
				config: { clientId: "id", clientSecret: "shhh" },
			}),
		);
		const config = asRecord(result.config);
		assert.strictEqual(config.clientId, "id");
		assert.strictEqual(config.clientSecret, "[REDACTED]");
	});

	test("does NOT redact oAuthUrl (it is a URL, not a credential)", () => {
		const url = "https://auth.example.com/oauth/token";
		const result = asRecord(sanitizeForLogging({ oAuthUrl: url }));
		assert.strictEqual(result.oAuthUrl, url);
	});

	test("does NOT redact authorizationKey (false positive — it is a resource identifier)", () => {
		const result = asRecord(sanitizeForLogging({ authorizationKey: "42" }));
		assert.strictEqual(result.authorizationKey, "42");
	});

	test("redacts password inside an array of objects", () => {
		const raw = sanitizeForLogging([
			{ user: "alice", password: "p1" },
			{ user: "bob", password: "p2" },
		]);
		assert.ok(Array.isArray(raw), "expected array result");
		const result = raw.map((x) => asRecord(x));
		assert.strictEqual(result[0].password, "[REDACTED]");
		assert.strictEqual(result[1].password, "[REDACTED]");
		assert.strictEqual(result[0].user, "alice");
	});

	test("passes primitives through unchanged", () => {
		assert.strictEqual(sanitizeForLogging("hello"), "hello");
		assert.strictEqual(sanitizeForLogging(42), 42);
		assert.strictEqual(sanitizeForLogging(null), null);
	});
});

// ─── Defect class: sanitizeForLogging must preserve built-in types ───────────
// sanitizeForLogging should not destroy Error, Date, URL, RegExp, or other
// common built-in instances by treating them as plain objects (which drops
// non-enumerable properties like Error.message or returns {} for Date).

describe("sanitizeForLogging — built-in type preservation", () => {
	test("preserves Error name, message, and stack", () => {
		const err = new Error("something broke");
		const result = asRecord(sanitizeForLogging(err));
		assert.strictEqual(result.name, "Error");
		assert.strictEqual(result.message, "something broke");
		assert.ok(
			typeof result.stack === "string" && result.stack.length > 0,
			"stack should be preserved",
		);
	});

	test("preserves nested Error in cause chain", () => {
		const inner = new Error("root cause");
		const outer = new Error("wrapper", { cause: inner });
		const result = asRecord(sanitizeForLogging(outer));
		assert.strictEqual(result.message, "wrapper");
		const causeResult = asRecord(result.cause);
		assert.strictEqual(causeResult.message, "root cause");
	});

	test("redacts sensitive fields on Error with enumerable credentials", () => {
		const err = new Error("auth failed");
		Object.assign(err, { password: "secret123" });
		const result = asRecord(sanitizeForLogging(err));
		assert.strictEqual(result.message, "auth failed");
		assert.strictEqual(result.password, "[REDACTED]");
	});

	test("preserves Date instances (does not return empty object)", () => {
		const date = new Date("2025-01-15T10:30:00Z");
		const result = sanitizeForLogging(date);
		// Should either return the Date as-is or a string representation — not {}
		assert.notDeepStrictEqual(
			result,
			{},
			"Date should not be serialized as empty object",
		);
	});

	test("preserves URL instances (does not return empty object)", () => {
		const url = new URL("https://example.com/path");
		const result = sanitizeForLogging(url);
		assert.notDeepStrictEqual(
			result,
			{},
			"URL should not be serialized as empty object",
		);
	});

	test("preserves RegExp instances", () => {
		const re = /test-pattern/gi;
		const result = sanitizeForLogging(re);
		assert.notDeepStrictEqual(
			result,
			{},
			"RegExp should not be serialized as empty object",
		);
	});
});
