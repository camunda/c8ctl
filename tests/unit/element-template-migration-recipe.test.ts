/**
 * Unit tests for the element-template migration recipe parser
 * (default-plugins/element-template/migration/recipe.ts)
 */

import assert from "node:assert";
import { describe, test } from "node:test";
import {
	parseRecipe,
	RecipeError,
	readEmbeddedRecipe,
	validateRecipeOwner,
} from "../../default-plugins/element-template/migration/recipe.ts";

const source = { kind: "change", sourceTemplateId: "old" };

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

	test("checks a newer schemaVersion before any other property", () => {
		const newer = /newer than this c8ctl supports \(1\)\. Update c8ctl/;
		rejects({ schemaVersion: 2, future: {}, sources: [] }, newer);
		rejects({ schemaVersion: 2, sources: "x" }, newer);
		rejects({ schemaVersion: 2, $schema: 5 }, newer);
	});

	test("refuses a missing schemaVersion and a bare array", () => {
		rejects({ sources: [] }, /schemaVersion must be 1/);
		rejects([], /recipe must be an object/);
	});

	test("refuses a missing or non-integer schemaVersion before unknown keys", () => {
		for (const schemaVersion of [undefined, 1.5, "1", "2", 0, -1, null]) {
			rejects({ schemaVersion, sources: [] }, /schemaVersion must be 1/);
			rejects(
				{ schemaVersion, future: {}, sources: [] },
				/schemaVersion must be 1/,
			);
		}
	});

	test("still validates $schema and unknown keys for version 1", () => {
		rejects(
			{ $schema: 5, schemaVersion: 1, sources: [source] },
			/\$schema must be a string/,
		);
		rejects(
			{ schemaVersion: 1, future: {}, sources: [source] },
			/recipe has unknown property `future`/,
		);
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
		for (const [source, message] of [
			[
				{ sourceTemplateId: SOURCE_ID },
				'sources[0].kind must be "upgrade" or "change"',
			],
			[
				{ kind: "upgrade", sourceTemplateId: SOURCE_ID },
				"sources[0].toVersion must be a non-negative safe integer",
			],
			[
				{ kind: "change", sourceTemplateId: SOURCE_ID, minVersion: 2 },
				"sources[0] has unknown property `minVersion`",
			],
			[
				{ kind: "change", sourceTemplateId: SOURCE_ID, toVersion: 2 },
				"sources[0] has unknown property `toVersion`",
			],
			[
				{
					kind: "upgrade",
					sourceTemplateId: SOURCE_ID,
					toVersion: 2,
					minSourceVersion: 1,
				},
				"sources[0] has unknown property `minSourceVersion`",
			],
			[
				{
					kind: "upgrade",
					sourceTemplateId: SOURCE_ID,
					toVersion: Number.MAX_SAFE_INTEGER + 1,
				},
				"sources[0].toVersion must be a non-negative safe integer",
			],
		] as const) {
			assert.throws(
				() => parseRecipe({ schemaVersion: 1, sources: [source] }),
				(error) =>
					error instanceof RecipeError &&
					error.message === `Invalid migration recipe: ${message}`,
			);
		}
	});

	test("rejects duplicate upgrade markers and omitted change floors without merging", () => {
		for (const source of [
			{ kind: "upgrade", sourceTemplateId: SOURCE_ID, toVersion: 0 },
			{ kind: "upgrade", sourceTemplateId: SOURCE_ID, toVersion: 2 },
			{ kind: "change", sourceTemplateId: SOURCE_ID },
			{ kind: "change", sourceTemplateId: SOURCE_ID, minSourceVersion: 0 },
		]) {
			rejects(
				{ schemaVersion: 1, sources: [source, { ...source, paths: [] }] },
				/declared twice/,
			);
		}
	});

	test("accepts mixed kinds and source IDs with omitted or empty paths", () => {
		const recipe = parseRecipe({
			schemaVersion: 1,
			sources: [
				{ kind: "upgrade", sourceTemplateId: "owner", toVersion: 0 },
				{ kind: "upgrade", sourceTemplateId: "owner", toVersion: 2, paths: [] },
				{ kind: "change", sourceTemplateId: SOURCE_ID, minSourceVersion: 0 },
				{ kind: "change", sourceTemplateId: SOURCE_ID, paths: [] },
				{ kind: "change", sourceTemplateId: "other" },
			],
		});
		assert.strictEqual(recipe.schemaVersion, 1);
		assert.strictEqual(recipe.sources.length, 5);
		assert.ok(recipe.sources.every((source) => source.entries.length === 0));
	});

	test("validates both version fields as non-negative safe integers", () => {
		for (const kind of ["upgrade", "change"]) {
			const field = kind === "upgrade" ? "toVersion" : "minSourceVersion";
			for (const version of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, null, "2"]) {
				rejects(
					{
						schemaVersion: 1,
						sources: [{ kind, sourceTemplateId: SOURCE_ID, [field]: version }],
					},
					/non-negative safe integer/,
				);
			}
			for (const version of [0, Number.MAX_SAFE_INTEGER]) {
				assert.strictEqual(
					parseRecipe({
						schemaVersion: 1,
						sources: [{ kind, sourceTemplateId: SOURCE_ID, [field]: version }],
					}).sources.length,
					1,
				);
			}
		}
	});
});

