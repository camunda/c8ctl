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
		{ sourceTemplateId: "t", minVersion: 2, paths: [{ from: "a", to: "b" }] },
		{ sourceTemplateId: "t", minVersion: 3, paths: [{ from: "b", to: "c" }] },
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
				sourceTemplateId: "t",
				minVersion: 2,
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
			sourceTemplateId: "t",
			minVersion: 3,
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
		sourceTemplateId: "old",
		minVersion: 2,
		paths: [{ from: "a", to: "b" }],
	});
	const fresh = withRecipe(template("new", 1, ["c"]), {
		sourceTemplateId: "old",
		minVersion: 2,
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

	test("respects the minVersion floor of the hop", () => {
		const gated = withRecipe(template("new", 1, []), {
			sourceTemplateId: "old",
			minVersion: 13,
			paths: [],
		});
		assert.deepStrictEqual(findSuccessors([gated], "old", 5, []), []);
		const latestOld = template("old", 13, []);
		assert.strictEqual(
			findSuccessors([gated], "old", 5, [latestOld]).length,
			1,
		);
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
