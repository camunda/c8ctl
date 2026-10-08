/**
 * Unit tests for resolving migration steps and successors
 * (default-plugins/element-template/migration/steps.ts)
 */

import assert from "node:assert";
import { describe, test } from "node:test";
import {
	parseRecipe,
	type Recipe,
} from "../../default-plugins/element-template/migration/recipe.ts";
import {
	findSuccessors,
	resolveApplications,
	resolveSteps,
} from "../../default-plugins/element-template/migration/steps.ts";
import type {
	MigrationTemplate,
	TemplateProperty,
} from "../../default-plugins/element-template/migration/types.ts";

function prop(name: string): TemplateProperty {
	return { binding: { type: "zeebe:input", name } };
}

function template(
	id: string,
	version: number,
	names: string[],
	extra: Partial<MigrationTemplate> = {},
): MigrationTemplate {
	return { id, version, properties: names.map(prop), ...extra };
}

function withRecipe(
	t: MigrationTemplate,
	...sources: Record<string, unknown>[]
): MigrationTemplate {
	return { ...t, metadata: { migratesFrom: { schemaVersion: 1, sources } } };
}

function recipeOf(...sources: Record<string, unknown>[]): Recipe {
	return parseRecipe({ schemaVersion: 1, sources });
}

describe("resolveSteps (same id)", () => {
	const v1 = template("t", 1, ["a"]);
	const v2 = template("t", 2, ["b"]);
	const v3 = withRecipe(
		template("t", 3, ["c"]),
		{
			kind: "upgrade",
			sourceTemplateId: "t",
			toVersion: 2,
			paths: [{ from: "a", to: "b" }],
		},
		{
			kind: "upgrade",
			sourceTemplateId: "t",
			toVersion: 3,
			paths: [{ from: "b", to: "c" }],
		},
	);
	const catalog = [v1, v2, v3];

	test("climbs every version step above the applied version", () => {
		const { steps, refusal } = resolveSteps({
			appliedId: "t",
			appliedVersion: 1,
			target: v3,
			templates: catalog,
		});
		assert.strictEqual(refusal, null);
		assert.deepStrictEqual(
			steps.map((s) => [s.kind, s.version]),
			[
				["version", 2],
				["version", 3],
			],
		);
	});

	test("skips steps at or below the applied version", () => {
		const { steps } = resolveSteps({
			appliedId: "t",
			appliedVersion: 2,
			target: v3,
			templates: catalog,
		});
		assert.deepStrictEqual(
			steps.map((s) => s.version),
			[3],
		);
	});

	test("returns no steps without a recipe", () => {
		const { steps } = resolveSteps({
			appliedId: "t",
			appliedVersion: 1,
			target: v2,
			templates: catalog,
		});
		assert.deepStrictEqual(steps, []);
	});

	test("prefers a supplied recipe over the embedded one", () => {
		const { steps } = resolveSteps({
			appliedId: "t",
			appliedVersion: 1,
			target: v3,
			templates: catalog,
			recipe: recipeOf({
				kind: "upgrade",
				sourceTemplateId: "t",
				toVersion: 2,
				paths: [{ from: "a", to: "b" }],
			}),
		});
		assert.deepStrictEqual(
			steps.map((s) => s.version),
			[2],
		);
	});

	test("refuses a recipe reading a path nothing produces", () => {
		const broken = withRecipe(template("t", 3, ["c"]), {
			kind: "upgrade",
			sourceTemplateId: "t",
			toVersion: 3,
			paths: [{ from: "missing", to: "c" }],
		});
		const { steps, refusal } = resolveSteps({
			appliedId: "t",
			appliedVersion: 1,
			target: broken,
			templates: [v1, v2, broken],
		});
		assert.deepStrictEqual(steps, []);
		assert.match(refusal ?? "", /reads "missing"/);
	});
});

describe("resolveSteps (cross id)", () => {
	const oldV1 = template("old", 1, ["a"]);
	const oldV2 = withRecipe(template("old", 2, ["b"]), {
		kind: "upgrade",
		sourceTemplateId: "old",
		toVersion: 2,
		paths: [{ from: "a", to: "b" }],
	});
	const fresh = withRecipe(template("new", 1, ["c"]), {
		kind: "change",
		sourceTemplateId: "old",
		minSourceVersion: 2,
		paths: [{ from: "b", to: "c" }],
	});
	const catalog = [oldV1, oldV2, fresh];

	test("climbs the source lineage, then hops", () => {
		const { steps } = resolveSteps({
			appliedId: "old",
			appliedVersion: 1,
			target: fresh,
			templates: catalog,
		});
		assert.deepStrictEqual(
			steps.map((s) => [s.kind, s.templateId, s.version]),
			[
				["version", "old", 2],
				["hop", "new", 1],
			],
		);
	});

	test("hops directly from the newest source version", () => {
		const { steps } = resolveSteps({
			appliedId: "old",
			appliedVersion: 2,
			target: fresh,
			templates: catalog,
		});
		assert.deepStrictEqual(
			steps.map((s) => s.kind),
			["hop"],
		);
	});

	test("does not hop without a declared recipe for the source", () => {
		const bare = template("new", 1, ["c"]);
		const { steps } = resolveSteps({
			appliedId: "old",
			appliedVersion: 2,
			target: bare,
			templates: [...catalog.slice(0, 2), bare],
		});
		assert.deepStrictEqual(steps, []);
	});
});

