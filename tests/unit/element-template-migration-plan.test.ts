/**
 * Unit tests for resolving a recipe source against element values
 * (default-plugins/element-template/migration/plan.ts)
 */

import assert from "node:assert";
import { describe, test } from "node:test";
import type { ElementValue } from "../../default-plugins/element-template/migration/element-values.ts";
import {
	buildStepPlan,
	CARRY_OVER_LABEL,
	carryOverWrites,
	normalizeDestinationValue,
	validateDestinationValues,
	validateTargets,
} from "../../default-plugins/element-template/migration/plan.ts";
import { parseRecipe } from "../../default-plugins/element-template/migration/recipe.ts";
import type { MigrationTemplate } from "../../default-plugins/element-template/migration/types.ts";

function input(key: string, value: string): ElementValue {
	return {
		bindingType: "zeebe:input",
		key,
		value,
		isFeel: value.startsWith("="),
	};
}

function entriesOf(...paths: unknown[]) {
	const [source] = parseRecipe({
		schemaVersion: 1,
		sources: [{ kind: "change", sourceTemplateId: "old", paths }],
	}).sources;
	return source.entries;
}

describe("buildStepPlan", () => {
	test("shares active-property identity with apply and normalizes upstream typed FEEL storage", () => {
		for (const bindingType of [
			"zeebe:input",
			"zeebe:output",
			"zeebe:taskHeader",
		]) {
			for (const feel of [undefined, "static", "optional", "required"]) {
				for (const type of ["String", "Number", "Boolean"]) {
					const property = { type, feel, binding: { type: bindingType } };
					const cast =
						feel === "required" ||
						(type !== "String" &&
							(feel !== undefined || bindingType !== "zeebe:taskHeader"));
					const value = type === "Boolean" ? "false" : "2";
					assert.strictEqual(
						normalizeDestinationValue(property, value),
						cast ? `=${value}` : value,
					);
					assert.strictEqual(
						normalizeDestinationValue(property, "=expr"),
						"=expr",
					);
				}
			}
		}
		const active = {
			type: "String",
			binding: { type: "zeebe:input", name: "b" },
		};
		const inactive = {
			...active,
			condition: { property: "missing", isActive: true },
		};
		const target = { id: "new", properties: [inactive, active] };
		const plan = buildStepPlan(
			entriesOf({ to: "b", set: "allowed" }),
			[],
			target,
		);
		assert.deepStrictEqual(
			validateDestinationValues(plan.writes, [], target),
			new Set([active]),
		);
	});
	test("matches condition values with upstream Number, Boolean and required FEEL coercion", () => {
		for (const discriminator of [
			{ type: "Number", value: 2, equals: "=2" },
			{ type: "Boolean", value: true, equals: true },
			{ type: "Boolean", value: false, equals: false },
			{ type: "String", feel: "required", value: "=on", equals: "on" },
		]) {
			const target = {
				id: "new",
				properties: [
					{
						...discriminator,
						id: "mode",
						binding: { type: "zeebe:input", name: "mode" },
					},
					{
						condition: { property: "mode", equals: discriminator.equals },
						constraints: { notEmpty: true },
						binding: { type: "zeebe:input", name: "b" },
					},
				],
			};
			assert.throws(
				() => buildStepPlan(entriesOf({ to: "b", set: "" }), [], target),
				/notEmpty/,
			);
		}
	});

	test("does not treat a static leading equals sign as an empty expression", () => {
		assert.doesNotThrow(() =>
			buildStepPlan(entriesOf({ to: "b", set: "=" }), [], {
				id: "new",
				properties: [
					{
						constraints: { notEmpty: true },
						binding: { type: "zeebe:input", name: "b" },
					},
				],
			}),
		);
	});

	test("validates every simultaneously active duplicate and skips all inactive duplicates", () => {
		const target = {
			id: "new",
			properties: [
				{
					constraints: { notEmpty: true },
					binding: { type: "zeebe:input", name: "b" },
				},
				{
					constraints: { pattern: { value: "^allowed$" } },
					binding: { type: "zeebe:input", name: "b" },
				},
			],
		};
		assert.throws(
			() => buildStepPlan(entriesOf({ to: "b", set: "other" }), [], target),
			/pattern/,
		);
		assert.doesNotThrow(() =>
			buildStepPlan(entriesOf({ to: "b", set: "" }), [], {
				...target,
				properties: target.properties.map((p) => ({
					...p,
					condition: { property: "missing", isActive: true },
				})),
			}),
		);
	});
	test("validates only active duplicate properties using all resolved discriminator writes", () => {
		const target = {
			id: "new",
			properties: [
				{
					id: "mode",
					value: "off",
					binding: { type: "zeebe:input", name: "mode" },
				},
				{
					condition: { property: "mode", equals: "on" },
					choices: [{ value: "allowed" }],
					binding: { type: "zeebe:input", name: "b" },
				},
				{
					condition: { property: "mode", equals: "off" },
					constraints: { pattern: { value: "^other$" } },
					binding: { type: "zeebe:input", name: "b" },
				},
			],
		};
		const paths = [
			{ to: "b", set: "allowed" },
			{ to: "mode", set: "on" },
		];
		for (const ordered of [paths, [...paths].reverse()]) {
			assert.doesNotThrow(() =>
				buildStepPlan(entriesOf(...ordered), [], target),
			);
			assert.throws(
				() =>
					buildStepPlan(
						entriesOf(
							...ordered.map((p) =>
								p.to === "b" ? { ...p, set: "SECRET" } : p,
							),
						),
						[],
						target,
					),
				/input:b.*choice/,
			);
		}
	});

	test("validates populated non-Hidden carry-over values without adding recipe facts", () => {
		for (const property of [
			{ constraints: { notEmpty: true }, value: "   " },
			{ choices: [{ value: "allowed" }], value: "SECRET" },
			{ constraints: { pattern: { value: "^allowed$" } }, value: "SECRET" },
		]) {
			const target = {
				id: "new",
				properties: [
					{
						...property,
						type: "String",
						binding: { type: "zeebe:input", name: "b" },
					},
				],
			};
			assert.throws(
				() => buildStepPlan([], [input("b", property.value)], target),
				(error) =>
					error instanceof Error &&
					/carry-over.*input:b.*constraint/.test(error.message) &&
					!error.message.includes("SECRET"),
			);
			assert.doesNotThrow(() =>
				buildStepPlan(
					entriesOf({ to: "b", set: "allowed" }),
					[input("b", property.value)],
					target,
				),
			);
			assert.doesNotThrow(() =>
				buildStepPlan([], [input("b", property.value)], {
					...target,
					properties: target.properties.map((p) => ({ ...p, type: "Hidden" })),
				}),
			);
		}
		const plan = buildStepPlan([], [input("b", "allowed")], {
			id: "new",
			properties: [{ binding: { type: "zeebe:input", name: "b" } }],
		});
		assert.deepStrictEqual(plan.writes, []);
		assert.deepStrictEqual(plan.facts.set, []);
	});

	test("uses defaults, qualified carry-over, allMatch, oneOf, isEmpty and recursive isActive conditions", () => {
		const target = {
			id: "new",
			properties: [
				{
					id: "mode",
					value: "on",
					binding: { type: "zeebe:input", name: "mode" },
				},
				{
					id: "gate",
					condition: { property: "mode", oneOf: ["on"] },
					binding: { type: "zeebe:input", name: "gate" },
				},
				{
					condition: {
						allMatch: [
							{ property: "gate", isActive: true },
							{ property: "gate", isEmpty: true },
						],
					},
					constraints: { notEmpty: true },
					binding: { type: "zeebe:input", name: "b" },
				},
			],
		};
		assert.throws(
			() => buildStepPlan(entriesOf({ to: "b", set: "" }), [], target),
			/notEmpty/,
		);
		assert.doesNotThrow(() =>
			buildStepPlan(
				entriesOf({ to: "b", set: "" }),
				[
					input("mode", "off"),
					{ ...input("mode", "on"), bindingType: "zeebe:taskHeader" },
				],
				target,
			),
		);
		assert.doesNotThrow(() =>
			buildStepPlan(
				entriesOf({ to: "b", set: "" }, { to: "gate", set: "populated" }),
				[],
				target,
			),
		);
	});

	test("rejects empty FEEL bodies but bypasses literal choices and patterns for expressions", () => {
		for (const feel of ["optional", "required"]) {
			const target = {
				id: "new",
				properties: [
					{
						feel,
						constraints: { notEmpty: true, pattern: { value: "^allowed$" } },
						choices: [{ value: "allowed" }],
						binding: { type: "zeebe:input", name: "b" },
					},
				],
			};
			assert.doesNotThrow(() =>
				buildStepPlan(
					entriesOf({ to: "b", set: "=secretVariable" }),
					[],
					target,
				),
			);
			for (const value of ["", " ", "=", "=   "])
				assert.throws(
					() => buildStepPlan(entriesOf({ to: "b", set: value }), [], target),
					/notEmpty/,
				);
		}
		assert.throws(
			() =>
				buildStepPlan(entriesOf({ to: "b", set: "=expr" }), [], {
					id: "new",
					properties: [
						{
							choices: [{ value: "allowed" }],
							binding: { type: "zeebe:input", name: "b" },
						},
					],
				}),
			/choice/,
		);
	});

	test("identifies entries and qualified destinations while sanitizing invalid pattern diagnostics", () => {
		const entries = entriesOf({ to: "b", set: "SECRET" });
		assert.throws(
			() =>
				buildStepPlan(entries, [], {
					id: "new",
					properties: [
						{
							constraints: { pattern: { value: "[SECRET", message: "SECRET" } },
							binding: { type: "zeebe:input", name: "b" },
						},
					],
				}),
			(error) =>
				error instanceof Error &&
				error.message.includes(entries[0].label) &&
				/input:b.*pattern/.test(error.message) &&
				!error.message.includes("SECRET"),
		);
	});

	test("explicitly rejects unsupported active constraints, including for FEEL and carry-over", () => {
		for (const constraints of [
			{ minLength: 1 },
			{ maxLength: 2 },
			{ custom: true },
		]) {
			const target = {
				id: "new",
				properties: [
					{
						feel: "optional",
						constraints,
						binding: { type: "zeebe:input", name: "b" },
					},
				],
			};
			assert.throws(
				() => buildStepPlan(entriesOf({ to: "b", set: "=expr" }), [], target),
				/unsupported constraint/,
			);
			assert.throws(
				() => buildStepPlan([], [input("b", "SECRET")], target),
				/unsupported constraint/,
			);
			assert.doesNotThrow(() =>
				buildStepPlan(entriesOf({ to: "b", set: "SECRET" }), [], {
					...target,
					properties: [
						{
							...target.properties[0],
							...{ condition: { property: "missing", isActive: true } },
						},
					],
				}),
			);
		}
	});

	test("validates mapped and composed values against active constraints", () => {
		const target = {
			id: "new",
			properties: [
				{
					choices: [{ value: "allowed" }],
					binding: { type: "zeebe:input", name: "b" },
				},
			],
		};
		for (const path of [
			{
				from: "a",
				to: "b",
				valueMap: { rules: [{ match: "*", value: "SECRET" }] },
			},
			{ to: "b", template: `\${a}` },
		])
			assert.throws(
				() => buildStepPlan(entriesOf(path), [input("a", "SECRET")], target),
				/choice/,
			);
	});

	test("fails closed on unsupported and cyclic destination conditions", () => {
		for (const condition of [
			{ property: "b", custom: true },
			{ property: "b", isActive: true },
		]) {
			const target: MigrationTemplate = {
				id: "new",
				properties: [
					{
						id: "b",
						...{ condition },
						binding: { type: "zeebe:input", name: "b" },
					},
				],
			};
			assert.throws(
				() => buildStepPlan(entriesOf({ to: "b", set: "SECRET" }), [], target),
				/condition/,
			);
		}
	});
	test("validates required, choice and pattern destination values without echoing them", () => {
		for (const property of [
			{ constraints: { notEmpty: true }, value: "" },
			{ choices: [{ name: "Allowed", value: "allowed" }], value: "SECRET" },
			{ constraints: { pattern: { value: "^allowed$" } }, value: "SECRET" },
		]) {
			const target = {
				id: "new",
				properties: [
					{
						...property,
						type: "String",
						binding: { type: "zeebe:input", name: "b" },
					},
				],
			};
			assert.throws(
				() =>
					buildStepPlan(
						entriesOf({ to: "b", set: property.value }),
						[],
						target,
					),
				(error) =>
					error instanceof Error &&
					/destination|constraint|choice|pattern/.test(error.message) &&
					!error.message.includes("SECRET"),
			);
		}
	});
	test("rejects ambiguous rename, guard and interpolation reads and duplicate backing values", () => {
		const values = [
			input("key", "INPUT"),
			{ ...input("key", "HEADER"), bindingType: "zeebe:taskHeader" },
		];
		for (const path of [
			{ from: "key", to: "b" },
			{ to: "b", set: "x", when: { path: "key", exists: true } },
			{ to: "b", template: `\${key}` },
		]) {
			assert.throws(
				() => buildStepPlan(entriesOf(path), values),
				/Ambiguous source.*input:key.*header:key/,
			);
		}
		assert.throws(
			() =>
				buildStepPlan(entriesOf({ from: "input:key", to: "b" }), [
					input("key", "one"),
					input("key", "two"),
				]),
			/Duplicate source/,
		);
	});
	test("renames a value and reports the move", () => {
		const plan = buildStepPlan(entriesOf({ from: "a", to: "b" }), [
			input("a", "1"),
		]);
		assert.deepStrictEqual(
			plan.writes.map((w) => [w.key, w.value]),
			[["b", "1"]],
		);
		assert.deepStrictEqual(plan.facts.moved[0].from, {
			key: "a",
			bindingType: "zeebe:input",
		});
		assert.strictEqual(plan.facts.moved[0].transformed, false);
	});

	test("skips a rename whose source value is absent", () => {
		const plan = buildStepPlan(entriesOf({ from: "a", to: "b" }), []);
		assert.deepStrictEqual(plan.writes, []);
		assert.deepStrictEqual(plan.facts.moved, []);
	});

	test("translates values with a value map and its default", () => {
		const entries = entriesOf({
			from: "flag",
			to: "format",
			valueMap: {
				rules: [{ match: "true", value: "DOCUMENT" }],
				default: "JSON",
			},
		});
		assert.strictEqual(
			buildStepPlan(entries, [input("flag", "true")]).writes[0].value,
			"DOCUMENT",
		);
		const other = buildStepPlan(entries, [input("flag", "false")]);
		assert.strictEqual(other.writes[0].value, "JSON");
		assert.strictEqual(other.facts.moved[0].transformed, true);
	});

	test("reports a value map without a match and keeps the target default", () => {
		const plan = buildStepPlan(
			entriesOf({
				from: "a",
				to: "b",
				valueMap: { rules: [{ match: "x", value: "y" }] },
			}),
			[input("a", "other")],
		);
		assert.deepStrictEqual(plan.writes, []);
		assert.deepStrictEqual(plan.facts.noMatch, [{ from: "a", to: "b" }]);
	});

	test("moves a FEEL expression as-is and reports the skipped value map", () => {
		const plan = buildStepPlan(
			entriesOf({
				from: "a",
				to: "b",
				valueMap: { rules: [{ match: "x", value: "y" }] },
			}),
			[input("a", "=expr")],
		);
		assert.strictEqual(plan.writes[0].value, "=expr");
		assert.deepStrictEqual(plan.facts.feelSkipped, [{ from: "a", to: "b" }]);
	});

	test("matches value map rules with a * glob", () => {
		const plan = buildStepPlan(
			entriesOf({
				from: "m",
				to: "n",
				valueMap: { rules: [{ match: "claude-*", value: "anthropic" }] },
			}),
			[input("m", "claude-3")],
		);
		assert.strictEqual(plan.writes[0].value, "anthropic");
	});

	test("writes a static value only when its guard holds", () => {
		const entries = entriesOf({
			to: "backend",
			set: "foundry",
			when: { path: "type", equals: "azure" },
		});
		assert.strictEqual(
			buildStepPlan(entries, [input("type", "azure")]).writes.length,
			1,
		);
		assert.strictEqual(
			buildStepPlan(entries, [input("type", "other")]).writes.length,
			0,
		);
	});

	test("composes a template value and skips it when a reference is missing", () => {
		const entries = entriesOf({ to: "url", template: `\${host}/\${path}` });
		assert.strictEqual(
			buildStepPlan(entries, [input("host", "h"), input("path", "p")]).writes[0]
				.value,
			"h/p",
		);
		const plan = buildStepPlan(entries, [input("host", "h")]);
		assert.deepStrictEqual(plan.writes, []);
		assert.deepStrictEqual(plan.facts.templateSkipped, [
			{ to: "url", missing: ["path"] },
		]);
	});

	test("applies group guards to every nested entry", () => {
		const entries = entriesOf({
			when: { path: "type", equals: "bedrock" },
			rules: [{ from: "region", to: "aws.region" }],
		});
		assert.strictEqual(
			buildStepPlan(entries, [input("type", "bedrock"), input("region", "eu")])
				.writes.length,
			1,
		);
		const skipped = buildStepPlan(entries, [
			input("type", "azure"),
			input("region", "eu"),
		]);
		assert.strictEqual(skipped.writes.length, 0);
		assert.deepStrictEqual(skipped.facts.guardSkipped, [
			{ from: "region", to: "aws.region" },
		]);
	});

	test("evaluates in, matches, not and exists guards", () => {
		const run = (when: unknown, values: ElementValue[]) =>
			buildStepPlan(entriesOf({ to: "x", set: "1", when }), values).writes
				.length;
		assert.strictEqual(
			run({ path: "p", in: ["a", "b"] }, [input("p", "b")]),
			1,
		);
		assert.strictEqual(
			run({ path: "p", in: ["a"], not: true }, [input("p", "b")]),
			1,
		);
		assert.strictEqual(
			run({ path: "p", matches: "pre*" }, [input("p", "prefix")]),
			1,
		);
		assert.strictEqual(run({ path: "p", exists: false }, []), 1);
		assert.strictEqual(run({ path: "p", exists: true }, []), 0);
	});

	test("honours a binding-type prefix when reading the source", () => {
		const header: ElementValue = {
			bindingType: "zeebe:taskHeader",
			key: "k",
			value: "h",
			isFeel: false,
		};
		const plan = buildStepPlan(entriesOf({ from: "input:k", to: "z" }), [
			header,
			input("k", "i"),
		]);
		assert.strictEqual(plan.writes[0].value, "i");
	});

	test("collects the notes of entries that took effect only", () => {
		const entries = entriesOf(
			{ from: "a", to: "b", note: "moved a" },
			{ from: "missing", to: "c", note: "never shown" },
			{ to: "d", set: "1", note: { level: "warning", message: "set d" } },
		);
		const plan = buildStepPlan(entries, [input("a", "1")]);
		assert.deepStrictEqual(plan.facts.notes, [
			{ level: "info", message: "moved a" },
			{ level: "warning", message: "set d" },
		]);
	});

	test("refuses two active writes to the same target", () => {
		assert.throws(
			() =>
				buildStepPlan(
					entriesOf({ from: "a", to: "t" }, { to: "t", set: "1" }),
					[input("a", "1")],
				),
			/Ambiguous migration/,
		);
	});
	test("rejects qualified and unqualified writes to the same resolved binding", () => {
		const paths = [
			{ from: "a", to: "b" },
			{ to: "input:b", set: "overwrite" },
		];
		const target = {
			id: "new",
			properties: [{ binding: { type: "zeebe:input", name: "b" } }],
		};
		for (const ordered of [paths, [...paths].reverse()]) {
			assert.throws(
				() =>
					buildStepPlan(entriesOf(...ordered), [input("a", "secret")], target),
				/Ambiguous migration/,
			);
		}
	});
});

