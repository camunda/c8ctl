/**
 * Unit tests for reading element values off a BPMN extension tree
 * (default-plugins/element-template/migration/element-values.ts)
 */

import assert from "node:assert";
import { describe, test } from "node:test";
import {
	enumerateElementValues,
	getExtensionElements,
} from "../../default-plugins/element-template/migration/element-values.ts";
import { extensionElements, moddle } from "../utils/moddle.ts";

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

describe("getExtensionElements", () => {
	test("returns the extensionElements child", () => {
		const ext = extensionElements();
		assert.strictEqual(
			getExtensionElements(moddle("bpmn:Task", { extensionElements: ext })),
			ext,
		);
	});

	test("returns undefined when there is none or it is not a moddle element", () => {
		assert.strictEqual(
			getExtensionElements(moddle("bpmn:Task", {})),
			undefined,
		);
		assert.strictEqual(
			getExtensionElements(
				moddle("bpmn:Task", { extensionElements: "not an element" }),
			),
			undefined,
		);
	});
});
