/**
 * Unit tests for resolving a recipe source against element values
 * (default-plugins/element-template/migration/plan.ts)
 */

import assert from "node:assert";
import { describe, test } from "node:test";
import type { ElementValue } from "../../default-plugins/element-template/migration/element-values.ts";
import {
	buildStepPlan,
	validateTargets,
} from "../../default-plugins/element-template/migration/plan.ts";
import { parseRecipe } from "../../default-plugins/element-template/migration/recipe.ts";

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
			bindingType: null,
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
