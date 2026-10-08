/**
 * Unit tests for the migration report builder
 * (default-plugins/element-template/migration/report.ts)
 */

import assert from "node:assert";
import { describe, test } from "node:test";
import type { ElementValue } from "../../default-plugins/element-template/migration/element-values.ts";
import type { PlanFacts } from "../../default-plugins/element-template/migration/plan.ts";
import {
	buildReport,
	mergeFacts,
} from "../../default-plugins/element-template/migration/report.ts";
import type { MigrationTemplate } from "../../default-plugins/element-template/migration/types.ts";

function value(key: string, v: string): ElementValue {
	return { bindingType: "zeebe:input", key, value: v, isFeel: false };
}

function facts(partial: Partial<PlanFacts> = {}): PlanFacts {
	return {
		moved: [],
		set: [],
		notes: [],
		guardSkipped: [],
		templateSkipped: [],
		noMatch: [],
		feelSkipped: [],
		...partial,
	};
}

const oldTemplate: MigrationTemplate = {
	id: "old",
	version: 1,
	name: "Old",
	deprecated: true,
	groups: [{ id: "model", label: "Model" }],
	properties: [
		{
			label: "Maximum tokens",
			group: "model",
			binding: { type: "zeebe:input", name: "maxTokens" },
		},
		{
			label: "Provider",
			group: "model",
			choices: [{ name: "Azure OpenAI", value: "azure" }],
			binding: { type: "zeebe:input", name: "provider" },
		},
	],
};

const newTemplate: MigrationTemplate = {
	id: "new",
	version: 1,
	name: "New",
	groups: [{ id: "model", label: "Model" }],
	properties: [
		{
			label: "Provider",
			group: "model",
			choices: [{ name: "OpenAI", value: "openai" }],
			binding: { type: "zeebe:input", name: "provider" },
		},
		{
			label: "Effort",
			group: "model",
			binding: { type: "zeebe:input", name: "effort" },
		},
		{ type: "Hidden", binding: { type: "zeebe:input", name: "internal" } },
	],
};

