/**
 * Unit tests for the migration engine's binding and element-value helpers
 * (default-plugins/element-template/migration/)
 */

import assert from "node:assert";
import { describe, test } from "node:test";
import {
	bindingTargetKey,
	findExtensionContainers,
	findPropertiesByTarget,
	maybePrependFeel,
	resolveBindingTarget,
	splitBindingPrefix,
} from "../../default-plugins/element-template/migration/binding.ts";
import { enumerateElementValues } from "../../default-plugins/element-template/migration/element-values.ts";
import type { ModdleElement } from "../../default-plugins/element-template/migration/moddle.ts";

function moddle($type: string, props: Record<string, unknown>): ModdleElement {
	return { $type, ...props, get: (name: string) => props[name] };
}

function extensionElements(...values: ModdleElement[]): ModdleElement {
	return moddle("bpmn:ExtensionElements", { values });
}

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

describe("enumerateElementValues", () => {
	const ext = extensionElements(
		moddle("zeebe:IoMapping", {
			inputParameters: [
				moddle("zeebe:Input", { target: "url", source: "https://x" }),
				moddle("zeebe:Input", { target: "body", source: "=payload" }),
			],
			outputParameters: [
				moddle("zeebe:Output", { source: "=response", target: "result" }),
			],
		}),
		moddle("zeebe:TaskHeaders", {
			values: [moddle("zeebe:Header", { key: "k", value: "v" })],
		}),
		moddle("zeebe:TaskDefinition", { type: "io.example", retries: 3 }),
		moddle("zeebe:AgentDefinition", { agentType: "ai" }),
		moddle("zeebe:AdHoc", { outputCollection: "results" }),
	);

	test("reads values keyed by binding and flags FEEL values", () => {
		const values = enumerateElementValues(ext);
		const byKey = (type: string, key: string) =>
			values.find((v) => v.bindingType === type && v.key === key);
		assert.strictEqual(byKey("zeebe:input", "url")?.value, "https://x");
		assert.strictEqual(byKey("zeebe:input", "body")?.isFeel, true);
		assert.strictEqual(byKey("zeebe:output", "=response")?.value, "result");
		assert.strictEqual(byKey("zeebe:taskHeader", "k")?.value, "v");
		assert.strictEqual(byKey("zeebe:taskDefinition", "retries")?.value, "3");
		assert.strictEqual(
			byKey("zeebe:agentDefinition", "agentType")?.value,
			"ai",
		);
		assert.strictEqual(
			byKey("zeebe:adHoc", "outputCollection")?.value,
			"results",
		);
	});

	test("never reports the task definition type", () => {
		assert.ok(
			!enumerateElementValues(ext).some(
				(v) => v.bindingType === "zeebe:taskDefinition" && v.key === "type",
			),
		);
	});

	test("returns nothing for an element without extensions", () => {
		assert.deepStrictEqual(enumerateElementValues(undefined), []);
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
