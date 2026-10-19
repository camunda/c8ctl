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
						from: { key: "maxTokens", bindingType: "zeebe:input" },
						to: { key: "intermediate", bindingType: "zeebe:input" },
						transformed: false,
					},
				],
				set: [{ key: "temporary", bindingType: "zeebe:input", value: "gone" }],
			}),
			usedRecipe: true,
			refusal: null,
		});
		assert.deepStrictEqual(report.moved, []);
		assert.deepStrictEqual(report.added, []);
		assert.strictEqual(report.dropped.length, 1);
		assert.strictEqual(report.lossless, false);
	});
	test("a fact without a binding type matches the element value under any binding type", () => {
		// `sameTarget` (binding.ts) treats a null binding type as a wildcard.
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
		assert.strictEqual(report.moved.length, 1);
		assert.deepStrictEqual(report.dropped, []);
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
			report.dropped.map((d) => [d.label, d.groupLabel, d.value]),
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
						from: { key: "maxTokens", bindingType: "zeebe:input" },
						to: { key: "effort", bindingType: "zeebe:input" },
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
						from: { key: "provider", bindingType: "zeebe:input" },
						to: { key: "provider", bindingType: "zeebe:input" },
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

	test("reports a recipe set over a prior value as a recipe change", () => {
		const report = buildReport({
			fromTemplate: oldTemplate,
			toTemplate: newTemplate,
			before: [value("provider", "azure"), value("effort", "high")],
			after: [value("provider", "openai"), value("effort", "high")],
			facts: facts({
				set: [
					{ key: "provider", bindingType: "zeebe:input", value: "openai" },
					{ key: "effort", bindingType: "zeebe:input", value: "high" },
				],
			}),
			usedRecipe: true,
			refusal: null,
		});
		assert.deepStrictEqual(report.added, []);
		assert.deepStrictEqual(
			report.changed.map((c) => [c.key, c.valueChange.from, c.source]),
			[["provider", "azure", "recipe"]],
		);
		assert.deepStrictEqual(
			report.kept.map((k) => k.key),
			["effort"],
		);
		assert.deepStrictEqual(
			report.dropped.map((d) => [d.key, d.value, d.cause]),
			[["provider", "azure", "displaced"]],
		);
		assert.strictEqual(report.lossless, false);
	});

	test("lists set values as added and carries notes", () => {
		const report = buildReport({
			fromTemplate: oldTemplate,
			toTemplate: newTemplate,
			before: [],
			after: [value("effort", "high")],
			facts: facts({
				set: [{ key: "effort", bindingType: "zeebe:input", value: "high" }],
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

	test("chains a move across steps into one", () => {
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

describe("buildReport over merged facts", () => {
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
});

describe("buildReport lossless rules", () => {
	const losslessWith = (partial: Partial<ReportFacts>) =>
		buildReport({
			fromTemplate: oldTemplate,
			toTemplate: newTemplate,
			before: [value("maxTokens", "2000")],
			after: [value("maxTokens", "2000")],
			facts: facts(partial),
			usedRecipe: true,
			refusal: null,
		}).lossless;

	test("is lossless when nothing was skipped or failed", () => {
		assert.strictEqual(losslessWith({}), true);
	});

	const cases: [
		name: string,
		partial: Partial<ReportFacts>,
		lossless: boolean,
	][] = [
		[
			"a guard-skipped entry",
			{ guardSkipped: [{ from: "a", to: "b" }] },
			false,
		],
		[
			"a template entry with missing sources",
			{ templateSkipped: [{ to: "b", missing: ["a"] }] },
			false,
		],
		[
			"a value map without a matching rule",
			{ noMatch: [{ from: "a", to: "b" }] },
			false,
		],
		["a failed write", { failedWrites: true }, false],
		// Pinned: a FEEL expression moved as-is keeps its value, so it is not a loss.
		[
			"a FEEL expression moved as-is",
			{ feelSkipped: [{ from: "a", to: "b" }] },
			true,
		],
	];
	for (const [name, partial, lossless] of cases) {
		test(`${name} makes the report ${lossless ? "still lossless" : "lossy"}`, () => {
			assert.strictEqual(losslessWith(partial), lossless);
		});
	}
});

describe("buildReport unchecked bindings", () => {
	const correlationKey = {
		type: "bpmn:Message#zeebe:subscription#property",
		name: "correlationKey",
	};
	const withBinding = (
		id: string,
		properties: MigrationTemplate["properties"],
	): MigrationTemplate => ({ id, version: 1, properties });
	const reportFor = (target: MigrationTemplate["properties"]) =>
		buildReport({
			fromTemplate: withBinding("old", [
				{ id: "key", label: "Correlation key", binding: correlationKey },
				{
					type: "Hidden",
					value: "x",
					binding: { type: "zeebe:calledElement", property: "processId" },
				},
			]),
			toTemplate: withBinding("new", target),
			before: [],
			after: [],
			facts: facts(),
			usedRecipe: false,
			refusal: null,
		});

	test("an identical editable binding on the target keeps the value", () => {
		const report = reportFor([{ binding: { ...correlationKey } }]);
		assert.deepStrictEqual(report.skipped.unchecked, []);
		assert.strictEqual(report.lossless, true);
	});

	for (const [name, target] of [
		["a target without the binding", []],
		[
			"a target that binds it as Hidden",
			[{ type: "Hidden", binding: correlationKey }],
		],
	] as const) {
		test(`${name} makes the report lossy`, () => {
			const report = reportFor([...target]);
			assert.deepStrictEqual(report.skipped.unchecked, [
				{
					key: "correlationKey",
					bindingType: correlationKey.type,
					label: "Correlation key",
					propertyId: "key",
				},
			]);
			assert.strictEqual(report.lossless, false);
		});
	}
});

describe("buildReport item identity, values and sources", () => {
	const source: MigrationTemplate = {
		id: "source",
		version: 1,
		groups: [
			{ id: "connection", label: "Connection" },
			{ id: "model", label: "Model" },
		],
		properties: [
			{
				label: "Max",
				group: "model",
				binding: { type: "zeebe:input", name: "max" },
			},
			{
				label: "Url",
				group: "connection",
				binding: { type: "zeebe:input", name: "url" },
			},
		],
	};
	const target: MigrationTemplate = {
		id: "target",
		version: 1,
		groups: [
			{ id: "model", label: "Model" },
			{ id: "options", label: "Options" },
		],
		properties: [
			{
				type: "Hidden",
				value: "t",
				binding: { type: "zeebe:input", name: "hidden" },
			},
			{
				id: "limit",
				label: "Limit",
				group: "options",
				binding: { type: "zeebe:input", name: "limit" },
			},
			{ label: "Free", binding: { type: "zeebe:input", name: "free" } },
			{
				id: "effort",
				label: "Effort",
				group: "model",
				choices: [{ name: "default", value: "modelDefault" }],
				binding: { type: "zeebe:input", name: "effort" },
			},
			{
				id: "model",
				label: "Model",
				group: "model",
				binding: { type: "zeebe:input", name: "model" },
			},
			{
				label: "Api",
				group: "model",
				choices: [{ name: "Chat Completions", value: "completions" }],
				binding: { type: "zeebe:input", name: "api" },
			},
			{
				label: "Prompt",
				group: "options",
				binding: { type: "zeebe:input", name: "prompt" },
			},
			{
				label: "Mode",
				group: "options",
				binding: { type: "zeebe:input", name: "mode" },
			},
		],
	};
	const move = (from: string, to: string, extra = {}) => ({
		from: { key: from, bindingType: "zeebe:input" },
		to: { key: to, bindingType: "zeebe:input" },
		transformed: false,
		...extra,
	});
	const build = () =>
		buildReport({
			fromTemplate: source,
			toTemplate: target,
			before: [
				value("url", "https://x"),
				value("max", "=1024"),
				value("free", "f"),
				value("prompt", "hi"),
				value("mode", "a"),
				value("gone", "lost"),
				value("legacy", "kept"),
				value("hidden", "s"),
				value("empty", ""),
			],
			after: [
				value("hidden", "t"),
				value("free", "f"),
				value("legacy", "kept"),
				value("empty", ""),
				value("limit", "=1024"),
				value("model", "https://x"),
				value("prompt", "hi"),
				value("mode", "b"),
				value("api", "completions"),
				value("effort", "modelDefault"),
			],
			facts: facts({
				moved: [move("max", "limit"), move("url", "model", { map: true })],
				set: [{ key: "api", bindingType: "zeebe:input", value: "completions" }],
			}),
			usedRecipe: true,
			refusal: null,
		});

	test("reports group ID, group label and property ID, also when the label equals the group label", () => {
		const { moved } = build();
		assert.deepStrictEqual(
			moved.map((m) => m.to),
			[
				{
					key: "model",
					bindingType: "zeebe:input",
					label: "Model",
					group: "model",
					groupLabel: "Model",
					propertyId: "model",
				},
				{
					key: "limit",
					bindingType: "zeebe:input",
					label: "Limit",
					group: "options",
					groupLabel: "Options",
					propertyId: "limit",
				},
			],
		);
		assert.deepStrictEqual(moved[1].from, {
			key: "max",
			bindingType: "zeebe:input",
			label: "Max",
			group: "model",
			groupLabel: "Model",
		});
	});

	test("carries the stored value and source on every moved item", () => {
		assert.deepStrictEqual(
			build().moved.map((m) => [m.to.key, m.value, m.source, m.valueChange]),
			[
				["model", "https://x", "map", undefined],
				["limit", "=1024", "recipe", undefined],
			],
		);
	});

	test("tells recipe values from template defaults in added and changed", () => {
		const report = build();
		assert.deepStrictEqual(
			report.added.map((a) => [a.key, a.value, a.valueName, a.source]),
			[
				["effort", "modelDefault", "default", "default"],
				["api", "completions", "Chat Completions", "recipe"],
			],
		);
		assert.deepStrictEqual(
			report.changed.map((c) => [c.key, c.source]),
			[["mode", "default"]],
		);
	});

	test("lists unchanged, non-empty, non-hidden values as kept, without values", () => {
		assert.deepStrictEqual(build().kept, [
			{
				key: "prompt",
				bindingType: "zeebe:input",
				label: "Prompt",
				group: "options",
				groupLabel: "Options",
			},
			{ key: "free", bindingType: "zeebe:input", label: "Free" },
			{ key: "legacy", bindingType: "zeebe:input" },
		]);
	});

	test("orders dropped values by the source template", () => {
		const report = buildReport({
			fromTemplate: source,
			toTemplate: target,
			before: [value("other", "o"), value("max", "1"), value("url", "u")],
			after: [],
			facts: facts(),
			usedRecipe: false,
			refusal: null,
		});
		assert.deepStrictEqual(
			report.dropped.map((d) => d.key),
			["url", "max", "other"],
		);
	});
});

describe("buildReport: values lost to Hidden resets and displaced destinations", () => {
	const hidden = (template: MigrationTemplate, key: string) => ({
		...template,
		properties: [
			...template.properties.filter((p) => p.binding?.name !== key),
			{ type: "Hidden", binding: { type: "zeebe:input", name: key } },
		],
	});
	const move = (from: string, to: string) => ({
		from: { key: from, bindingType: "zeebe:input" },
		to: { key: to, bindingType: "zeebe:input" },
		transformed: false,
	});
	const report = ({
		fromTemplate = oldTemplate,
		toTemplate = newTemplate,
		before,
		after,
		moved = [],
	}: {
		fromTemplate?: MigrationTemplate;
		toTemplate?: MigrationTemplate;
		before: ElementValue[];
		after: ElementValue[];
		moved?: ReturnType<typeof move>[];
	}) =>
		buildReport({
			fromTemplate,
			toTemplate,
			before,
			after,
			facts: facts({ moved }),
			usedRecipe: moved.length > 0,
			refusal: null,
		});

	test("an editable value reset by a Hidden target property is lost", () => {
		const r = report({
			toTemplate: hidden(newTemplate, "provider"),
			before: [value("provider", "azure")],
			after: [value("provider", "fixed")],
		});
		assert.deepStrictEqual(
			r.dropped.map((d) => [d.key, d.value, d.cause]),
			[["provider", "azure", "hidden"]],
		);
		assert.strictEqual(r.lossless, false);
	});

	test("an editable value equal to the Hidden default is kept", () => {
		const r = report({
			toTemplate: hidden(newTemplate, "provider"),
			before: [value("provider", "fixed")],
			after: [value("provider", "fixed")],
		});
		assert.deepStrictEqual(r.dropped, []);
		assert.strictEqual(r.lossless, true);
	});

	test("a Hidden source value replaced by a new Hidden default is not lost", () => {
		const r = report({
			fromTemplate: hidden(oldTemplate, "provider"),
			toTemplate: hidden(newTemplate, "provider"),
			before: [value("provider", "v1-constant")],
			after: [value("provider", "v2-constant")],
		});
		assert.deepStrictEqual(r.dropped, []);
		assert.strictEqual(r.lossless, true);
	});

	test("an editable value moved away from a field that becomes Hidden is not lost", () => {
		const r = report({
			toTemplate: hidden(newTemplate, "provider"),
			before: [value("provider", "azure")],
			after: [value("provider", "fixed"), value("effort", "azure")],
			moved: [move("provider", "effort")],
		});
		assert.deepStrictEqual(r.dropped, []);
		assert.strictEqual(r.lossless, true);
	});

	test("a move over a populated destination loses the old value", () => {
		const r = report({
			before: [value("maxTokens", "2000"), value("effort", "high")],
			after: [value("effort", "2000")],
			moved: [move("maxTokens", "effort")],
		});
		assert.strictEqual(r.moved.length, 1);
		assert.deepStrictEqual(
			r.dropped.map((d) => [d.key, d.value, d.cause]),
			[["effort", "high", "displaced"]],
		);
		assert.strictEqual(r.lossless, false);
	});

	for (const [name, prior] of [
		["an empty", ""],
		["an equal", "2000"],
	] as const) {
		test(`a move over ${name} destination is lossless`, () => {
			const r = report({
				before: [value("maxTokens", "2000"), value("effort", prior)],
				after: [value("effort", "2000")],
				moved: [move("maxTokens", "effort")],
			});
			assert.deepStrictEqual(r.dropped, []);
			assert.strictEqual(r.lossless, true);
		});
	}

	test("a swap keeps both values", () => {
		const r = report({
			before: [value("provider", "azure"), value("effort", "high")],
			after: [value("provider", "high"), value("effort", "azure")],
			moved: [move("provider", "effort"), move("effort", "provider")],
		});
		assert.deepStrictEqual(r.dropped, []);
		assert.strictEqual(r.lossless, true);
	});

	test("a value displaced in an earlier step stays lost when a later step moves it on", () => {
		const r = buildReport({
			fromTemplate: oldTemplate,
			toTemplate: newTemplate,
			before: [value("a", "A"), value("b", "B")],
			after: [value("b", "A"), value("c", "A")],
			facts: mergeFacts([
				facts({
					moved: [{ ...move("a", "b"), value: "A" }],
					after: [value("b", "A")],
				}),
				facts({
					moved: [{ ...move("b", "c"), value: "A" }],
					after: [value("b", "A"), value("c", "A")],
				}),
			]),
			usedRecipe: true,
			refusal: null,
		});
		assert.deepStrictEqual(
			r.moved.map((m) => [m.from.key, m.to.key]),
			[["a", "c"]],
		);
		assert.deepStrictEqual(
			r.dropped.map((d) => [d.key, d.value, d.cause]),
			[["b", "B", "displaced"]],
		);
		assert.strictEqual(r.lossless, false);
	});

	const conditional = (type: string, value: string) => ({
		...(type === "Hidden" ? { type, value: "fixed" } : { label: "Provider" }),
		binding: { type: "zeebe:input", name: "provider" },
		condition: { property: "mode", equals: value },
	});
	for (const hiddenFirst of [true, false]) {
		const order = (hidden: object, editable: object) =>
			hiddenFirst ? [hidden, editable] : [editable, hidden];
		test(`a conditional Hidden target duplicate resets the value (Hidden first=${hiddenFirst})`, () => {
			const r = report({
				toTemplate: {
					...newTemplate,
					properties: order(
						conditional("Hidden", "on"),
						conditional("String", "off"),
					),
				},
				before: [value("provider", "azure")],
				after: [value("provider", "fixed")],
			});
			assert.deepStrictEqual(
				r.dropped.map((d) => [d.key, d.cause]),
				[["provider", "hidden"]],
			);
			assert.strictEqual(r.lossless, false);
		});
		test(`a conditional Hidden source duplicate does not hide an editable value (Hidden first=${hiddenFirst})`, () => {
			const r = report({
				fromTemplate: {
					...oldTemplate,
					properties: order(
						conditional("Hidden", "on"),
						conditional("String", "off"),
					),
				},
				toTemplate: hidden(newTemplate, "provider"),
				before: [value("provider", "azure")],
				after: [value("provider", "fixed")],
			});
			assert.deepStrictEqual(
				r.dropped.map((d) => [d.key, d.cause]),
				[["provider", "hidden"]],
			);
			assert.strictEqual(r.lossless, false);
		});
	}

	test("a later move of a field reset by a Hidden property does not claim the original value", () => {
		const target = hidden(
			{
				...newTemplate,
				properties: [
					...newTemplate.properties,
					{ label: "Copy", binding: { type: "zeebe:input", name: "copy" } },
				],
			},
			"region",
		);
		const r = buildReport({
			fromTemplate: oldTemplate,
			toTemplate: target,
			before: [value("region", "eu-custom")],
			after: [value("region", "fixed"), value("copy", "fixed")],
			facts: mergeFacts([
				facts({ after: [value("region", "fixed")] }),
				facts({
					moved: [{ ...move("region", "copy"), value: "fixed" }],
					after: [value("region", "fixed"), value("copy", "fixed")],
				}),
			]),
			usedRecipe: true,
			refusal: null,
		});
		assert.deepStrictEqual(
			r.dropped.map((d) => [d.key, d.value, d.cause]),
			[["region", "eu-custom", "hidden"]],
		);
		assert.strictEqual(r.lossless, false);
	});

	test("a stub source cannot prove a Hidden source, so a Hidden target change counts as lost", () => {
		const r = report({
			fromTemplate: { ...oldTemplate, properties: [] },
			toTemplate: hidden(newTemplate, "provider"),
			before: [value("provider", "azure")],
			after: [value("provider", "fixed")],
		});
		assert.deepStrictEqual(
			r.dropped.map((d) => [d.key, d.value, d.cause]),
			[["provider", "azure", "hidden"]],
		);
		assert.strictEqual(r.lossless, false);
	});

	for (const sourceHidden of [false, true]) {
		test(`an intermediate Hidden reset is ${sourceHidden ? "not " : ""}lost when the source is ${sourceHidden ? "" : "not "}Hidden`, () => {
			const r = buildReport({
				fromTemplate: sourceHidden
					? hidden(oldTemplate, "provider")
					: oldTemplate,
				toTemplate: newTemplate,
				before: [value("provider", "azure")],
				after: [value("provider", "fixed")],
				facts: mergeFacts([
					facts({
						after: [value("provider", "fixed")],
						reset: [
							{ key: "provider", bindingType: "zeebe:input", from: "azure" },
						],
					}),
				]),
				usedRecipe: true,
				refusal: null,
			});
			assert.deepStrictEqual(
				r.dropped.map((d) => [d.key, d.cause]),
				sourceHidden ? [] : [["provider", "hidden"]],
			);
			assert.strictEqual(r.lossless, sourceHidden);
		});
	}
});
