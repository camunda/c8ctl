/**
 * Compile-time type surface of the recipe types and the vendored modeler
 * (default-plugins/element-template/migration/recipe.ts, apply.ts)
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { MigrationModeler } from "../../default-plugins/element-template/migration/apply.ts";
import {
	parseRecipe,
	type RecipeSource,
} from "../../default-plugins/element-template/migration/recipe.ts";
import type { ElementTemplatesService } from "../utils/element-template.ts";

describe("migration typed surface", () => {
	test("Option B sources narrow to distinct version contracts", () => {
		const sources = parseRecipe({
			schemaVersion: 1,
			sources: [
				{ kind: "upgrade", sourceTemplateId: "source", toVersion: 2 },
				{ kind: "change", sourceTemplateId: "source", minSourceVersion: 1 },
			],
		}).sources;
		for (const source of sources) {
			if (source.kind === "upgrade") {
				const version: number = source.toVersion;
				assert.equal(version, 2);
			} else {
				const floor: number | undefined = source.minSourceVersion;
				assert.equal(floor, 1);
			}
		}
		const upgradeHasNoFloor: "minSourceVersion" extends keyof Extract<
			RecipeSource,
			{ kind: "upgrade" }
		>
			? false
			: true = true;
		const changeHasNoDestination: "toVersion" extends keyof Extract<
			RecipeSource,
			{ kind: "change" }
		>
			? false
			: true = true;
		const vendorRequiresProperties: object extends Parameters<
			ElementTemplatesService["applyTemplate"]
		>[1]
			? false
			: true = true;
		const vendorCompatible: ElementTemplatesService extends MigrationModeler["elementTemplates"]
			? true
			: false = true;
		const vendorRequiresCatalogProperties: object extends Parameters<
			ElementTemplatesService["set"]
		>[0][number]
			? false
			: true = true;
		const vendorRejectsInvalidBinding: {
			properties: { binding: { name: number } }[];
		} extends Parameters<ElementTemplatesService["applyTemplate"]>[1]
			? false
			: true = true;
		assert.ok(
			upgradeHasNoFloor &&
				changeHasNoDestination &&
				vendorRequiresProperties &&
				vendorCompatible &&
				vendorRequiresCatalogProperties &&
				vendorRejectsInvalidBinding,
		);
	});
});