describe("validateTargets", () => {
	const template = {
		id: "new",
		version: 1,
		properties: [
			{ binding: { type: "zeebe:input", name: "b" } },
			{ binding: { type: "zeebe:input", name: "dup" } },
			{ binding: { type: "zeebe:taskHeader", key: "dup" } },
		],
	};

	test("accepts targets the template binds", () => {
		validateTargets(entriesOf({ from: "a", to: "b" }), template);
	});

	test("rejects an unbound target", () => {
		assert.throws(
			() => validateTargets(entriesOf({ from: "a", to: "nope" }), template),
			/not a binding in template new@1/,
		);
	});

	test("rejects a target bound by several types unless prefixed", () => {
		assert.throws(
			() => validateTargets(entriesOf({ from: "a", to: "dup" }), template),
			/several binding types/,
		);
		validateTargets(entriesOf({ from: "a", to: "input:dup" }), template);
	});
});

describe("carryOverWrites", () => {
	const target = {
		id: "new",
		properties: [
			{ type: "String", binding: { type: "zeebe:input", name: "b" } },
			{ type: "Hidden", binding: { type: "zeebe:input", name: "h" } },
		],
	};

	test("returns one write per populated duplicate, checked against recipe writes only", () => {
		const writes = carryOverWrites(
			[],
			[input("b", "first"), input("b", "second"), input("c", "x")],
			target,
		);
		assert.deepStrictEqual(
			writes.map((w) => [w.key, w.value, w.entry.label]),
			[
				["b", "first", CARRY_OVER_LABEL],
				["b", "second", CARRY_OVER_LABEL],
			],
		);
	});

	test("skips recipe-written, empty and Hidden-only targets", () => {
		const recipe = buildStepPlan(
			entriesOf({ to: "input:b", set: "recipe" }),
			[],
		).writes;
		assert.deepStrictEqual(
			carryOverWrites(
				recipe,
				[input("b", "first"), input("b", "second"), input("h", "x")],
				target,
			),
			[],
		);
		assert.deepStrictEqual(carryOverWrites([], [input("b", "")], target), []);
	});
});