describe("findSuccessors", () => {
	const fresh = withRecipe(template("new", 1, []), {
		kind: "change",
		sourceTemplateId: "old",
		paths: [],
	});

	test("returns templates whose recipe hops from the applied one", () => {
		const unrelated = template("other", 1, []);
		const result = findSuccessors([fresh, unrelated], "old", 3, []);
		assert.deepStrictEqual(
			result.map((t) => t.id),
			["new"],
		);
	});

	test("skips deprecated templates and ones with an unusable recipe", () => {
		const deprecated = { ...fresh, id: "gone", deprecated: true };
		const broken = {
			...template("broken", 1, []),
			metadata: { migratesFrom: { schemaVersion: 9, sources: [] } },
		};
		assert.deepStrictEqual(
			findSuccessors([deprecated, broken], "old", 3, []),
			[],
		);
	});

	test("loaded source versions do not satisfy a change floor", () => {
		const gated = withRecipe(template("new", 1, []), {
			kind: "change",
			sourceTemplateId: "old",
			minSourceVersion: 13,
			paths: [],
		});
		assert.deepStrictEqual(findSuccessors([gated], "old", 5, []), []);
		const latestOld = template("old", 13, []);
		assert.deepStrictEqual(findSuccessors([gated], "old", 5, [latestOld]), []);
	});
	test("does not advertise a successor with a missing required upgrade", () => {
		const latestOld = withRecipe(
			template("old", 3, []),
			{ kind: "upgrade", sourceTemplateId: "old", toVersion: 2 },
			{ kind: "upgrade", sourceTemplateId: "old", toVersion: 3 },
		);
		assert.deepStrictEqual(findSuccessors([fresh], "old", 1, [latestOld]), []);
	});
});

describe("recipe owner and floor selection", () => {
	test("validates owner relations even on unselected entries", () => {
		for (const source of [
			{ kind: "upgrade", sourceTemplateId: "other", toVersion: 1 },
			{ kind: "upgrade", sourceTemplateId: "t", toVersion: 4 },
			{ kind: "change", sourceTemplateId: "t" },
		]) {
			const target = withRecipe(template("t", 3, []), source);
			assert.throws(
				() =>
					resolveSteps({
						appliedId: "t",
						appliedVersion: 2,
						target,
						templates: [target],
					}),
				/owner|version/,
			);
		}
	});
	test("chooses one highest reachable floor and otherwise the omitted floor", () => {
		const target = withRecipe(
			template("new", 1, []),
			{
				kind: "change",
				sourceTemplateId: "old",
				paths: [{ to: "x", set: "fallback" }],
			},
			{
				kind: "change",
				sourceTemplateId: "old",
				minSourceVersion: 5,
				paths: [{ to: "x", set: "five" }],
			},
			{
				kind: "change",
				sourceTemplateId: "old",
				minSourceVersion: 2,
				paths: [{ to: "x", set: "two" }],
			},
		);
		for (const [appliedVersion, expected] of [
			[1, "fallback"],
			[4, "two"],
			[5, "five"],
		]) {
			assert.ok(typeof appliedVersion === "number");
			const result = resolveSteps({
				appliedId: "old",
				appliedVersion,
				target,
				templates: [target],
			});
			assert.strictEqual(result.steps.length, 1);
			const entry = result.steps[0].entries[0];
			assert.ok(entry.kind === "set");
			assert.strictEqual(entry.value, expected);
		}
	});
});

describe("resolveApplications", () => {
	const v1 = template("t", 1, []);
	const v2 = template("t", 2, []);
	const v3 = template("t", 3, []);

	test("appends a recipe-free application of the target when steps end short", () => {
		const apps = resolveApplications(
			[v1, v2, v3],
			[{ kind: "version", templateId: "t", version: 2, entries: [] }],
			v3,
		);
		assert.deepStrictEqual(
			apps.map((a) => [a.template.version, a.step === null]),
			[
				[2, false],
				[3, true],
			],
		);
	});

	test("does not repeat the target when the last step produces it", () => {
		const apps = resolveApplications(
			[v1, v2],
			[{ kind: "version", templateId: "t", version: 2, entries: [] }],
			v2,
		);
		assert.strictEqual(apps.length, 1);
	});

	test("throws when a step template is not available", () => {
		assert.throws(
			() =>
				resolveApplications(
					[v1],
					[{ kind: "version", templateId: "t", version: 5, entries: [] }],
					v1,
				),
			/"t" version 5 is not available/,
		);
	});
});
