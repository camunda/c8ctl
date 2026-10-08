/**
 * Unit tests for the element-template migration recipe parser
 * (default-plugins/element-template/migration/recipe.ts)
 */

import assert from "node:assert";
import { describe, test } from "node:test";
import {
	parseRecipe,
	RecipeError,
} from "../../default-plugins/element-template/migration/recipe.ts";

const SOURCE_ID = "io.example.old.v1";

function recipeWith(...paths: unknown[]) {
	return {
		schemaVersion: 1,
		sources: [
			{
				kind: "change",
				sourceTemplateId: SOURCE_ID,
				minSourceVersion: 3,
				paths,
			},
		],
	};
}

function rejects(raw: unknown, pattern: RegExp) {
	assert.throws(
		() => parseRecipe(raw),
		(error) => error instanceof RecipeError && pattern.test(error.message),
	);
}

describe("parseRecipe", () => {
	test("parses rename, set and template entries", () => {
		const recipe = parseRecipe(
			recipeWith(
				{ from: "a", to: "b" },
				{ to: "kind", set: "x" },
				{ to: "url", template: `\${host}/\${path}` },
			),
		);
		const [source] = recipe.sources;
		assert.strictEqual(source.sourceTemplateId, SOURCE_ID);
		assert.ok(source.kind === "change");
		assert.strictEqual(source.minSourceVersion, 3);
		assert.deepStrictEqual(
			source.entries.map((e) => e.kind),
			["rename", "set", "template"],
		);
	});

	test("stringifies scalar values", () => {
		const [source] = parseRecipe(recipeWith({ to: "n", set: 5 })).sources;
		const [entry] = source.entries;
		assert.ok(entry.kind === "set");
		assert.strictEqual(entry.value, "5");
	});

	test("flattens nested groups and ANDs the guards", () => {
		const [source] = parseRecipe(
			recipeWith({
				when: { path: "type", equals: "a" },
				rules: [
					{ from: "x", to: "y" },
					{
						when: { path: "mode", exists: true },
						rules: [{ from: "p", to: "q" }],
					},
				],
			}),
		).sources;
		assert.deepStrictEqual(
			source.entries.map((e) => e.when.length),
			[1, 2],
		);
		assert.ok(source.entries[1].label.includes("rules[1].rules[0]"));
	});

	test("accepts a string note as info and an object note with a level", () => {
		const [source] = parseRecipe(
			recipeWith(
				{ from: "a", to: "b", note: "moved" },
				{ from: "c", to: "d", note: { level: "warning", message: "lossy" } },
				{ from: "e", to: "f", note: { message: "plain" } },
			),
		).sources;
		assert.deepStrictEqual(
			source.entries.map((e) => e.note),
			[
				{ level: "info", message: "moved" },
				{ level: "warning", message: "lossy" },
				{ level: "info", message: "plain" },
			],
		);
	});

	test("parses value maps and guard operators", () => {
		const [source] = parseRecipe(
			recipeWith(
				{
					from: "a",
					to: "b",
					valueMap: { rules: [{ match: "t*", value: "X" }], default: "Y" },
				},
				{
					from: "c",
					to: "d",
					when: [
						{ path: "p", in: ["u", "v"], not: true },
						{ path: "q", matches: "pre*" },
						{ path: "r", exists: false },
					],
				},
			),
		).sources;
		const [mapped, guarded] = source.entries;
		assert.ok(mapped.kind === "rename");
		assert.deepStrictEqual(mapped.valueMap, {
			rules: [{ match: "t*", value: "X" }],
			default: "Y",
		});
		assert.deepStrictEqual(
			guarded.when.map((g) => g.kind),
			["in", "matches", "exists"],
		);
	});

	test("treats a source without paths as carry-over only", () => {
		const [source] = parseRecipe({
			schemaVersion: 1,
			sources: [{ kind: "change", sourceTemplateId: SOURCE_ID }],
		}).sources;
		assert.deepStrictEqual(source.entries, []);
	});

	test("refuses a newer schemaVersion with an upgrade hint", () => {
		rejects({ schemaVersion: 2, sources: [] }, /Update c8ctl/);
	});

	test("refuses a missing schemaVersion and a bare array", () => {
		rejects({ sources: [] }, /schemaVersion must be 1/);
		rejects([], /recipe must be an object/);
	});

	test("refuses empty sources", () => {
		rejects({ schemaVersion: 1, sources: [] }, /sources must be a non-empty/);
	});

	test("refuses unknown properties instead of ignoring them", () => {
		rejects(recipeWith({ form: "a", to: "b" }), /must have exactly one of/);
		rejects(
			recipeWith({ from: "a", to: "b", remove: true }),
			/unknown property `remove`/,
		);
		rejects(
			{ ...recipeWith({ from: "a", to: "b" }), extra: 1 },
			/unknown property `extra`/,
		);
	});

	test("refuses entries that mix from, set and template", () => {
		rejects(recipeWith({ from: "a", to: "b", set: "c" }), /exactly one of/);
		rejects(recipeWith({ to: "b" }), /exactly one of/);
	});

	test("refuses a group without a guard or without rules", () => {
		rejects(recipeWith({ rules: [{ from: "a", to: "b" }] }), /no `when`/);
		rejects(
			recipeWith({ when: { path: "p", equals: "x" }, rules: [] }),
			/rules must be a non-empty/,
		);
	});

	test("refuses malformed guards", () => {
		rejects(
			recipeWith({
				from: "a",
				to: "b",
				when: { path: "p", equals: "x", in: ["y"] },
			}),
			/exactly one of equals/,
		);
		rejects(
			recipeWith({
				from: "a",
				to: "b",
				when: { path: "p", exists: true, not: true },
			}),
			/not allowed with `exists`/,
		);
		rejects(recipeWith({ from: "a", to: "b", when: [] }), /empty list/);
	});

	test("refuses a note with an unknown level or no message", () => {
		rejects(
			recipeWith({
				from: "a",
				to: "b",
				note: { level: "error", message: "x" },
			}),
			/level must be/,
		);
		rejects(recipeWith({ from: "a", to: "b", note: {} }), /message must be/);
	});

	test("refuses a duplicate source at the same change floor", () => {
		rejects(
			{
				schemaVersion: 1,
				sources: [
					{ kind: "change", sourceTemplateId: SOURCE_ID, minSourceVersion: 1 },
					{ kind: "change", sourceTemplateId: SOURCE_ID, minSourceVersion: 1 },
				],
			},
			/declared twice/,
		);
	});

	test("refuses an invalid source floor", () => {
		rejects(
			{
				schemaVersion: 1,
				sources: [
					{
						kind: "change",
						sourceTemplateId: SOURCE_ID,
						minSourceVersion: 1.5,
					},
				],
			},
			/non-negative safe integer/,
		);
	});
	test("requires an explicit kind and rejects legacy markers and mixed fields", () => {
		for (const source of [
			{ sourceTemplateId: SOURCE_ID },
			{ kind: "upgrade", sourceTemplateId: SOURCE_ID },
			{ kind: "change", sourceTemplateId: SOURCE_ID, minVersion: 2 },
			{ kind: "change", sourceTemplateId: SOURCE_ID, toVersion: 2 },
			{
				kind: "upgrade",
				sourceTemplateId: SOURCE_ID,
				toVersion: 2,
				minSourceVersion: 1,
			},
			{
				kind: "upgrade",
				sourceTemplateId: SOURCE_ID,
				toVersion: Number.MAX_SAFE_INTEGER + 1,
			},
		]) {
			assert.throws(
				() => parseRecipe({ schemaVersion: 1, sources: [source] }),
				RecipeError,
			);
		}
	});
});