describe("validateDestinationValues static Number and Boolean values", () => {
	function templateOf(
		...properties: MigrationTemplate["properties"]
	): MigrationTemplate {
		return {
			id: "new",
			properties: properties.map((p) => ({
				binding: { type: "zeebe:input", name: "b" },
				...p,
			})),
		};
	}
	const numberPattern = {
		type: "Number",
		feel: "static",
		constraints: { notEmpty: true, pattern: { value: "^\\d+$" } },
	};

	test("validates the literal of a carried-over FEEL-stored value", () => {
		const target = templateOf(numberPattern);
		const sources = [input("b", "=20")];
		assert.doesNotThrow(() => validateDestinationValues([], sources, target));
		assert.deepStrictEqual(
			carryOverWrites([], sources, target).map((w) => w.value),
			["=20"],
		);
	});

	test("treats a missing feel on an input binding as static", () => {
		const target = templateOf({ ...numberPattern, feel: undefined });
		assert.doesNotThrow(() =>
			validateDestinationValues([], [input("b", "=20")], target),
		);
	});

	test("still rejects a literal that violates the pattern", () => {
		assert.throws(
			() =>
				validateDestinationValues(
					[],
					[input("b", "=abc")],
					templateOf(numberPattern),
				),
			/violates pattern constraint/,
		);
	});

	test("keeps skipping the pattern for optional FEEL expressions", () => {
		assert.doesNotThrow(() =>
			validateDestinationValues(
				[],
				[input("b", "=someVar")],
				templateOf({ ...numberPattern, feel: "optional" }),
			),
		);
	});

	test("treats a bare = as empty", () => {
		assert.throws(
			() =>
				validateDestinationValues(
					[],
					[input("b", "=")],
					templateOf({
						type: "Number",
						feel: "static",
						constraints: { notEmpty: true },
					}),
				),
			/notEmpty/,
		);
	});

	test("checks choices against the Boolean literal", () => {
		const target = templateOf({
			type: "Boolean",
			feel: "static",
			choices: [{ value: "true" }],
		});
		assert.doesNotThrow(() =>
			validateDestinationValues([], [input("b", "=true")], target),
		);
		assert.throws(
			() => validateDestinationValues([], [input("b", "=false")], target),
			/choice/,
		);
	});

	test("matches conditions on the stored literal", () => {
		const dependent = {
			id: "dep",
			binding: { type: "zeebe:input", name: "d" },
			condition: { property: "n", oneOf: [20, 30] },
			constraints: { notEmpty: true },
		};
		const target = templateOf(
			{ id: "n", type: "Number", feel: "static" },
			dependent,
		);
		assert.throws(
			() =>
				validateDestinationValues(
					[],
					[input("b", "=20"), input("d", " ")],
					target,
				),
			/notEmpty/,
		);
	});
});