describe("buildReport", () => {
	test("does not claim removed intermediate moves or static additions", () => {
		const report = buildReport({
			fromTemplate: oldTemplate,
			toTemplate: newTemplate,
			before: [value("maxTokens", "secret")],
			after: [],
			facts: facts({
				moved: [
					{
						from: { key: "maxTokens", bindingType: null },
						to: { key: "intermediate", bindingType: null },
						transformed: false,
					},
				],
				set: [{ key: "temporary", bindingType: null, value: "gone" }],
			}),
			usedRecipe: true,
			refusal: null,
		});
		assert.deepStrictEqual(report.moved, []);
		assert.deepStrictEqual(report.added, []);
		assert.strictEqual(report.dropped.length, 1);
		assert.strictEqual(report.lossless, false);
	});
	test("lists values the new template does not bind as dropped, with labels", () => {
		const report = buildReport({
			fromTemplate: oldTemplate,
			toTemplate: newTemplate,
			before: [value("maxTokens", "2000"), value("provider", "azure")],
			after: [value("provider", "openai")],
			facts: facts(),
			usedRecipe: false,
			refusal: null,
		});
		assert.deepStrictEqual(
			report.dropped.map((d) => [d.label, d.group, d.value]),
			[["Maximum tokens", "Model", "2000"]],
		);
		assert.strictEqual(report.lossless, false);
	});

	test("reports values the template brought as added, but not hidden ones", () => {
		const report = buildReport({
			fromTemplate: oldTemplate,
			toTemplate: newTemplate,
			before: [],
			after: [value("effort", "default"), value("internal", "x")],
			facts: facts(),
			usedRecipe: false,
			refusal: null,
		});
		assert.deepStrictEqual(
			report.added.map((a) => a.key),
			["effort"],
		);
	});

	test("reports a replaced value under the same key as changed, with choice names", () => {
		const report = buildReport({
			fromTemplate: oldTemplate,
			toTemplate: newTemplate,
			before: [value("provider", "azure")],
			after: [value("provider", "openai")],
			facts: facts(),
			usedRecipe: false,
			refusal: null,
		});
		assert.deepStrictEqual(report.changed[0].valueChange, {
			from: "azure",
			to: "openai",
			fromName: "Azure OpenAI",
			toName: "OpenAI",
		});
	});

	test("does not drop, add or change what a recipe moved", () => {
		const report = buildReport({
			fromTemplate: oldTemplate,
			toTemplate: newTemplate,
			before: [value("maxTokens", "2000")],
			after: [value("effort", "2000")],
			facts: facts({
				moved: [
					{
						from: { key: "maxTokens", bindingType: null },
						to: { key: "effort", bindingType: null },
						transformed: false,
					},
				],
			}),
			usedRecipe: true,
			refusal: null,
		});
		assert.deepStrictEqual(report.dropped, []);
		assert.deepStrictEqual(report.added, []);
		assert.strictEqual(report.moved.length, 1);
		assert.strictEqual(report.moved[0].from.label, "Maximum tokens");
		assert.strictEqual(report.moved[0].to.label, "Effort");
		assert.strictEqual(report.lossless, true);
	});

	test("shows the value change of a translated move", () => {
		const report = buildReport({
			fromTemplate: oldTemplate,
			toTemplate: newTemplate,
			before: [value("provider", "azure")],
			after: [value("provider", "openai")],
			facts: facts({
				moved: [
					{
						from: { key: "provider", bindingType: null },
						to: { key: "provider", bindingType: null },
						transformed: true,
					},
				],
			}),
			usedRecipe: true,
			refusal: null,
		});
		assert.strictEqual(report.moved[0].valueChange?.fromName, "Azure OpenAI");
		assert.strictEqual(report.moved[0].valueChange?.toName, "OpenAI");
		assert.deepStrictEqual(report.changed, []);
	});

	test("lists set values as added and carries notes", () => {
		const report = buildReport({
			fromTemplate: oldTemplate,
			toTemplate: newTemplate,
			before: [],
			after: [value("effort", "high")],
			facts: facts({
				set: [{ key: "effort", bindingType: null, value: "high" }],
				notes: [{ level: "warning", message: "careful" }],
			}),
			usedRecipe: true,
			refusal: null,
		});
		assert.deepStrictEqual(
			report.added.map((a) => [a.key, a.value]),
			[["effort", "high"]],
		);
		assert.deepStrictEqual(report.notes, [
			{ level: "warning", message: "careful" },
		]);
	});

	test("ignores empty source values when computing drops", () => {
		const report = buildReport({
			fromTemplate: oldTemplate,
			toTemplate: newTemplate,
			before: [value("maxTokens", "")],
			after: [],
			facts: facts(),
			usedRecipe: false,
			refusal: null,
		});
		assert.deepStrictEqual(report.dropped, []);
	});

	test("is not lossless when a guard skipped a populated value", () => {
		const report = buildReport({
			fromTemplate: oldTemplate,
			toTemplate: newTemplate,
			before: [],
			after: [],
			facts: facts({ guardSkipped: [{ from: "a", to: "b" }] }),
			usedRecipe: true,
			refusal: null,
		});
		assert.strictEqual(report.lossless, false);
	});
});

describe("mergeFacts", () => {
	test("chains a move across steps into one", () => {
		const merged = mergeFacts([
			facts({
				moved: [
					{
						from: { key: "a", bindingType: null },
						to: { key: "b", bindingType: null },
						transformed: false,
					},
				],
			}),
			facts({
				moved: [
					{
						from: { key: "b", bindingType: null },
						to: { key: "c", bindingType: null },
						transformed: true,
					},
				],
			}),
		]);
		assert.deepStrictEqual(
			merged.moved.map((m) => [m.from.key, m.to.key, m.transformed]),
			[["a", "c", true]],
		);
	});
});
