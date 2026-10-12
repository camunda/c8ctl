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
import { elementValue } from "../utils/element-template.ts";

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
			{ type: "Number", value: 2, equals: "=2", other: "=3" },
			{ type: "Boolean", value: true, equals: true, other: false },
			{ type: "Boolean", value: false, equals: false, other: true },
			{
				type: "String",
				feel: "required",
				value: "=on",
				equals: "on",
				other: "off",
			},
		]) {
			const { other, ...matching } = discriminator;
			const targetWith = (equals: unknown) => ({
				id: "new",
				properties: [
					{
						...matching,
						id: "mode",
						binding: { type: "zeebe:input", name: "mode" },
					},
					{
						condition: { property: "mode", equals },
						constraints: { notEmpty: true },
						binding: { type: "zeebe:input", name: "b" },
					},
				],
			});
			assert.throws(
				() =>
					buildStepPlan(
						entriesOf({ to: "b", set: "" }),
						[],
						targetWith(discriminator.equals),
					),
				/notEmpty/,
			);
			assert.doesNotThrow(
				() =>
					buildStepPlan(entriesOf({ to: "b", set: "" }), [], targetWith(other)),
				`${discriminator.type} ${String(discriminator.value)} vs ${String(other)}`,
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
				() => buildStepPlan([], [elementValue("b", property.value)], target),
				(error) =>
					error instanceof Error &&
					/carry-over.*input:b.*constraint/.test(error.message) &&
					!error.message.includes("SECRET"),
			);
			assert.doesNotThrow(() =>
				buildStepPlan(
					entriesOf({ to: "b", set: "allowed" }),
					[elementValue("b", property.value)],
					target,
				),
			);
			assert.doesNotThrow(() =>
				buildStepPlan([], [elementValue("b", property.value)], {
					...target,
					properties: target.properties.map((p) => ({ ...p, type: "Hidden" })),
				}),
			);
		}
		const plan = buildStepPlan([], [elementValue("b", "allowed")], {
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
					elementValue("mode", "off"),
					{ ...elementValue("mode", "on"), bindingType: "zeebe:taskHeader" },
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
				() => buildStepPlan([], [elementValue("b", "SECRET")], target),
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
				() =>
					buildStepPlan(entriesOf(path), [elementValue("a", "SECRET")], target),
				/choice/,
			);
	});

	test("fails closed on unsupported and cyclic destination conditions", () => {
		const message = (path: string, kind: "cyclic" | "unsupported") =>
			new RegExp(
				`^sources\\[0\\]\\.paths\\[0\\]: destination "input:${path}" has ${kind} condition$`,
			);
		const failsClosed = (
			properties: MigrationTemplate["properties"],
			to: string,
			kind: "cyclic" | "unsupported",
		): void => {
			const target: MigrationTemplate = { id: "new", properties };
			assert.throws(
				() => buildStepPlan(entriesOf({ to, set: "SECRET" }), [], target),
				(error: unknown) =>
					error instanceof Error &&
					!(error instanceof RangeError) &&
					message(to, kind).test(error.message) &&
					!error.message.includes("SECRET"),
			);
		};
		const bound = (id: string, condition: unknown) => ({
			id,
			condition,
			binding: { type: "zeebe:input", name: id },
		});
		failsClosed(
			[bound("b", { property: "b", custom: true })],
			"b",
			"unsupported",
		);
		failsClosed([bound("b", { property: "b", isActive: true })], "b", "cyclic");
		failsClosed(
			[
				bound("a", { property: "b", isActive: true }),
				bound("b", { property: "a", isActive: true }),
			],
			"a",
			"cyclic",
		);
	});
	test("activates a conditional property only when its condition holds", () => {
		const conditional = (condition: unknown) => ({ condition });
		const properties = (
			condition: unknown,
			mode = "on",
		): MigrationTemplate => ({
			id: "new",
			properties: [
				{
					id: "mode",
					type: "String",
					value: mode,
					binding: { type: "zeebe:input", name: "mode" },
				},
				{
					...conditional({ property: "mode", equals: "never" }),
					id: "off",
					type: "String",
					binding: { type: "zeebe:input", name: "off" },
				},
				{
					...conditional(condition),
					id: "dep",
					type: "String",
					constraints: { notEmpty: true },
					binding: { type: "zeebe:input", name: "dep" },
				},
			],
		});
		const isActive = (condition: unknown, mode?: string): boolean => {
			const target = properties(condition, mode);
			const plan = buildStepPlan(entriesOf({ to: "dep", set: "" }), [], target);
			return [...validateDestinationValues(plan.writes, [], target)].some(
				(p) => p.id === "dep",
			);
		};
		const rejects = (condition: unknown, mode?: string) =>
			assert.throws(
				() => isActive(condition, mode),
				/violates notEmpty constraint/,
			);
		const cases: [string, unknown, unknown, string?][] = [
			[
				"equals",
				{ property: "mode", equals: "on" },
				{ property: "mode", equals: "other" },
			],
			[
				"oneOf",
				{ property: "mode", oneOf: ["x", "on"] },
				{ property: "mode", oneOf: ["x", "y"] },
			],
			[
				"allMatch",
				{
					allMatch: [
						{ property: "mode", equals: "on" },
						{ property: "mode", oneOf: ["on"] },
					],
				},
				{
					allMatch: [
						{ property: "mode", equals: "on" },
						{ property: "mode", equals: "other" },
					],
				},
			],
			[
				"isEmpty",
				{ property: "mode", isEmpty: false },
				{ property: "mode", isEmpty: true },
			],
			[
				"isActive on an active property",
				{ property: "mode", isActive: true },
				{ property: "mode", isActive: false },
			],
			[
				"isActive on an inactive property",
				{ property: "off", isActive: false },
				{ property: "off", isActive: true },
			],
		];
		for (const [name, matching, nonMatching] of cases) {
			rejects(matching);
			assert.strictEqual(isActive(nonMatching), false, `${name}: not active`);
		}
		// An empty mode makes the isEmpty condition hold, so the notEmpty constraint applies.
		rejects({ property: "mode", isEmpty: true }, "");
		assert.strictEqual(
			isActive({ property: "missing", equals: "on" }),
			false,
			"a condition on a missing property is not active",
		);
	});
	test("validates required, choice and pattern destination values without echoing them", () => {
		for (const property of [
			{ constraints: { notEmpty: true }, value: "", reason: "notEmpty" },
			{
				choices: [{ name: "Allowed", value: "allowed" }],
				value: "SECRET",
				reason: "choice",
			},
			{
				constraints: { pattern: { value: "^allowed$" } },
				value: "SECRET",
				reason: "pattern",
			},
		]) {
			const { reason, ...templateProperty } = property;
			const target = {
				id: "new",
				properties: [
					{
						...templateProperty,
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
					error.message ===
						`sources[0].paths[0]: destination "input:b" violates ${reason} constraint`,
			);
		}
	});
	test("rejects ambiguous rename, guard and interpolation reads and duplicate backing values", () => {
		const values = [
			elementValue("key", "INPUT"),
			{ ...elementValue("key", "HEADER"), bindingType: "zeebe:taskHeader" },
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
					elementValue("key", "one"),
					elementValue("key", "two"),
				]),
			/Duplicate source/,
		);
	});
	test("renames a value and reports the move", () => {
		const plan = buildStepPlan(entriesOf({ from: "a", to: "b" }), [
			elementValue("a", "1"),
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
			buildStepPlan(entries, [elementValue("flag", "true")]).writes[0].value,
			"DOCUMENT",
		);
		const other = buildStepPlan(entries, [elementValue("flag", "false")]);
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
			[elementValue("a", "other")],
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
			[elementValue("a", "=expr")],
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
			[elementValue("m", "claude-3")],
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
			buildStepPlan(entries, [elementValue("type", "azure")]).writes.length,
			1,
		);
		assert.strictEqual(
			buildStepPlan(entries, [elementValue("type", "other")]).writes.length,
			0,
		);
	});

	test("composes a template value and skips it when a reference is missing", () => {
		const entries = entriesOf({ to: "url", template: `\${host}/\${path}` });
		assert.strictEqual(
			buildStepPlan(entries, [
				elementValue("host", "h"),
				elementValue("path", "p"),
			]).writes[0].value,
			"h/p",
		);
		const plan = buildStepPlan(entries, [elementValue("host", "h")]);
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
			buildStepPlan(entries, [
				elementValue("type", "bedrock"),
				elementValue("region", "eu"),
			]).writes.length,
			1,
		);
		const skipped = buildStepPlan(entries, [
			elementValue("type", "azure"),
			elementValue("region", "eu"),
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
			run({ path: "p", in: ["a", "b"] }, [elementValue("p", "b")]),
			1,
		);
		assert.strictEqual(
			run({ path: "p", in: ["a"], not: true }, [elementValue("p", "b")]),
			1,
		);
		assert.strictEqual(
			run({ path: "p", matches: "pre*" }, [elementValue("p", "prefix")]),
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
			elementValue("k", "i"),
		]);
		assert.strictEqual(plan.writes[0].value, "i");
	});

	test("collects the notes of entries that took effect only", () => {
		const entries = entriesOf(
			{ from: "a", to: "b", note: "moved a" },
			{ from: "missing", to: "c", note: "never shown" },
			{ to: "d", set: "1", note: { level: "warning", message: "set d" } },
		);
		const plan = buildStepPlan(entries, [elementValue("a", "1")]);
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
					[elementValue("a", "1")],
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
					buildStepPlan(
						entriesOf(...ordered),
						[elementValue("a", "secret")],
						target,
					),
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
			[
				elementValue("b", "first"),
				elementValue("b", "second"),
				elementValue("c", "x"),
			],
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
				[
					elementValue("b", "first"),
					elementValue("b", "second"),
					elementValue("h", "x"),
				],
				target,
			),
			[],
		);
		assert.deepStrictEqual(
			carryOverWrites([], [elementValue("b", "")], target),
			[],
		);
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
		const sources = [elementValue("b", "=20")];
		assert.doesNotThrow(() => validateDestinationValues([], sources, target));
		assert.deepStrictEqual(
			carryOverWrites([], sources, target).map((w) => w.value),
			["=20"],
		);
	});

	test("treats a missing feel on an input binding as static", () => {
		const target = templateOf({ ...numberPattern, feel: undefined });
		assert.doesNotThrow(() =>
			validateDestinationValues([], [elementValue("b", "=20")], target),
		);
	});

	test("still rejects a literal that violates the pattern", () => {
		assert.throws(
			() =>
				validateDestinationValues(
					[],
					[elementValue("b", "=abc")],
					templateOf(numberPattern),
				),
			/violates pattern constraint/,
		);
	});

	test("keeps skipping the pattern for optional FEEL expressions", () => {
		assert.doesNotThrow(() =>
			validateDestinationValues(
				[],
				[elementValue("b", "=someVar")],
				templateOf({ ...numberPattern, feel: "optional" }),
			),
		);
	});

	test("treats a bare = as empty", () => {
		assert.throws(
			() =>
				validateDestinationValues(
					[],
					[elementValue("b", "=")],
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
			validateDestinationValues([], [elementValue("b", "=true")], target),
		);
		assert.throws(
			() =>
				validateDestinationValues([], [elementValue("b", "=false")], target),
			/choice/,
		);
	});

	test("checks choices and patterns against the stored Boolean literal", () => {
		// The Modeler stores normalizeDestinationValue(...), "=true" for "yes".
		const boolean = {
			type: "Boolean",
			feel: "static",
			binding: { type: "zeebe:input", name: "b" },
		};
		assert.strictEqual(normalizeDestinationValue(boolean, "yes"), "=true");
		const validate = (constraint: object) => {
			const target = templateOf({ ...boolean, ...constraint });
			const plan = buildStepPlan(
				entriesOf({ to: "b", set: "yes" }),
				[],
				target,
			);
			return validateDestinationValues(plan.writes, [], target);
		};
		assert.doesNotThrow(() => validate({ choices: [{ value: "true" }] }));
		assert.throws(
			() => validate({ choices: [{ value: "yes" }] }),
			/violates choice constraint/,
		);
		assert.doesNotThrow(() =>
			validate({ constraints: { pattern: { value: "^true$" } } }),
		);
		assert.throws(
			() => validate({ constraints: { pattern: { value: "^yes$" } } }),
			/violates pattern constraint/,
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
					[elementValue("b", "=20"), elementValue("d", " ")],
					target,
				),
			/notEmpty/,
		);
	});
});

