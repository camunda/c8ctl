/**
 * Unit tests for the migration engine's binding and element-value helpers
 * (default-plugins/element-template/migration/)
 */

import assert from "node:assert";
import { describe, test } from "node:test";
import {
	bindingPath,
	bindingTargetKey,
	findExtensionContainers,
	findPropertiesByTarget,
	maybePrependFeel,
	resolveBindingTarget,
	splitBindingPrefix,
} from "../../default-plugins/element-template/migration/binding.ts";
import { extensionElements, moddle } from "../utils/moddle.ts";

describe("splitBindingPrefix", () => {
	test("splits a known prefix and leaves other colons alone", () => {
		assert.deepStrictEqual(splitBindingPrefix("input:a.b"), {
			bindingType: "zeebe:input",
			key: "a.b",
		});
		assert.deepStrictEqual(splitBindingPrefix("header:k"), {
			bindingType: "zeebe:taskHeader",
			key: "k",
		});
		assert.deepStrictEqual(splitBindingPrefix("urn:x"), {
			bindingType: null,
			key: "urn:x",
		});
		assert.deepStrictEqual(splitBindingPrefix("plain"), {
			bindingType: null,
			key: "plain",
		});
	});
});

describe("bindingTargetKey and findPropertiesByTarget", () => {
	const properties = [
		{ binding: { type: "zeebe:input", name: "url" } },
		{ binding: { type: "zeebe:taskHeader", key: "url" } },
		{ binding: { type: "zeebe:output", source: "= result" } },
		{ binding: { type: "zeebe:agentDefinition", property: "agentType" } },
		{ binding: { type: "unknown:thing", name: "x" } },
	];

	test("derives the key per binding type", () => {
		assert.deepStrictEqual(
			properties.map((p) => bindingTargetKey(p.binding)),
			["url", "url", "= result", "agentType", undefined],
		);
	});

	test("filters by binding type when given", () => {
		assert.strictEqual(
			findPropertiesByTarget(properties, "url", null).length,
			2,
		);
		assert.strictEqual(
			findPropertiesByTarget(properties, "url", "zeebe:taskHeader").length,
			1,
		);
	});
});

describe("maybePrependFeel", () => {
	test("prepends = only for feel: required values that lack it", () => {
		assert.strictEqual(maybePrependFeel({ feel: "required" }, "x"), "=x");
		assert.strictEqual(maybePrependFeel({ feel: "required" }, "=x"), "=x");
		assert.strictEqual(maybePrependFeel({ feel: "required" }, ""), "");
		assert.strictEqual(maybePrependFeel({ feel: "optional" }, "x"), "x");
		assert.strictEqual(maybePrependFeel({}, "x"), "x");
	});
});

describe("resolveBindingTarget", () => {
	const containers = findExtensionContainers(
		extensionElements(
			moddle("zeebe:IoMapping", {
				inputParameters: [
					moddle("zeebe:Input", { target: "url", source: "s" }),
				],
			}),
			moddle("zeebe:AdHoc", { outputCollection: "r" }),
		),
	);

	test("resolves existing entries and skips missing ones", () => {
		const input = resolveBindingTarget(
			{ type: "zeebe:input", name: "url" },
			containers,
		);
		assert.strictEqual(input?.property, "source");
		assert.strictEqual(
			resolveBindingTarget({ type: "zeebe:input", name: "nope" }, containers),
			undefined,
		);
		assert.strictEqual(
			resolveBindingTarget(
				{ type: "zeebe:adHoc", property: "outputCollection" },
				containers,
			)?.property,
			"outputCollection",
		);
		assert.strictEqual(
			resolveBindingTarget({ type: "zeebe:taskHeader", key: "k" }, containers),
			undefined,
		);
	});
});

describe("bindingPath", () => {
	for (const [bindingType, expected] of [
		["zeebe:input", "input:key"],
		["zeebe:output", "output:key"],
		["zeebe:taskHeader", "header:key"],
		["zeebe:property", "property:key"],
		["zeebe:taskDefinition", "taskDefinition:key"],
		["custom", "custom:key"],
	] as const) {
		test(`qualifies ${bindingType} as ${expected}`, () => {
			assert.strictEqual(bindingPath(bindingType, "key"), expected);
		});
	}

	// Pinned: an unknown binding type yields a path no recipe can address.
	for (const bindingType of [null, undefined]) {
		test(`a ${bindingType} binding type yields "undefined:key"`, () => {
			assert.strictEqual(bindingPath(bindingType, "key"), "undefined:key");
		});
	}
});
