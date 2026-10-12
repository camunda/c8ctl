import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	type BpmnElement,
	type MigrationModeler,
	migrateElement,
	readAppliedTemplate,
} from "../../default-plugins/element-template/migration/apply.ts";
import type { ModdleElement } from "../../default-plugins/element-template/migration/moddle.ts";
import {
	parseRecipe,
	type RecipeSource,
} from "../../default-plugins/element-template/migration/recipe.ts";
import { resolveApplications } from "../../default-plugins/element-template/migration/steps.ts";
import type { MigrationTemplate } from "../../default-plugins/element-template/migration/types.ts";
import type { ElementTemplatesService } from "../utils/element-template.ts";

const SOURCE: MigrationTemplate = {
	id: "source",
	version: 1,
	properties: [{ binding: { type: "zeebe:input", name: "a" } }],
};
const TARGET: MigrationTemplate = {
	id: "target",
	version: 2,
	properties: [{ binding: { type: "zeebe:input", name: "b" } }],
};

/** The template registered for `identity`'s id and version, whatever the order. */
function registeredFor(
	ctx: { registered: MigrationTemplate[][] },
	identity: MigrationTemplate,
) {
	return ctx.registered[0].find(
		(template) =>
			template.id === identity.id && template.version === identity.version,
	);
}

function context(
	applied: Record<string, unknown> = {
		modelerTemplate: SOURCE.id,
		modelerTemplateVersion: SOURCE.version,
	},
) {
	const businessObject: ModdleElement = {
		$type: "bpmn:ServiceTask",
		...applied,
		get(name) {
			return this[name];
		},
	};
	const element: BpmnElement = { businessObject };
	const registered: MigrationTemplate[][] = [];
	const applications: MigrationTemplate[] = [];
	const modeler: MigrationModeler = {
		elementTemplates: {
			set(templates) {
				registered.push(templates);
			},
			applyTemplate(current, template) {
				applications.push(template);
				current.businessObject.modelerTemplate = template.id;
				current.businessObject.modelerTemplateVersion = template.version;
				return current;
			},
		},
		modeling: {
			updateModdleProperties(_element, moddleElement, properties) {
				Object.assign(moddleElement, properties);
			},
		},
	};
	return { modeler, element, registered, applications };
}