describe("normalizeDestinationValue", () => {
	// Expected values follow the vendored bpmn-js-element-templates
	// dist/core.esm.js:44 (toFeelExpression): a Boolean becomes "=false" for
	// "false" and "" and "=true" for everything else; other types get an "=".
	const inputs = [
		"false",
		"FALSE",
		"",
		"0",
		"no",
		" false",
		"=x",
		"abc",
		"1e3",
		"-1",
	];
	const castBoolean = [
		"=false",
		"=true",
		"=false",
		"=true",
		"=true",
		"=true",
		"=x",
		"=true",
		"=true",
		"=true",
	];
	const castText = [
		"=false",
		"=FALSE",
		"=",
		"=0",
		"=no",
		"= false",
		"=x",
		"=abc",
		"=1e3",
		"=-1",
	];
	const plain = inputs;
	type Row = [string, string | undefined, string[], string[], string[]];
	// [binding, feel, Boolean, Number, String]
	const rows: Row[] = [
		["zeebe:input", undefined, castBoolean, castText, plain],
		["zeebe:input", "static", castBoolean, castText, plain],
		["zeebe:input", "optional", castBoolean, castText, plain],
		["zeebe:input", "required", castBoolean, castText, castText],
		["zeebe:property", undefined, plain, plain, plain],
		["zeebe:property", "static", castBoolean, castText, plain],
		["zeebe:property", "optional", castBoolean, castText, plain],
		["zeebe:property", "required", castBoolean, castText, castText],
	];
	for (const [binding, feel, boolean, number, string] of rows) {
		test(`converts literals for ${binding} with feel ${feel}`, () => {
			for (const [type, expected] of [
				["Boolean", boolean],
				["Number", number],
				["String", string],
			] as const) {
				const property = { type, feel, binding: { type: binding } };
				assert.deepStrictEqual(
					inputs.map((value) => normalizeDestinationValue(property, value)),
					expected,
					`${type}`,
				);
			}
		});
	}
});