describe("validateRecipeOwner", () => {
	for (const variant of [
		{
			name: "upgrade equal to owner version",
			entry: { kind: "upgrade", sourceTemplateId: "old", toVersion: 1 },
			owner: { id: "old", version: 1 },
			accepted: true,
		},
		{
			name: "upgrade zero at owner zero",
			entry: { kind: "upgrade", sourceTemplateId: "old", toVersion: 0 },
			owner: { id: "old", version: 0 },
			accepted: true,
		},
		{
			name: "upgrade below owner version",
			entry: { kind: "upgrade", sourceTemplateId: "old", toVersion: 1 },
			owner: { id: "old", version: 2 },
			accepted: true,
		},
		{
			name: "upgrade above owner version",
			entry: { kind: "upgrade", sourceTemplateId: "old", toVersion: 2 },
			owner: { id: "old", version: 1 },
			accepted: false,
		},
		{
			name: "upgrade without owner version",
			entry: { kind: "upgrade", sourceTemplateId: "old", toVersion: 0 },
			owner: { id: "old" },
			accepted: false,
		},
		{
			name: "upgrade with different owner ID",
			entry: { kind: "upgrade", sourceTemplateId: "old", toVersion: 1 },
			owner: { id: "new", version: 1 },
			accepted: false,
		},
		{
			name: "change with different owner ID",
			entry: source,
			owner: { id: "new" },
			accepted: true,
		},
		{
			name: "change with same owner ID",
			entry: source,
			owner: { id: "old", version: 1 },
			accepted: false,
		},
		{
			name: "change floor above owner version",
			entry: { ...source, minSourceVersion: 3 },
			owner: { id: "new", version: 1 },
			accepted: true,
		},
	]) {
		test(variant.name, () => {
			const parsed = parseRecipe({
				schemaVersion: 1,
				sources: [variant.entry],
			});
			const check = () => validateRecipeOwner(parsed, variant.owner);
			if (variant.accepted) assert.doesNotThrow(check);
			else assert.throws(check, RecipeError);
		});
	}
});

