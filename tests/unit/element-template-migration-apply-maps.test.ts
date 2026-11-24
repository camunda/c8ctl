/**
 * `--map` value moves applied after the step chain
 * (default-plugins/element-template/migration/apply.ts)
 */

import assert from "node:assert";
import { before, describe, test } from "node:test";
import type { BpmnElement } from "../../default-plugins/element-template/migration/apply.ts";
import { migrateElement } from "../../default-plugins/element-template/migration/apply.ts";
import {
	enumerateElementValues,
	getExtensionElements,
} from "../../default-plugins/element-template/migration/element-values.ts";
import { parseRecipe } from "../../default-plugins/element-template/migration/recipe.ts";
import type { MigrationTemplate } from "../../default-plugins/element-template/migration/types.ts";
import {
	input,
	loadVendorBundle,
	setupAppliedModeler,
	type VendorBundle,
} from "../utils/element-template.ts";

let vendor: VendorBundle;

before(() => {
	vendor = loadVendorBundle();
});

function setup(applied: MigrationTemplate, values: Record<string, string>) {
	return setupAppliedModeler(vendor, applied, values);
}

const hidden = (id: string) => ({
	type: "Hidden",
	value: id,
	binding: { type: "zeebe:taskDefinition", property: "type" },
});

const OLD: MigrationTemplate = {
	id: "io.example.old",
	version: 1,
	name: "Old",
	appliesTo: ["bpmn:Task"],
	properties: [hidden("io.example.old"), input("maxTokens", "")],
};

const NEW: MigrationTemplate = {
	id: "io.example.new",
	version: 1,
	name: "New",
	appliesTo: ["bpmn:Task"],
	properties: [
		hidden("io.example.new"),
		input("limit", ""),
		input("mode", "off", { id: "mode" }),
		input("extra", "", { condition: { property: "mode", equals: "on" } }),
	],
};

const valueAt = (migrated: BpmnElement, key: string) =>
	enumerateElementValues(getExtensionElements(migrated.businessObject)).find(
		(v) => v.key === key,
	)?.value;

const run = async (
	maps: Parameters<typeof migrateElement>[0]["maps"],
	values: Record<string, string> = { maxTokens: "512" },
	recipe?: Parameters<typeof migrateElement>[0]["recipe"],
	target: MigrationTemplate = NEW,
) => {
	const { migrationModeler, element } = await setup(OLD, values);
	return migrateElement({
		modeler: migrationModeler,
		element,
		fromTemplate: OLD,
		target,
		templates: [OLD, target],
		recipe,
		maps,
	});
};

const map = (from: string, to: string) => ({
	from: { key: from, bindingType: null },
	to: { key: to, bindingType: null },
});

