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
	enumerateElementValues,
	getExtensionElements,
} from "../../default-plugins/element-template/migration/element-values.ts";
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
	for (const feel of ["optional", "required"]) {
		test(`accepts populated ${feel} FEEL despite literal choices and patterns`, async () => {
			const old = { ...OLD, properties: [input("a", "=secretVariable")] };
			const target = {
				...NEW,
				metadata: undefined,
				properties: [
					input("b", "", {
						feel,
						constraints: { notEmpty: true, pattern: { value: "^allowed$" } },
						choices: [{ name: "Allowed", value: "allowed" }],
					}),
				],
			};
			const { migrationModeler, element } = await setup(old, {});
			const { element: migrated, report } = migrateElement({
				modeler: migrationModeler,
				element,
				fromTemplate: old,
				target,
				templates: [old, target],
				recipe: parseRecipe({
					schemaVersion: 1,
					sources: [
						{
							kind: "change",
							sourceTemplateId: old.id,
							paths: [{ from: "a", to: "b" }],
						},
					],
				}),
			});
			assert.strictEqual(
				enumerateElementValues(
					getExtensionElements(migrated.businessObject),
				).find((v) => v.key === "b")?.value,
				"=secretVariable",
			);
			assert.strictEqual(report.lossless, true);
		});
	}
	for (const carry of [false, true]) {
		for (const reversed of [false, true]) {
			test(`writes only active duplicates with correct FEEL semantics (carry=${carry}, reversed=${reversed})`, async () => {
				const old = {
					...OLD,
					properties: [input(carry ? "b" : "a", "secret")],
				};
				const duplicates = [
					input("b", "", {
						feel: "required",
						condition: { property: "mode", equals: "on" },
					}),
					input("b", "", {
						condition: { property: "mode", equals: "off" },
						constraints: { pattern: { value: "^other$" } },
					}),
				];
				const target = {
					...NEW,
					metadata: undefined,
					properties: [
						input("mode", "on", { id: "mode" }),
						...(reversed ? duplicates.reverse() : duplicates),
					],
				};
				const { migrationModeler, element } = await setup(old, {});
				const { element: migrated, report } = migrateElement({
					modeler: migrationModeler,
					element,
					fromTemplate: old,
					target,
					templates: [old, target],
					...(carry
						? {}
						: {
								recipe: parseRecipe({
									schemaVersion: 1,
									sources: [
										{
											kind: "change",
											sourceTemplateId: old.id,
											paths: [{ from: "a", to: "b" }],
										},
									],
								}),
							}),
				});
				assert.strictEqual(
					enumerateElementValues(
						getExtensionElements(migrated.businessObject),
					).find((v) => v.key === "b")?.value,
					"=secret",
				);
				if (!carry) {
					assert.strictEqual(report.moved[0]?.valueChange?.to, "=secret");
					assert.strictEqual(report.lossless, true);
				}
			});
		}
	}
	for (const property of [
		{ type: "Number", value: "2" },
		{ type: "Boolean", value: "false" },
	]) {
		test(`normalizes ${property.type} writes as the real Modeler does`, async () => {
			const old = { ...OLD, properties: [input("a", property.value)] };
			const target = {
				...NEW,
				metadata: undefined,
				properties: [input("b", "", { type: property.type })],
			};
			const { migrationModeler, element } = await setup(old, {});
			const { element: migrated, report } = migrateElement({
				modeler: migrationModeler,
				element,
				fromTemplate: old,
				target,
				templates: [old, target],
				recipe: parseRecipe({
					schemaVersion: 1,
					sources: [
						{
							kind: "change",
							sourceTemplateId: old.id,
							paths: [{ from: "a", to: "b" }],
						},
					],
				}),
			});
			assert.strictEqual(
				enumerateElementValues(
					getExtensionElements(migrated.businessObject),
				).find((v) => v.key === "b")?.value,
				`=${property.value}`,
			);
			assert.strictEqual(
				report.moved[0]?.valueChange?.to,
				`=${property.value}`,
			);
			assert.strictEqual(report.lossless, true);
		});
	}
	for (const rule of [
		{ constraints: { notEmpty: true }, value: "   ", diagnostic: /notEmpty/ },
		{
			choices: [{ name: "Allowed", value: "allowed" }],
			value: "SECRET",
			diagnostic: /choice/,
		},
		{
			constraints: { pattern: { value: "^allowed$" } },
			value: "SECRET",
			diagnostic: /pattern/,
		},
		{
			constraints: { minLength: 1 },
			value: "SECRET",
			diagnostic: /unsupported constraint minLength/,
		},
	]) {
		test(`rejects invalid carry-over before real-modeler mutation (${rule.diagnostic})`, async () => {
			const old = { ...OLD, properties: [input("b", rule.value)] };
			const target = {
				...NEW,
				metadata: undefined,
				properties: [input("b", "allowed", rule)],
			};
			const { modeler, migrationModeler, element } = await setup(old, {});
			const before = (await modeler.saveXML({ format: true })).xml;
			assert.throws(
				() =>
					migrateElement({
						modeler: migrationModeler,
						element,
						fromTemplate: old,
						target,
						templates: [old, target],
					}),
				(error) =>
					error instanceof Error &&
					/carry-over.*input:b/.test(error.message) &&
					rule.diagnostic.test(error.message) &&
					!error.message.includes("SECRET"),
			);
			assert.strictEqual((await modeler.saveXML({ format: true })).xml, before);
		});
	}
	for (const crossType of [false, true]) {
		for (const swap of [false, true]) {
			test(`reconciles simultaneous ${swap ? "swap" : "chain"} writes (cross-type=${crossType})`, async () => {
				const b = crossType
					? {
							type: "String",
							value: "second",
							binding: { type: "zeebe:taskHeader", key: "b" },
						}
					: input("b", "second");
				const old = { ...OLD, properties: [input("a", "first"), b] };
				const target = {
					...NEW,
					metadata: undefined,
					properties: [input(swap ? "a" : "c", ""), b],
				};
				const { modeler, migrationModeler, element } = await setup(old, {});
				const { element: migrated, report } = migrateElement({
					modeler: migrationModeler,
					element,
					fromTemplate: old,
					target,
					templates: [old, target],
					recipe: parseRecipe({
						schemaVersion: 1,
						sources: [
							{
								kind: "change",
								sourceTemplateId: old.id,
								paths: [
									{ from: "input:a", to: crossType ? "header:b" : "input:b" },
									{
										from: crossType ? "header:b" : "input:b",
										to: swap ? "input:a" : "input:c",
									},
								],
							},
						],
					}),
				});
				const values = enumerateElementValues(
					getExtensionElements(migrated.businessObject),
				);
				assert.strictEqual(
					values.find((item) => item.key === "b")?.value,
					"first",
				);
				assert.strictEqual(
					values.find((item) => item.key === (swap ? "a" : "c"))?.value,
					"second",
				);
				assert.deepStrictEqual(
					report.moved.map((move) => [move.from.key, move.to.key]),
					[
						["a", "b"],
						["b", swap ? "a" : "c"],
					],
				);
				assert.strictEqual(report.moved[0]?.to.bindingType, b.binding.type);
				assert.deepStrictEqual(report.dropped, []);
				assert.strictEqual(report.lossless, true);
				assert.match((await modeler.saveXML({ format: true })).xml, /second/);
			});
		}
	}

	for (const kind of ["set", "template"] as const) {
		test(`marks a mismatched ${kind} write lossy with no source drop`, async () => {
			const old = { ...OLD, properties: [input("a", "secret")] };
			const target = {
				...NEW,
				metadata: undefined,
				properties: [input("a", ""), input("b", "")],
			};
			const { migrationModeler, element } = await setup(old, {});
			const applyTemplate =
				migrationModeler.elementTemplates.applyTemplate.bind(
					migrationModeler.elementTemplates,
				);
			migrationModeler.elementTemplates = {
				set: migrationModeler.elementTemplates.set.bind(
					migrationModeler.elementTemplates,
				),
				applyTemplate(current, template) {
					const applied = applyTemplate(current, template) ?? current;
					const io = getModdleList(
						getExtensionElements(applied.businessObject),
						"values",
					).find((item) => item.$type === "zeebe:IoMapping");
					const param = getModdleList(io, "inputParameters").find(
						(item) => item.target === "b",
					);
					assert.ok(param);
					migrationModeler.modeling.updateModdleProperties(applied, param, {
						source: "unrelated",
					});
					return applied;
				},
			};
			const { report } = migrateElement({
				modeler: migrationModeler,
				element,
				fromTemplate: old,
				target,
				templates: [old, target],
				recipe: parseRecipe({
					schemaVersion: 1,
					sources: [
						{
							kind: "change",
							sourceTemplateId: old.id,
							paths: [
								kind === "set"
									? { to: "b", set: "expected" }
									: { to: "b", template: `prefix-\${a}` },
							],
						},
					],
				}),
			});
			assert.deepStrictEqual(report.dropped, []);
			assert.deepStrictEqual(
				report.added.map((item) => item.value),
				["unrelated"],
			);
			assert.strictEqual(report.lossless, false);
		});
	}

	for (const kind of ["set", "template"] as const) {
		test(`marks an inactive ${kind} write lossy even when there is no source to drop`, async () => {
			const old = { ...OLD, properties: [input("a", "secret")] };
			const target = {
				...NEW,
				metadata: undefined,
				properties: [
					input("a", ""),
					input("kind", "off", { id: "kind" }),
					input("b", "", { condition: { property: "kind", equals: "on" } }),
				],
			};
			const { migrationModeler, element } = await setup(old, {});
			const { report } = migrateElement({
				modeler: migrationModeler,
				element,
				fromTemplate: old,
				target,
				templates: [old, target],
				recipe: parseRecipe({
					schemaVersion: 1,
					sources: [
						{
							kind: "change",
							sourceTemplateId: old.id,
							paths: [
								kind === "set"
									? { to: "b", set: "static" }
									: { to: "b", template: `prefix-\${a}` },
							],
						},
					],
				}),
			});
			assert.deepStrictEqual(report.dropped, []);
			assert.deepStrictEqual(
				report.added.map((item) => item.key),
				["kind"],
			);
			assert.strictEqual(report.lossless, false);
		});
	}

	for (const kind of ["move", "set", "template"] as const) {
		test(`reconciles FEEL-normalized ${kind} writes`, async () => {
			const old = { ...OLD, properties: [input("a", "secret")] };
			const target = {
				...NEW,
				metadata: undefined,
				properties: [input("b", "", { feel: "required" })],
			};
			const { migrationModeler, element } = await setup(old, {});
			const { element: migrated, report } = migrateElement({
				modeler: migrationModeler,
				element,
				fromTemplate: old,
				target,
				templates: [old, target],
				recipe: parseRecipe({
					schemaVersion: 1,
					sources: [
						{
							kind: "change",
							sourceTemplateId: old.id,
							paths: [
								kind === "move"
									? { from: "a", to: "b" }
									: kind === "set"
										? { to: "b", set: "secret" }
										: { to: "b", template: `\${a}` },
							],
						},
					],
				}),
			});
			assert.strictEqual(
				enumerateElementValues(
					getExtensionElements(migrated.businessObject),
				).find((item) => item.key === "b")?.value,
				"=secret",
			);
			if (kind === "move") {
				assert.strictEqual(report.moved[0]?.valueChange?.to, "=secret");
				assert.strictEqual(report.lossless, true);
			} else assert.strictEqual(report.added[0]?.value, "=secret");
		});
	}
	for (const kind of ["move", "translated", "set", "template"] as const) {
		for (const finalState of [
			"removed",
			"overwritten",
			"forwarded",
			"reappeared",
		] as const) {
			test(`reconciles ${kind} writes that are ${finalState} across steps`, async () => {
				const old = { ...OLD, properties: [input("a", "secret")] };
				const intermediate = {
					...old,
					version: 2,
					properties: [input("b", "")],
				};
				const target = {
					...old,
					version: 3,
					properties: [
						input("c", ""),
						...(finalState === "overwritten" ? [input("b", "")] : []),
					],
				};
				const expected =
					kind === "move"
						? "secret"
						: kind === "translated"
							? "translated"
							: kind === "set"
								? "static"
								: "prefix-secret";
				const final =
					finalState === "reappeared"
						? { ...old, version: 4, properties: [input("b", expected)] }
						: target;
				const { modeler, migrationModeler, element } = await setup(old, {});
				const { element: migrated, report } = migrateElement({
					modeler: migrationModeler,
					element,
					fromTemplate: old,
					target: final,
					templates: [old, intermediate, target, final],
					recipe: parseRecipe({
						schemaVersion: 1,
						sources: [
							{
								kind: "upgrade",
								sourceTemplateId: old.id,
								toVersion: 2,
								paths: [
									kind === "move" || kind === "translated"
										? {
												from: "a",
												to: "b",
												...(kind === "translated"
													? {
															valueMap: {
																rules: [
																	{ match: "secret", value: "translated" },
																],
															},
														}
													: {}),
											}
										: kind === "set"
											? { to: "b", set: "static" }
											: { to: "b", template: `prefix-\${a}` },
								],
							},
							{
								kind: "upgrade",
								sourceTemplateId: old.id,
								toVersion: 3,
								paths:
									finalState === "forwarded"
										? [{ from: "b", to: "c" }]
										: finalState === "overwritten"
											? [{ to: "b", set: "replacement" }]
											: [],
							},
							...(finalState === "reappeared"
								? [
										{
											kind: "upgrade",
											sourceTemplateId: old.id,
											toVersion: 4,
											paths: [],
										},
									]
								: []),
						],
					}),
				});
				const values = enumerateElementValues(
					getExtensionElements(migrated.businessObject),
				);
				if (finalState === "forwarded") {
					assert.strictEqual(
						values.find((item) => item.key === "c")?.value,
						expected,
					);
					assert.deepStrictEqual(
						report.moved.map((item) => [item.from.key, item.to.key]),
						kind === "move" || kind === "translated" ? [["a", "c"]] : [],
					);
					assert.deepStrictEqual(
						report.added.map((item) => [item.key, item.value]),
						kind === "move" || kind === "translated" ? [] : [["c", expected]],
					);
				} else {
					assert.deepStrictEqual(report.moved, []);
					assert.deepStrictEqual(
						report.added.map((item) => [item.key, item.value]),
						finalState === "overwritten"
							? [["b", "replacement"]]
							: finalState === "reappeared"
								? [["b", expected]]
								: [],
					);
					assert.ok(
						report.dropped.some(
							(item) => item.key === "a" && item.value === "secret",
						),
					);
					assert.strictEqual(report.lossless, false);
				}
				const { xml } = await modeler.saveXML({ format: true });
				if (finalState === "removed") assert.doesNotMatch(xml, /target="b"/);
			});
		}
	}

	for (const transformed of [false, true]) {
		test(`rejects final value mismatches for ${transformed ? "translated" : "plain"} moves`, async () => {
			const old = { ...OLD, properties: [input("a", "secret")] };
			const target = {
				...NEW,
				metadata: undefined,
				properties: [input("b", "")],
			};
			const { migrationModeler, element } = await setup(old, {});
			const applyTemplate =
				migrationModeler.elementTemplates.applyTemplate.bind(
					migrationModeler.elementTemplates,
				);
			migrationModeler.elementTemplates = {
				set: migrationModeler.elementTemplates.set.bind(
					migrationModeler.elementTemplates,
				),
				applyTemplate(current, template) {
					const applied = applyTemplate(current, template) ?? current;
					const io = getModdleList(
						getExtensionElements(applied.businessObject),
						"values",
					).find((item) => item.$type === "zeebe:IoMapping");
					const param = getModdleList(io, "inputParameters").find(
						(item) => item.target === "b",
					);
					assert.ok(param);
					migrationModeler.modeling.updateModdleProperties(applied, param, {
						source: "unrelated",
					});
					return applied;
				},
			};
			const { report } = migrateElement({
				modeler: migrationModeler,
				element,
				fromTemplate: old,
				target,
				templates: [old, target],
				recipe: parseRecipe({
					schemaVersion: 1,
					sources: [
						{
							kind: "change",
							sourceTemplateId: old.id,
							paths: [
								{
									from: "a",
									to: "b",
									...(transformed
										? {
												valueMap: {
													rules: [{ match: "secret", value: "translated" }],
												},
											}
										: {}),
								},
							],
						},
					],
				}),
			});
			assert.deepStrictEqual(report.moved, []);
			assert.deepStrictEqual(
				report.dropped.map((item) => item.value),
				["secret"],
			);
			assert.deepStrictEqual(
				report.added.map((item) => item.value),
				["unrelated"],
			);
			assert.strictEqual(report.lossless, false);
		});
	}

	test("preserves a move when a discriminator write activates its conditional destination", async () => {
		const old = { ...OLD, properties: [input("a", "secret")] };
		const target = {
			...NEW,
			metadata: undefined,
			properties: [
				input("kind", "off", { id: "kind" }),
				input("b", "", { condition: { property: "kind", equals: "on" } }),
			],
		};
		const { migrationModeler, element } = await setup(old, {});
		const { element: migrated, report } = migrateElement({
			modeler: migrationModeler,
			element,
			fromTemplate: old,
			target,
			templates: [old, target],
			recipe: parseRecipe({
				schemaVersion: 1,
				sources: [
					{
						kind: "change",
						sourceTemplateId: old.id,
						paths: [
							{ from: "a", to: "b" },
							{ to: "kind", set: "on" },
						],
					},
				],
			}),
		});
		assert.strictEqual(
			enumerateElementValues(
				getExtensionElements(migrated.businessObject),
			).find((item) => item.key === "b")?.value,
			"secret",
		);
		assert.deepStrictEqual(
			report.moved.map((item) => [item.from.key, item.to.key]),
			[["a", "b"]],
		);
		assert.strictEqual(report.lossless, true);
	});
	test("rejects inconsistent applied-template context before mutation", async () => {
		const { migrationModeler, element } = await setup(OLD, {});
		assert.throws(
			() =>
				migrateElement({
					modeler: migrationModeler,
					element,
					fromTemplate: { ...OLD, version: 99 },
					target: NEW,
					templates: [OLD, NEW],
				}),
			/applied template/,
		);
	});
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