describe("migration context consistency", () => {
	for (const [name, fromTemplate, applied] of [
		["source ID", { ...SOURCE, id: "different" }, undefined],
		["source version", { ...SOURCE, version: 2 }, undefined],
		["missing source version", { ...SOURCE, version: undefined }, undefined],
		["unbound element", SOURCE, {}],
		["missing applied version", SOURCE, { modelerTemplate: SOURCE.id }],
		[
			"invalid applied version",
			SOURCE,
			{ modelerTemplate: SOURCE.id, modelerTemplateVersion: -1 },
		],
	] as const) {
		test(`rejects inconsistent ${name} before vendor mutation`, () => {
			const ctx = context(applied);
			const before = structuredClone({
				...ctx.element.businessObject,
				get: undefined,
			});
			assert.throws(
				() =>
					migrateElement({
						...ctx,
						fromTemplate,
						target: TARGET,
						templates: [SOURCE, TARGET],
					}),
				/applied template/,
			);
			assert.deepEqual(ctx.registered, []);
			assert.deepEqual(ctx.applications, []);
			assert.deepEqual(
				{ ...ctx.element.businessObject, get: undefined },
				before,
			);
		});
	}

	for (const version of [0, "0", 1, "1", Number.MAX_SAFE_INTEGER]) {
		test(`accepts matching numeric/string applied version ${JSON.stringify(version)}`, () => {
			const fromTemplate = { ...SOURCE, version: Number(version) };
			const ctx = context({
				modelerTemplate: SOURCE.id,
				modelerTemplateVersion: version,
			});
			const { report, element } = migrateElement({
				...ctx,
				fromTemplate,
				target: TARGET,
				templates: [fromTemplate, TARGET],
			});
			assert.equal(report.from.version, Number(version));
			assert.deepEqual(readAppliedTemplate(element.businessObject), {
				id: report.to.id,
				version: report.to.version,
			});
		});
	}

	test("permits an unavailable-source stub and a target outside the catalog", () => {
		const ctx = context();
		const stub = { ...SOURCE, properties: [] };
		const { report } = migrateElement({
			...ctx,
			fromTemplate: stub,
			target: TARGET,
			templates: [],
		});
		assert.equal(report.from.id, SOURCE.id);
		assert.equal(report.to.id, TARGET.id);
		assert.equal(registeredFor(ctx, stub), stub);
		assert.equal(ctx.applications[0].id, TARGET.id);
	});

	for (const reverse of [false, true]) {
		test(`supplied target wins over conflicting catalog identity (reverse=${reverse})`, () => {
			const shadow = { ...TARGET, name: "catalog shadow", properties: [] };
			const catalog = reverse ? [shadow, SOURCE] : [SOURCE, shadow];
			const applications = resolveApplications(
				catalog,
				[
					{
						kind: "hop",
						templateId: TARGET.id,
						version: TARGET.version ?? 0,
						entries: [],
					},
				],
				TARGET,
			);
			assert.equal(applications[0].template, TARGET);
			const ctx = context();
			const { report } = migrateElement({
				...ctx,
				fromTemplate: SOURCE,
				target: TARGET,
				templates: catalog,
			});
			assert.equal(report.to.name, TARGET.name);
			assert.deepEqual(ctx.applications[0].properties, TARGET.properties);
			assert.ok(
				ctx.registered[0].every((template) => template.name !== shadow.name),
			);
		});
	}

	for (const catalogSource of [undefined, { ...SOURCE, properties: [] }]) {
		test(`uses the supplied source shape for coverage and registration (${catalogSource ? "conflicting catalog" : "absent catalog"})`, () => {
			const target = { ...TARGET, id: SOURCE.id, version: 2 };
			const ctx = context();
			const { report } = migrateElement({
				...ctx,
				fromTemplate: SOURCE,
				target,
				templates: catalogSource ? [catalogSource, target] : [target],
				recipe: parseRecipe({
					schemaVersion: 1,
					sources: [
						{
							kind: "upgrade",
							sourceTemplateId: SOURCE.id,
							toVersion: 2,
							paths: [{ from: "a", to: "b" }],
						},
					],
				}),
			});
			assert.equal(report.refusal, null);
			assert.equal(report.usedRecipe, true);
			assert.equal(registeredFor(ctx, SOURCE), SOURCE);
		});
	}

	for (const [name, id, version] of [
		["unchanged source", SOURCE.id, SOURCE.version],
		["wrong target ID", "different", TARGET.version],
		["wrong target version", TARGET.id, 99],
		["missing target version", TARGET.id, undefined],
		["invalid target version", TARGET.id, -1],
	] as const) {
		test(`rejects a final applied identity inconsistent with its report (${name})`, () => {
			const ctx = context();
			ctx.modeler.elementTemplates.applyTemplate = (element) => {
				element.businessObject.modelerTemplate = id;
				element.businessObject.modelerTemplateVersion = version;
				return element;
			};
			assert.throws(
				() =>
					migrateElement({
						...ctx,
						fromTemplate: SOURCE,
						target: TARGET,
						templates: [SOURCE, TARGET],
					}),
				{ message: "Migration did not apply the target template identity." },
			);
		});
	}

	for (const catalogSource of [undefined, SOURCE]) {
		test(`does not borrow source coverage from the catalog (${catalogSource ? "conflicting catalog" : "absent catalog"})`, () => {
			const ctx = context();
			const fromTemplate = { ...SOURCE, properties: [] };
			const target = { ...TARGET, id: SOURCE.id };
			const { report } = migrateElement({
				...ctx,
				fromTemplate,
				target,
				templates: catalogSource ? [catalogSource, target] : [target],
				recipe: parseRecipe({
					schemaVersion: 1,
					sources: [
						{
							kind: "upgrade",
							sourceTemplateId: SOURCE.id,
							toVersion: 2,
							paths: [{ from: "a", to: "b" }],
						},
					],
				}),
			});
			assert.match(report.refusal ?? "", /reads "a"/);
			assert.equal(report.usedRecipe, false);
			assert.equal(registeredFor(ctx, fromTemplate), fromTemplate);
		});
	}

	for (const matches of [false, true]) {
		test(`checks the returned replacement element identity (matches=${matches})`, () => {
			const ctx = context();
			const replacement = context({
				modelerTemplate: matches ? TARGET.id : SOURCE.id,
				modelerTemplateVersion: matches ? TARGET.version : SOURCE.version,
			}).element;
			ctx.modeler.elementTemplates.applyTemplate = () => replacement;
			const migrate = () =>
				migrateElement({
					...ctx,
					fromTemplate: SOURCE,
					target: TARGET,
					templates: [SOURCE, TARGET],
				});
			if (matches) assert.equal(migrate().element, replacement);
			else
				assert.throws(migrate, {
					message: "Migration did not apply the target template identity.",
				});
		});
	}
});

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