describe("migrateElement maps", () => {
	test("moves a dropped value, losslessly", async () => {
		const { element, report } = await run([map("maxTokens", "limit")]);
		assert.strictEqual(valueAt(element, "limit"), "512");
		assert.strictEqual(report.dropped.length, 0);
		assert.strictEqual(report.lossless, true);
		assert.strictEqual(report.moved[0].from.key, "maxTokens");
		assert.strictEqual(report.moved[0].to.key, "limit");
	});

	test("reports a mapped destination as moved only", async () => {
		const { report } = await run([map("maxTokens", "limit")]);
		assert.deepStrictEqual(
			report.added.map((a) => a.key),
			["mode"],
		);
		assert.strictEqual(report.moved.length, 1);
	});

	test("without the map the value is dropped", async () => {
		const { report } = await run([]);
		assert.strictEqual(report.dropped.length, 1);
		assert.strictEqual(report.lossless, false);
	});

	test("skips a source that holds no value", async () => {
		const { element, report } = await run([map("maxTokens", "limit")], {});
		assert.strictEqual(valueAt(element, "limit") ?? "", "");
		assert.strictEqual(report.moved.length, 0);
		assert.strictEqual(report.lossless, true);
	});

	test("materializes a binding whose condition the moved value satisfies", async () => {
		const old = { ...OLD, properties: [hidden(OLD.id), input("flag", "")] };
		const { migrationModeler, element: el } = await setup(old, { flag: "on" });
		const result = migrateElement({
			modeler: migrationModeler,
			element: el,
			fromTemplate: old,
			target: NEW,
			templates: [old, NEW],
			maps: [map("flag", "mode"), map("flag", "extra")],
		});
		assert.strictEqual(valueAt(result.element, "extra"), "on");
	});

	test("keeps a conditional binding absent when the moved value does not satisfy its condition", async () => {
		const old = { ...OLD, properties: [hidden(OLD.id), input("flag", "")] };
		const { migrationModeler, element: el } = await setup(old, { flag: "off" });
		const result = migrateElement({
			modeler: migrationModeler,
			element: el,
			fromTemplate: old,
			target: NEW,
			templates: [old, NEW],
			maps: [map("flag", "mode"), map("flag", "extra")],
		});
		assert.strictEqual(valueAt(result.element, "mode"), "off");
		assert.strictEqual(valueAt(result.element, "extra"), undefined);
		// The Modeler removes the inactive binding, so the flag->extra move vanishes
		// and the lost value is listed as dropped.
		assert.deepStrictEqual(
			result.report.dropped.map((d) => [d.key, d.value]),
			[["flag", "off"]],
		);
		assert.deepStrictEqual(
			result.report.moved.map((m) => [m.from.key, m.to.key]),
			[["flag", "mode"]],
		);
		assert.strictEqual(result.report.lossless, false);
	});

	test("fails on a destination the target does not bind and lists names", async () => {
		await assert.rejects(
			() => run([map("maxTokens", "nope")]),
			/destination "nope".*Available: .*limit/,
		);
	});

	test("fails on a source the source template does not bind", async () => {
		await assert.rejects(
			() => run([map("nope", "limit")]),
			/source "nope".*Available: .*maxTokens/,
		);
	});

	test("fails when a recipe entry also writes the destination", async () => {
		const recipe = parseRecipe({
			schemaVersion: 1,
			sources: [
				{
					kind: "change",
					sourceTemplateId: OLD.id,
					paths: [{ to: "limit", set: "1" }],
				},
			],
		});
		await assert.rejects(
			() => run([map("maxTokens", "limit")], undefined, recipe),
			/Ambiguous migration/,
		);
	});

	test("fails when two maps write the same destination", async () => {
		await assert.rejects(
			() => run([map("maxTokens", "limit"), map("maxTokens", "limit")]),
			/Ambiguous migration/,
		);
	});

	test("rejects a destination the target binds only as Hidden", async () => {
		const target = {
			...NEW,
			properties: [
				...NEW.properties,
				{
					type: "Hidden",
					value: "fixed",
					binding: { type: "zeebe:input", name: "locked" },
				},
			],
		};
		await assert.rejects(
			() => run([map("maxTokens", "locked")], undefined, undefined, target),
			/destination "locked" is not a settable binding/,
		);
	});

	test("stores a moved value as a FEEL expression when the destination requires FEEL", async () => {
		const target = {
			...NEW,
			properties: [hidden(NEW.id), input("limit", "", { feel: "required" })],
		};
		const { element, report } = await run(
			[map("maxTokens", "limit")],
			undefined,
			undefined,
			target,
		);
		assert.strictEqual(valueAt(element, "limit"), "=512");
		assert.strictEqual(report.lossless, true);
		assert.deepStrictEqual(report.dropped, []);
	});

	test("a map reads the original value after a multi-step chain removed its field", async () => {
		const id = "io.example.chain";
		const v1 = {
			id,
			version: 1,
			appliesTo: ["bpmn:Task"],
			properties: [hidden(id), input("a", "")],
		};
		const v2 = { ...v1, version: 2, properties: [hidden(id), input("b", "")] };
		const v3 = {
			...v1,
			version: 3,
			properties: [hidden(id), input("c", ""), input("d", "")],
			metadata: {
				migratesFrom: {
					schemaVersion: 1,
					sources: [
						{
							kind: "upgrade",
							sourceTemplateId: id,
							toVersion: 2,
							paths: [{ from: "a", to: "b" }],
						},
						{
							kind: "upgrade",
							sourceTemplateId: id,
							toVersion: 3,
							paths: [{ from: "b", to: "c" }],
						},
					],
				},
			},
		};
		const { migrationModeler, element } = await setupAppliedModeler(
			vendor,
			v1,
			{ a: "original" },
		);
		const result = migrateElement({
			modeler: migrationModeler,
			element,
			fromTemplate: v1,
			target: v3,
			templates: [v1, v2, v3],
			maps: [map("a", "d")],
		});
		assert.strictEqual(valueAt(result.element, "c"), "original");
		assert.strictEqual(valueAt(result.element, "d"), "original");
		assert.deepStrictEqual(result.report.dropped, []);
	});
});
