/**
 * Unit tests for the migration report builder
 * (default-plugins/element-template/migration/report.ts)
 */

import assert from "node:assert";
import { describe, test } from "node:test";
import type { ElementValue } from "../../default-plugins/element-template/migration/element-values.ts";
import {
	buildReport,
	mergeFacts,
	type ReportFacts,
} from "../../default-plugins/element-template/migration/report.ts";
import type { MigrationTemplate } from "../../default-plugins/element-template/migration/types.ts";

function value(key: string, v: string): ElementValue {
	return { bindingType: "zeebe:input", key, value: v, isFeel: false };
}

function facts(partial: Partial<ReportFacts> = {}): ReportFacts {
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
	for (const actual of ["unrelated", ""]) {
		test(`does not claim an unresolved move to ${JSON.stringify(actual)}`, () => {
			const report = buildReport({
				fromTemplate: oldTemplate,
				toTemplate: newTemplate,
				before: [value("maxTokens", "secret")],
				after: [value("effort", actual)],
				facts: facts({
					moved: [
						{
							from: { key: "maxTokens", bindingType: "zeebe:input" },
							to: { key: "effort", bindingType: "zeebe:input" },
							transformed: false,
						},
					],
				}),
				usedRecipe: true,
				refusal: null,
			});
			assert.deepStrictEqual(report.moved, []);
			assert.deepStrictEqual(
				report.dropped.map((item) => item.value),
				["secret"],
			);
			assert.strictEqual(report.lossless, false);
		});
	}

	test("reports only the final static addition when several steps write the same field", () => {
		const report = buildReport({
			fromTemplate: oldTemplate,
			toTemplate: newTemplate,
			before: [],
			after: [value("effort", "final")],
			facts: mergeFacts([
				facts({
					set: [{ key: "effort", bindingType: "zeebe:input", value: "first" }],
				}),
				facts({
					set: [{ key: "effort", bindingType: "zeebe:input", value: "final" }],
				}),
			]),
			usedRecipe: true,
			refusal: null,
		});
		assert.deepStrictEqual(
			report.added.map((item) => item.value),
			["final"],
		);
		assert.strictEqual(report.lossless, true);
	});

	test("reports a mismatched static write as the actual change instead of an addition", () => {
		const report = buildReport({
			fromTemplate: oldTemplate,
			toTemplate: newTemplate,
			before: [value("provider", "azure")],
			after: [value("provider", "openai")],
			facts: facts({
				set: [
					{ key: "provider", bindingType: "zeebe:input", value: "expected" },
				],
			}),
			usedRecipe: true,
			refusal: null,
		});
		assert.deepStrictEqual(report.added, []);
		assert.strictEqual(report.changed[0]?.valueChange.to, "openai");
		assert.strictEqual(report.lossless, false);
	});
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
	for (const bindingType of ["zeebe:input", "zeebe:taskHeader"]) {
		for (const reverse of [false, true]) {
			test(`reads simultaneous moves from the step snapshot (${bindingType}, reverse=${reverse})`, () => {
				const moves = [
					{
						from: { key: "a", bindingType: "zeebe:input" },
						to: { key: "b", bindingType },
						transformed: false,
						value: "first",
					},
					{
						from: { key: "b", bindingType },
						to: { key: "c", bindingType: "zeebe:input" },
						transformed: false,
						value: "second",
					},
				];
				if (reverse) moves.reverse();
				const report = buildReport({
					fromTemplate: oldTemplate,
					toTemplate: newTemplate,
					before: [
						value("a", "first"),
						{ ...value("b", "second"), bindingType },
					],
					after: [
						{ ...value("b", "first"), bindingType },
						value("c", "second"),
					],
					facts: mergeFacts([facts({ moved: moves })]),
					usedRecipe: true,
					refusal: null,
				});
				assert.deepStrictEqual(
					report.moved.map((move) => [move.from.key, move.to.key]).sort(),
					[
						["a", "b"],
						["b", "c"],
					],
				);
				assert.deepStrictEqual(report.dropped, []);
				assert.strictEqual(report.lossless, true);
			});
		}
	}

	test("a rename replaces an older addition at its destination", () => {
		const merged = mergeFacts([
			facts({
				set: [{ key: "b", bindingType: "zeebe:input", value: "old" }],
				after: [value("a", "secret"), value("b", "old")],
			}),
			facts({
				moved: [
					{
						from: { key: "a", bindingType: "zeebe:input" },
						to: { key: "b", bindingType: "zeebe:input" },
						transformed: false,
						value: "secret",
					},
				],
				after: [value("b", "secret")],
			}),
		]);
		assert.deepStrictEqual(merged.set, []);
		assert.strictEqual(merged.failedWrites, false);
	});

	test("overwriting a move remains lossy when its original field still exists", () => {
		const report = buildReport({
			fromTemplate: oldTemplate,
			toTemplate: newTemplate,
			before: [value("a", "secret")],
			after: [value("a", "default"), value("b", "replacement")],
			facts: mergeFacts([
				facts({
					moved: [
						{
							from: { key: "a", bindingType: "zeebe:input" },
							to: { key: "b", bindingType: "zeebe:input" },
							transformed: false,
							value: "secret",
						},
					],
					after: [value("b", "secret")],
				}),
				facts({
					set: [{ key: "b", bindingType: "zeebe:input", value: "replacement" }],
					after: [value("a", "default"), value("b", "replacement")],
				}),
			]),
			usedRecipe: true,
			refusal: null,
		});
		assert.deepStrictEqual(report.moved, []);
		assert.strictEqual(report.lossless, false);
	});

	test("a forwarded addition replaces an older move to the same destination", () => {
		const merged = mergeFacts([
			facts({
				moved: [
					{
						from: { key: "a", bindingType: "zeebe:input" },
						to: { key: "c", bindingType: "zeebe:input" },
						transformed: false,
					},
				],
				set: [{ key: "b", bindingType: "zeebe:input", value: "secret" }],
			}),
			facts({
				moved: [
					{
						from: { key: "b", bindingType: "zeebe:input" },
						to: { key: "c", bindingType: "zeebe:input" },
						transformed: false,
					},
				],
			}),
		]);
		assert.deepStrictEqual(merged.moved, []);
		assert.deepStrictEqual(
			merged.set.map((write) => write.key),
			["c"],
		);
	});

	test("keeps different binding types independent when overwriting lineage", () => {
		const merged = mergeFacts([
			facts({
				moved: [
					{
						from: { key: "a", bindingType: "zeebe:input" },
						to: { key: "b", bindingType: "zeebe:input" },
						transformed: false,
					},
				],
			}),
			facts({
				set: [{ key: "b", bindingType: "zeebe:taskHeader", value: "header" }],
			}),
		]);
		assert.strictEqual(merged.moved.length, 1);
		assert.strictEqual(merged.set[0]?.bindingType, "zeebe:taskHeader");
	});

	test("forwards prior lineage before replacing its intermediate field in the same step", () => {
		const merged = mergeFacts([
			facts({
				moved: [
					{
						from: { key: "a", bindingType: "zeebe:input" },
						to: { key: "b", bindingType: "zeebe:input" },
						transformed: false,
					},
				],
			}),
			facts({
				moved: [
					{
						from: { key: "b", bindingType: "zeebe:input" },
						to: { key: "c", bindingType: "zeebe:input" },
						transformed: false,
					},
				],
				set: [{ key: "b", bindingType: "zeebe:input", value: "replacement" }],
			}),
		]);
		assert.deepStrictEqual(
			merged.moved.map((move) => [move.from.key, move.to.key]),
			[["a", "c"]],
		);
	});

	test("does not resurrect lineage when a removed destination is recreated later", () => {
		const merged = mergeFacts([
			{
				...facts({
					moved: [
						{
							from: { key: "a", bindingType: "zeebe:input" },
							to: { key: "b", bindingType: "zeebe:input" },
							transformed: false,
						},
					],
				}),
				after: [value("b", "secret")],
			},
			{ ...facts(), after: [] },
			{
				...facts(),
				after: [value("b", "secret")],
			},
		]);
		const report = buildReport({
			fromTemplate: oldTemplate,
			toTemplate: newTemplate,
			before: [value("a", "secret")],
			after: [value("b", "secret")],
			facts: merged,
			usedRecipe: true,
			refusal: null,
		});
		assert.deepStrictEqual(report.moved, []);
		assert.strictEqual(report.dropped[0]?.value, "secret");
		assert.strictEqual(report.lossless, false);
	});

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