describe("readEmbeddedRecipe", () => {
	test("returns undefined without metadata or without migratesFrom", () => {
		assert.strictEqual(readEmbeddedRecipe({}), undefined);
		assert.strictEqual(readEmbeddedRecipe({ metadata: undefined }), undefined);
		assert.strictEqual(readEmbeddedRecipe({ metadata: "text" }), undefined);
		assert.strictEqual(readEmbeddedRecipe({ metadata: null }), undefined);
		assert.strictEqual(readEmbeddedRecipe({ metadata: {} }), undefined);
	});

	test("parses the embedded recipe", () => {
		const recipe = readEmbeddedRecipe({
			metadata: { migratesFrom: recipeWith({ from: "a", to: "b" }) },
		});
		assert.strictEqual(recipe?.sources[0].sourceTemplateId, SOURCE_ID);
	});

	test("throws RecipeError for an invalid embedded recipe", () => {
		assert.throws(
			() =>
				readEmbeddedRecipe({
					metadata: { migratesFrom: { schemaVersion: 99 } },
				}),
			RecipeError,
		);
		assert.throws(
			() => readEmbeddedRecipe({ metadata: { migratesFrom: null } }),
			RecipeError,
		);
	});

	test("asks to update c8ctl for a newer embedded recipe with new keys", () => {
		assert.throws(
			() =>
				readEmbeddedRecipe({
					metadata: { migratesFrom: { schemaVersion: 2, future: {} } },
				}),
			(error) =>
				error instanceof RecipeError && /Update c8ctl/.test(error.message),
		);
	});
});

describe("parseRecipe boundary cases", () => {
	const entriesOf = (path: object) =>
		parseRecipe(recipeWith(path)).sources[0].entries;

	test("surrounding whitespace in paths, values, templates and notes is preserved", () => {
		const [set, template, rename] = entriesOf2(
			{ to: " b ", set: "  x  ", note: " hi " },
			{ to: "b", template: `  \${a}  ` },
			{ from: " a ", to: "b" },
		);
		assert.partialDeepStrictEqual(set, {
			kind: "set",
			to: " b ",
			value: "  x  ",
			note: { level: "info", message: " hi " },
		});
		assert.partialDeepStrictEqual(template, { template: `  \${a}  ` });
		assert.partialDeepStrictEqual(rename, { from: " a ", to: "b" });
	});

	function entriesOf2(...paths: object[]) {
		return parseRecipe(recipeWith(...paths)).sources[0].entries;
	}

	for (const [key, where] of [
		["__proto__", "source"],
		["constructor", "entry"],
		["__proto__", "value map"],
	] as const) {
		test(`${key} as a property name in a ${where} is an unknown property`, () => {
			const raw = JSON.parse(
				{
					source: `{"schemaVersion":1,"sources":[{"kind":"change","sourceTemplateId":"old","${key}":{"x":1}}]}`,
					entry: `{"schemaVersion":1,"sources":[{"kind":"change","sourceTemplateId":"old","paths":[{"to":"b","set":"x","${key}":"y"}]}]}`,
					"value map": `{"schemaVersion":1,"sources":[{"kind":"change","sourceTemplateId":"old","paths":[{"from":"a","to":"b","valueMap":{"rules":[{"match":"x","value":"y"}],"${key}":{"default":"z"}}}]}]}`,
				}[where],
			);
			rejects(raw, new RegExp(`unknown property \`${key}\``));
		});
	}

	test("__proto__ as a binding key is plain data and pollutes nothing", () => {
		const [entry] = entriesOf({ to: "__proto__", set: "x" });
		assert.partialDeepStrictEqual(entry, { to: "__proto__", value: "x" });
		assert.strictEqual(Reflect.get({}, "value"), undefined);
	});

	for (const [number, text] of [
		[1e21, "1e+21"],
		[1e-7, "1e-7"],
		[1e300, "1e+300"],
		[0.1 + 0.2, "0.30000000000000004"],
		[-0, "0"],
		[Number.MAX_SAFE_INTEGER + 2, "9007199254740992"],
	] as const) {
		test(`a set value of ${text} is written as ${JSON.stringify(text)}`, () => {
			// Pinned: numbers are stringified with String(), not preserved as written.
			const [entry] = entriesOf({ to: "b", set: number });
			assert.partialDeepStrictEqual(entry, { value: text });
		});
	}

	for (const version of [1.5, 0, -1, "1", 1.0000001]) {
		test(`schemaVersion ${JSON.stringify(version)} is invalid, not "newer"`, () => {
			rejects(
				{ schemaVersion: version, sources: [] },
				/schemaVersion must be 1/,
			);
		});
	}

	test("an integer schemaVersion above 1 asks the user to update c8ctl", () => {
		rejects({ schemaVersion: 2, sources: [] }, /Update c8ctl/);
	});
});
