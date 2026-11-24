/**
 * Unit tests for server version comparison logic.
 *
 * The `meetsMinExtensionVersion` function determines whether a Camunda
 * gateway version string meets the minimum version (8.10+) required for
 * extended file extension support. This is the pure logic extracted from
 * `checkServerSupportsExtensions` so it can be tested without a live
 * server connection.
 *
 * Coverage:
 * - Versions below the threshold (8.9, 8.0, 7.x)
 * - Versions at the threshold (8.10.0)
 * - Versions above the threshold (8.11, 9.0, 9.1)
 * - Pre-release and snapshot suffixes
 * - Unparseable / empty strings → null
 */

import assert from "node:assert";
import { describe, test } from "node:test";
import {
	MIN_EXTENDED_EXTENSIONS_VERSION,
	meetsMinExtensionVersion,
} from "../../src/utils/command-local/deploy-version.ts";

describe("meetsMinExtensionVersion", () => {
	// ── Below threshold ──────────────────────────────────────────

	test("8.9.0 does not meet the minimum", () => {
		assert.strictEqual(meetsMinExtensionVersion("8.9.0"), false);
	});

	test("8.9.5 does not meet the minimum", () => {
		assert.strictEqual(meetsMinExtensionVersion("8.9.5"), false);
	});

	test("8.0.0 does not meet the minimum", () => {
		assert.strictEqual(meetsMinExtensionVersion("8.0.0"), false);
	});

	test("7.99.0 does not meet the minimum", () => {
		assert.strictEqual(meetsMinExtensionVersion("7.99.0"), false);
	});

	// ── At threshold ─────────────────────────────────────────────

	test("8.10.0 meets the minimum", () => {
		assert.strictEqual(meetsMinExtensionVersion("8.10.0"), true);
	});

	test("8.10 (no patch) meets the minimum", () => {
		assert.strictEqual(meetsMinExtensionVersion("8.10"), true);
	});

	test("8.10.0-alpha1 meets the minimum (pre-release suffix)", () => {
		assert.strictEqual(meetsMinExtensionVersion("8.10.0-alpha1"), true);
	});

	test("8.10-SNAPSHOT meets the minimum (snapshot suffix)", () => {
		assert.strictEqual(meetsMinExtensionVersion("8.10-SNAPSHOT"), true);
	});

	// ── Above threshold ──────────────────────────────────────────

	test("8.11.0 meets the minimum", () => {
		assert.strictEqual(meetsMinExtensionVersion("8.11.0"), true);
	});

	test("8.99.0 meets the minimum", () => {
		assert.strictEqual(meetsMinExtensionVersion("8.99.0"), true);
	});

	test("9.0.0 meets the minimum (next major)", () => {
		assert.strictEqual(meetsMinExtensionVersion("9.0.0"), true);
	});

	test("9.1.0 meets the minimum", () => {
		assert.strictEqual(meetsMinExtensionVersion("9.1.0"), true);
	});

	test("10.0.0 meets the minimum", () => {
		assert.strictEqual(meetsMinExtensionVersion("10.0.0"), true);
	});

	// ── Pre-release below threshold ──────────────────────────────

	test("8.9.0-alpha1 does not meet the minimum", () => {
		assert.strictEqual(meetsMinExtensionVersion("8.9.0-alpha1"), false);
	});

	test("8.9-SNAPSHOT does not meet the minimum", () => {
		assert.strictEqual(meetsMinExtensionVersion("8.9-SNAPSHOT"), false);
	});

	// ── Unparseable strings ──────────────────────────────────────

	test("empty string returns null", () => {
		assert.strictEqual(meetsMinExtensionVersion(""), null);
	});

	test("non-numeric string returns null", () => {
		assert.strictEqual(meetsMinExtensionVersion("unknown"), null);
	});

	test("single number without dot returns null", () => {
		assert.strictEqual(meetsMinExtensionVersion("8"), null);
	});
});

describe("MIN_EXTENDED_EXTENSIONS_VERSION", () => {
	test("is [8, 10]", () => {
		assert.deepStrictEqual(MIN_EXTENDED_EXTENSIONS_VERSION, [8, 10]);
	});
});
