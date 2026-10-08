/**
 * Applies migrations to a real headless modeler
 * (default-plugins/element-template/migration/apply.ts)
 */

import assert from "node:assert";
import { createRequire } from "node:module";
import { before, describe, test } from "node:test";
import type { MigrationModeler } from "../../default-plugins/element-template/migration/apply.ts";
import { migrateElement } from "../../default-plugins/element-template/migration/apply.ts";
import {
	getModdleElement,
	getModdleList,
} from "../../default-plugins/element-template/migration/moddle.ts";
import { parseRecipe } from "../../default-plugins/element-template/migration/recipe.ts";
import type { MigrationTemplate } from "../../default-plugins/element-template/migration/types.ts";
import type { VendorBundle } from "../../default-plugins/element-template/vendor.ts";
import { resolveVendorBundle } from "../../default-plugins/element-template/vendor.ts";

const require = createRequire(import.meta.url);

const DIAGRAM = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" xmlns:modeler="http://camunda.org/schema/modeler/1.0" id="Definitions_1" targetNamespace="http://bpmn.io/schema/bpmn" modeler:executionPlatform="Camunda Cloud" modeler:executionPlatformVersion="8.10.0">
  <bpmn:process id="Process_1" isExecutable="true">
    <bpmn:serviceTask id="Task_1" />
  </bpmn:process>
  <bpmndi:BPMNDiagram id="BPMNDiagram_1">
    <bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="Process_1">
      <bpmndi:BPMNShape id="Task_1_di" bpmnElement="Task_1">
        <dc:Bounds x="100" y="100" width="100" height="80" />
      </bpmndi:BPMNShape>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>`;

function input(name: string, value: string, extra = {}) {
	return {
		type: "String",
		value,
		binding: { type: "zeebe:input", name },
		...extra,
	};
}

const OLD: MigrationTemplate = {
	id: "io.example.old",
	version: 1,
	name: "Old connector",
	appliesTo: ["bpmn:Task"],
	deprecated: true,
	groups: [{ id: "model", label: "Model" }],
	properties: [
		{
			type: "Hidden",
			value: "io.example.old",
			binding: { type: "zeebe:taskDefinition", property: "type" },
		},
		input("provider", "azure", { group: "model", label: "Provider" }),
		input("endpoint", "", { group: "model", label: "Endpoint" }),
		input("maxTokens", "", { group: "model", label: "Maximum tokens" }),
	],
};

const NEW: MigrationTemplate = {
	id: "io.example.new",
	version: 1,
	name: "New connector",
	appliesTo: ["bpmn:Task"],
	groups: [{ id: "model", label: "Model" }],
	metadata: {
		migratesFrom: {
			schemaVersion: 1,
			sources: [
				{
					kind: "change",
					sourceTemplateId: "io.example.old",
					paths: [
						{
							from: "provider",
							to: "backend.provider",
							valueMap: { rules: [{ match: "azure", value: "openai" }] },
							note: { level: "warning", message: "Provider changed" },
						},
						{ from: "endpoint", to: "backend.endpoint" },
						{ to: "backend.type", set: "foundry" },
					],
				},
			],
		},
	},
	properties: [
		{
			type: "Hidden",
			value: "io.example.new",
			binding: { type: "zeebe:taskDefinition", property: "type" },
		},
		input("backend.provider", "", { group: "model", label: "Provider" }),
		input("backend.endpoint", "", { group: "model", label: "Endpoint" }),
		input("backend.type", "", { group: "model", label: "Backend" }),
		input("effort", "default", { group: "model", label: "Effort" }),
	],
};

let vendor: VendorBundle;

before(() => {
	vendor = require(resolveVendorBundle());
});

async function setup(
	applied: MigrationTemplate,
	values: Record<string, string>,
) {
	const modeler = new vendor.Modeler({
		additionalModules: [
			vendor.HeadlessTextRendererModule,
			vendor.CloudElementTemplatesCoreModule,
		],
		moddleExtensions: { zeebe: vendor.ZeebeModdleExtension },
	});
	await modeler.importXML(DIAGRAM);
	const elementTemplates = modeler.get("elementTemplates");
	const modeling = modeler.get("modeling");
	elementTemplates.set([applied]);
	const element = modeler.get("elementRegistry").get("Task_1");
	assert.ok(element);
	const seeded = elementTemplates.applyTemplate(element, applied) ?? element;
	for (const [name, value] of Object.entries(values)) {
		const ext = getModdleElement(seeded.businessObject, "extensionElements");
		const io = getModdleList(ext, "values").find(
			(v) => v.$type === "zeebe:IoMapping",
		);
		const param = getModdleList(io, "inputParameters").find(
			(p) => p.target === name,
		);
		assert.ok(param);
		modeling.updateModdleProperties(seeded, param, { source: value });
	}
	const migrationModeler: MigrationModeler = { elementTemplates, modeling };
	return { modeler, migrationModeler, element: seeded };
}

describe("migrateElement", () => {
	test("reports loss when a conditional destination never materializes", async () => {
		const target = {
			...NEW,
			properties: [
				input("kind", "off", { id: "kind" }),
				input("b", "", { condition: { property: "kind", equals: "on" } }),
			],
			metadata: undefined,
		};
		const { modeler, migrationModeler, element } = await setup(OLD, {
			provider: "secret",
		});
		const { report } = migrateElement({
			modeler: migrationModeler,
			element,
			fromTemplate: OLD,
			target,
			templates: [OLD, target],
			recipe: parseRecipe({
				schemaVersion: 1,
				sources: [
					{
						kind: "change",
						sourceTemplateId: OLD.id,
						paths: [{ from: "provider", to: "b" }],
					},
				],
			}),
		});
		assert.deepStrictEqual(report.moved, []);
		assert.ok(report.dropped.some((item) => item.key === "provider"));
		assert.strictEqual(report.lossless, false);
		assert.doesNotMatch(
			(await modeler.saveXML({ format: true })).xml,
			/target="b"/,
		);
	});
	test("moves, translates and sets values per the embedded recipe", async () => {
		const { modeler, migrationModeler, element } = await setup(OLD, {
			provider: "azure",
			endpoint: "https://x",
			maxTokens: "2000",
		});
		const { report } = migrateElement({
			modeler: migrationModeler,
			element,
			fromTemplate: OLD,
			target: NEW,
			templates: [OLD, NEW],
		});

		const { xml } = await modeler.saveXML({ format: true });
		assert.match(xml, /modelerTemplate="io.example.new"/);
		assert.match(xml, /<zeebe:input source="openai" target="backend.provider"/);
		assert.match(
			xml,
			/<zeebe:input source="https:\/\/x" target="backend.endpoint"/,
		);
		assert.match(xml, /<zeebe:input source="foundry" target="backend.type"/);
		assert.match(xml, /<zeebe:input source="default" target="effort"/);
		assert.doesNotMatch(xml, /target="provider"/);

		assert.strictEqual(report.usedRecipe, true);
		assert.deepStrictEqual(
			report.moved.map((m) => [m.from.key, m.to.key]),
			[
				["provider", "backend.provider"],
				["endpoint", "backend.endpoint"],
			],
		);
		assert.deepStrictEqual(
			report.dropped.map((d) => [d.label, d.value]),
			[["Maximum tokens", "2000"]],
		);
		assert.deepStrictEqual(report.added.map((a) => a.key).sort(), [
			"backend.type",
			"effort",
		]);
		assert.deepStrictEqual(report.notes, [
			{ level: "warning", message: "Provider changed" },
		]);
	});

	test("falls back to carry-over and reports drops without a recipe", async () => {
		const bare = { ...NEW, metadata: undefined };
		const { modeler, migrationModeler, element } = await setup(OLD, {
			provider: "azure",
			maxTokens: "2000",
		});
		const { report } = migrateElement({
			modeler: migrationModeler,
			element,
			fromTemplate: OLD,
			target: bare,
			templates: [OLD, bare],
		});
		const { xml } = await modeler.saveXML({ format: true });
		assert.match(xml, /modelerTemplate="io.example.new"/);
		assert.strictEqual(report.usedRecipe, false);
		assert.deepStrictEqual(report.dropped.map((d) => d.key).sort(), [
			"maxTokens",
			"provider",
		]);
	});

	test("uses a supplied recipe over the embedded one", async () => {
		const { modeler, migrationModeler, element } = await setup(OLD, {
			provider: "azure",
			endpoint: "https://x",
		});
		migrateElement({
			modeler: migrationModeler,
			element,
			fromTemplate: OLD,
			target: NEW,
			templates: [OLD, NEW],
			recipe: parseRecipe({
				schemaVersion: 1,
				sources: [
					{
						kind: "change",
						sourceTemplateId: "io.example.old",
						paths: [{ from: "endpoint", to: "backend.provider" }],
					},
				],
			}),
		});
		const { xml } = await modeler.saveXML({ format: true });
		assert.match(
			xml,
			/<zeebe:input source="https:\/\/x" target="backend.provider"/,
		);
	});

	test("fails before touching the diagram when a recipe targets an unbound path", async () => {
		const { modeler, migrationModeler, element } = await setup(OLD, {
			provider: "azure",
		});
		assert.throws(
			() =>
				migrateElement({
					modeler: migrationModeler,
					element,
					fromTemplate: OLD,
					target: NEW,
					templates: [OLD, NEW],
					recipe: parseRecipe({
						schemaVersion: 1,
						sources: [
							{
								kind: "change",
								sourceTemplateId: "io.example.old",
								paths: [{ from: "provider", to: "nowhere" }],
							},
						],
					}),
				}),
			/not a binding in template io.example.new@1/,
		);
		const { xml } = await modeler.saveXML({ format: true });
		assert.match(xml, /modelerTemplate="io.example.old"/);
	});
});
