/**
 * Unit tests for date-filter utilities
 */

import assert from "node:assert";
import { describe, test } from "node:test";
import { buildDateFilter, parseBetween } from "../../src/date-filter.ts";

describe("parseBetween", () => {
	test("parses full ISO 8601 datetime range", () => {
		const result = parseBetween("2024-01-01T00:00:00Z..2024-12-31T23:59:59Z");
		assert.ok(result);
		assert.strictEqual(result.from, "2024-01-01T00:00:00Z");
		assert.strictEqual(result.to, "2024-12-31T23:59:59Z");
	});

	test("expands short date from to start of day", () => {
		const result = parseBetween("2024-01-01..2024-03-31");
		assert.ok(result);
		assert.strictEqual(result.from, "2024-01-01T00:00:00.000Z");
		assert.strictEqual(result.to, "2024-03-31T23:59:59.999Z");
	});

	test("expands mixed short and full datetime", () => {
		const result = parseBetween("2024-01-01..2024-03-31T12:00:00Z");
		assert.ok(result);
		assert.strictEqual(result.from, "2024-01-01T00:00:00.000Z");
		assert.strictEqual(result.to, "2024-03-31T12:00:00Z");
	});

	test("returns null when separator is missing", () => {
		const result = parseBetween("2024-01-01 2024-12-31");
		assert.strictEqual(result, null);
	});

	test("returns null when both parts are empty", () => {
		const result = parseBetween("..");
		assert.strictEqual(result, null);
	});

	test("open-ended: parses ..to (no from)", () => {
		const result = parseBetween("..2024-12-31");
		assert.ok(result);
		assert.strictEqual(result.from, undefined);
		assert.strictEqual(result.to, "2024-12-31T23:59:59.999Z");
	});

	test("open-ended: parses from.. (no to)", () => {
		const result = parseBetween("2024-01-01..");
		assert.ok(result);
		assert.strictEqual(result.from, "2024-01-01T00:00:00.000Z");
		assert.strictEqual(result.to, undefined);
	});

	test("open-ended: parses ..to with ISO datetime", () => {
		const result = parseBetween("..2024-06-30T23:59:59Z");
		assert.ok(result);
		assert.strictEqual(result.from, undefined);
		assert.strictEqual(result.to, "2024-06-30T23:59:59Z");
	});

	test("open-ended: parses from.. with ISO datetime", () => {
		const result = parseBetween("2024-01-01T00:00:00Z..");
		assert.ok(result);
		assert.strictEqual(result.from, "2024-01-01T00:00:00Z");
		assert.strictEqual(result.to, undefined);
	});

	test("returns null for invalid date strings", () => {
		const result = parseBetween("not-a-date..2024-12-31");
		assert.strictEqual(result, null);
	});

	test("returns null for invalid ISO datetime", () => {
		const result = parseBetween("2024-13-01T00:00:00Z..2024-12-31T23:59:59Z");
		assert.strictEqual(result, null);
	});

	test("handles whitespace around separator", () => {
		const result = parseBetween("2024-01-01 .. 2024-12-31");
		assert.ok(result);
		assert.strictEqual(result.from, "2024-01-01T00:00:00.000Z");
		assert.strictEqual(result.to, "2024-12-31T23:59:59.999Z");
	});
});

describe("buildDateFilter", () => {
	test("builds $gte/$lte filter object", () => {
		const filter = buildDateFilter(
			"2024-01-01T00:00:00Z",
			"2024-12-31T23:59:59Z",
		);
		assert.deepStrictEqual(filter, {
			$gte: "2024-01-01T00:00:00Z",
			$lte: "2024-12-31T23:59:59Z",
		});
	});

	test("builds $lte-only filter when from is omitted", () => {
		const filter = buildDateFilter(undefined, "2024-12-31T23:59:59Z");
		assert.deepStrictEqual(filter, { $lte: "2024-12-31T23:59:59Z" });
	});

	test("builds $gte-only filter when to is omitted", () => {
		const filter = buildDateFilter("2024-01-01T00:00:00Z", undefined);
		assert.deepStrictEqual(filter, { $gte: "2024-01-01T00:00:00Z" });
	});
});
