/**
 * Unit tests for the typed moddle accessors
 * (default-plugins/element-template/migration/moddle.ts)
 */

import assert from "node:assert";
import { describe, test } from "node:test";
import {
	getModdleElement,
	getModdleList,
	getModdleNumber,
	getModdleString,
	isModdleElement,
} from "../../default-plugins/element-template/migration/moddle.ts";
import { moddle } from "../utils/moddle.ts";

const WRONG_TYPES: [name: string, value: unknown][] = [
	["undefined", undefined],
	["null", null],
	["a number", 1],
	["a string", "text"],
	["a boolean", true],
	["a plain object", {}],
	["an object with a non-function get", { get: "x" }],
	["an array", []],
];

describe("isModdleElement", () => {
	test("accepts an object with a get function", () => {
		assert.strictEqual(isModdleElement(moddle("a:B", {})), true);
	});

	for (const [name, value] of WRONG_TYPES) {
		test(`rejects ${name}`, () => {
			assert.strictEqual(isModdleElement(value), false);
		});
	}
});

describe("getModdleString and getModdleNumber", () => {
	test("return the value of the matching type", () => {
		const element = moddle("a:B", { text: "x", count: 2 });
		assert.strictEqual(getModdleString(element, "text"), "x");
		assert.strictEqual(getModdleNumber(element, "count"), 2);
	});

	for (const [name, value] of WRONG_TYPES.filter(([n]) => n !== "a string")) {
		test(`getModdleString ignores ${name}`, () => {
			assert.strictEqual(
				getModdleString(moddle("a:B", { v: value }), "v"),
				undefined,
			);
		});
	}
	for (const [name, value] of WRONG_TYPES.filter(([n]) => n !== "a number")) {
		test(`getModdleNumber ignores ${name}`, () => {
			assert.strictEqual(
				getModdleNumber(moddle("a:B", { v: value }), "v"),
				undefined,
			);
		});
	}
});

describe("getModdleElement", () => {
	test("returns a moddle child and ignores anything else", () => {
		const child = moddle("a:C", {});
		assert.strictEqual(
			getModdleElement(moddle("a:B", { c: child }), "c"),
			child,
		);
		for (const [name, value] of WRONG_TYPES) {
			assert.strictEqual(
				getModdleElement(moddle("a:B", { c: value }), "c"),
				undefined,
				name,
			);
		}
	});
});

describe("getModdleList", () => {
	test("returns the moddle elements of a collection", () => {
		const a = moddle("a:C", {});
		const b = moddle("a:D", {});
		assert.deepStrictEqual(
			getModdleList(moddle("a:B", { list: [a, b] }), "list"),
			[a, b],
		);
	});

	test("drops entries that are not moddle elements", () => {
		const a = moddle("a:C", {});
		assert.deepStrictEqual(
			getModdleList(moddle("a:B", { list: [a, 1, "x", null, {}] }), "list"),
			[a],
		);
	});

	test("is empty for an absent element, a missing property or a non-array", () => {
		assert.deepStrictEqual(getModdleList(undefined, "list"), []);
		assert.deepStrictEqual(getModdleList(moddle("a:B", {}), "list"), []);
		assert.deepStrictEqual(
			getModdleList(moddle("a:B", { list: "x" }), "list"),
			[],
		);
	});
});
