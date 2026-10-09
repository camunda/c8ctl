import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, test } from "node:test";
import {
	type ElementValue,
	enumerateElementValues,
	getExtensionElements,
} from "../../default-plugins/element-template/migration/element-values.ts";
import { buildStepPlan } from "../../default-plugins/element-template/migration/plan.ts";
import { parseRecipe } from "../../default-plugins/element-template/migration/recipe.ts";
import type { MigrationTemplate } from "../../default-plugins/element-template/migration/types.ts";
import {
	resolveVendorBundle,
	type VendorBundle,
} from "../../default-plugins/element-template/vendor.ts";
import { asyncSpawn } from "../utils/spawn.ts";

const bindings = [
	{ prefix: "input", binding: { type: "zeebe:input", name: "b" } },
	{ prefix: "output", binding: { type: "zeebe:output", source: "b" } },
	{ prefix: "header", binding: { type: "zeebe:taskHeader", key: "b" } },
	{ prefix: "property", binding: { type: "zeebe:property", name: "b" } },
	{
		prefix: "taskDefinition",
		binding: { type: "zeebe:taskDefinition", property: "b" },
	},
	{
		prefix: "agentDefinition",
		binding: { type: "zeebe:agentDefinition", property: "b" },
	},
	{ prefix: "adHoc", binding: { type: "zeebe:adHoc", property: "b" } },
];

function input(key: string, value: string): ElementValue {
	return { key, value, bindingType: "zeebe:input", isFeel: false };
}

function entriesOf(...paths: unknown[]) {
	return parseRecipe({
		schemaVersion: 1,
		sources: [{ kind: "change", sourceTemplateId: "old", paths }],
	}).sources[0].entries;
}

const actions = [
	{ name: "rename", path: { from: "input:a" } },
	{ name: "set", path: { set: "VALUE" } },
	{ name: "template", path: { template: `\${input:a}` } },
];

describe("resolved destination write conflicts", () => {
	for (const { prefix, binding } of bindings) {
		for (const first of actions) {
			for (const second of actions) {
				test(`${prefix}: rejects ${first.name}/${second.name} alias conflicts in either order, even for equal values`, () => {
					const target = { id: "new", properties: [{ binding }] };
					const paths = [
						{ ...first.path, to: "b" },
						{ ...second.path, to: `${prefix}:b` },
					];
					for (const ordered of [paths, [...paths].reverse()]) {
						const entries = entriesOf(...ordered);
						assert.throws(
							() => buildStepPlan(entries, [input("a", "VALUE")], target),
							(error) =>
								error instanceof Error &&
								/Ambiguous migration/.test(error.message) &&
								error.message.includes(entries[0].label) &&
								error.message.includes(entries[1].label),
						);
					}
				});
			}
		}
	}

	const guards = [
		{ name: "equals", when: { path: "input:mode", equals: "on" } },
		{ name: "matches", when: { path: "input:mode", matches: "o*" } },
		{ name: "in", when: { path: "input:mode", in: ["on", "ready"] } },
		{
			name: "negation",
			when: { path: "input:mode", equals: "off", not: true },
		},
		{ name: "exists", when: { path: "input:mode", exists: true } },
		{
			name: "conjunction",
			when: [
				{ path: "input:mode", equals: "on" },
				{ path: "input:a", exists: true },
			],
		},
	];
	for (const { prefix, binding } of bindings) {
		test(`${prefix}: canonical aliases retain literal colons and whitespace in destination keys`, () => {
			for (const key of ["namespace:b", "b:c:d", "b b", " b ", ":b"]) {
				const resolvedBinding = {
					...binding,
					...(binding.type === "zeebe:output"
						? { source: key }
						: binding.type === "zeebe:taskHeader"
							? { key }
							: binding.type === "zeebe:input" ||
									binding.type === "zeebe:property"
								? { name: key }
								: { property: key }),
				};
				const paths = [
					{ from: "input:a", to: key },
					{ to: `${prefix}:${key}`, set: "other" },
				];
				for (const ordered of [paths, [...paths].reverse()])
					assert.throws(
						() =>
							buildStepPlan(entriesOf(...ordered), [input("a", "VALUE")], {
								id: "new",
								properties: [{ binding: resolvedBinding }],
							}),
						/Ambiguous migration/,
					);
			}
		});
	}

	test("qualified literal prefix-bearing keys remain distinct from their shorter alias keys", () => {
		const target = {
			id: "new",
			properties: ["b", "input:b", "header:b"].map((name) => ({
				binding: { type: "zeebe:input", name },
			})),
		};
		const paths = [
			{ to: "b", set: "short" },
			{ to: "input:input:b", set: "literal input" },
			{ to: "input:header:b", set: "literal header" },
		];
		for (const ordered of [paths, [...paths].reverse()]) {
			const plan = buildStepPlan(entriesOf(...ordered), [], target);
			assert.deepEqual(
				plan.writes.map((w) => [w.bindingType, w.key, w.value]).sort(),
				[
					["zeebe:input", "b", "short"],
					["zeebe:input", "header:b", "literal header"],
					["zeebe:input", "input:b", "literal input"],
				],
			);
			assert.throws(
				() =>
					buildStepPlan(
						entriesOf(...ordered, { to: "input:b", set: "overwrite" }),
						[],
						target,
					),
				/Ambiguous migration/,
			);
		}
	});

	test("value maps and FEEL passthrough cannot bypass resolved write conflicts", () => {
		for (const value of ["VALUE", "=secret"]) {
			for (const valueMap of [
				{ rules: [{ match: "*", value: "mapped" }] },
				{ rules: [{ match: "no", value: "mapped" }], default: "fallback" },
			]) {
				const paths = [
					{ from: "input:a", to: "b", valueMap },
					{ to: "input:b", set: "other" },
				];
				for (const ordered of [paths, [...paths].reverse()])
					assert.throws(
						() =>
							buildStepPlan(
								entriesOf(...ordered),
								[{ ...input("a", value), isFeel: value.startsWith("=") }],
								{ id: "new", properties: [{ binding: bindings[0].binding }] },
							),
						/Ambiguous migration/,
					);
			}
		}
	});

	test("guarded conflicts use the original snapshot even when another write changes the guard path", () => {
		const target = {
			id: "new",
			properties: ["b", "mode"].map((name) => ({
				binding: { type: "zeebe:input", name },
			})),
		};
		const paths = [
			{ to: "mode", set: "off" },
			{ from: "input:a", to: "b", when: { path: "mode", equals: "on" } },
			{ to: "input:b", set: "other", when: { path: "mode", equals: "on" } },
		];
		for (const ordered of [
			paths,
			[...paths].reverse(),
			[...paths.slice(1), paths[0]],
		])
			assert.throws(
				() =>
					buildStepPlan(
						entriesOf(...ordered),
						[input("a", "VALUE"), input("mode", "on")],
						target,
					),
				/Ambiguous migration/,
			);
	});

	for (const guard of guards) {
		test(`rejects simultaneously active nested ${guard.name} guarded alias writes in either order`, () => {
			const paths = [
				{ when: guard.when, rules: [{ from: "input:a", to: "b" }] },
				{
					when: { path: "input:a", exists: true },
					rules: [{ to: "input:b", set: "other" }],
				},
			];
			for (const ordered of [paths, [...paths].reverse()])
				assert.throws(
					() =>
						buildStepPlan(
							entriesOf(...ordered),
							[input("a", "VALUE"), input("mode", "on")],
							{ id: "new", properties: [{ binding: bindings[0].binding }] },
						),
					/Ambiguous migration/,
				);
		});
	}

	for (const { prefix, binding } of bindings) {
		test(`${prefix}: permits mutually exclusive nested rename/set writes and preserves only active facts`, () => {
			const paths = [
				{
					when: { path: "input:mode", equals: "on" },
					rules: [{ from: "input:a", to: "b", note: "rename selected" }],
				},
				{
					when: { path: "input:mode", equals: "off" },
					rules: [{ to: `${prefix}:b`, set: "fallback", note: "set selected" }],
				},
			];
			for (const ordered of [paths, [...paths].reverse()]) {
				for (const mode of ["on", "off", "neither"]) {
					const plan = buildStepPlan(
						entriesOf(...ordered),
						[input("a", "VALUE"), input("mode", mode)],
						{ id: "new", properties: [{ binding }] },
					);
					assert.deepEqual(
						plan.writes.map((w) => [w.bindingType, w.key, w.value]),
						mode === "neither"
							? []
							: [[binding.type, "b", mode === "on" ? "VALUE" : "fallback"]],
					);
					assert.equal(plan.facts.moved.length, mode === "on" ? 1 : 0);
					assert.equal(plan.facts.set.length, mode === "off" ? 1 : 0);
					assert.deepEqual(
						plan.facts.notes.map((note) => note.message),
						mode === "neither"
							? []
							: [mode === "on" ? "rename selected" : "set selected"],
					);
				}
			}
		});
	}

	test("does not reserve destinations for missing, unmapped or incomplete source writes", () => {
		for (const skipped of [
			{ from: "missing", to: "b" },
			{
				from: "a",
				to: "b",
				valueMap: { rules: [{ match: "no", value: "x" }] },
			},
			{ to: "b", template: `\${input:a}-\${missing}` },
		]) {
			const paths = [skipped, { to: "input:b", set: "fallback" }];
			for (const ordered of [paths, [...paths].reverse()]) {
				const plan = buildStepPlan(
					entriesOf(...ordered),
					[input("a", "VALUE")],
					{
						id: "new",
						properties: [{ binding: bindings[0].binding }],
					},
				);
				assert.deepEqual(
					plan.writes.map((w) => w.value),
					["fallback"],
				);
			}
		}
	});

	test("rejects conflicts when a rename source is present but empty", () => {
		const paths = [
			{ from: "a", to: "b" },
			{ to: "input:b", set: "" },
		];
		for (const ordered of [paths, [...paths].reverse()])
			assert.throws(
				() =>
					buildStepPlan(entriesOf(...ordered), [input("a", "")], {
						id: "new",
						properties: [{ binding: bindings[0].binding }],
					}),
				/Ambiguous migration/,
			);
	});

	test("keeps every qualified same-key binding independently writable regardless of order", () => {
		const target = {
			id: "new",
			properties: bindings.map(({ binding }) => ({ binding })),
		};
		const paths = bindings.map(({ prefix }, index) => ({
			to: `${prefix}:b`,
			set: `value-${index}`,
		}));
		for (const ordered of [paths, [...paths].reverse()]) {
			const plan = buildStepPlan(entriesOf(...ordered), [], target);
			assert.deepEqual(
				plan.writes.map((w) => [w.bindingType, w.key, w.value]).sort(),
				bindings
					.map(({ binding }, index) => [binding.type, "b", `value-${index}`])
					.sort(),
			);
			assert.deepEqual(
				plan.facts.set.map((w) => [w.bindingType, w.key, w.value]).sort(),
				plan.writes.map((w) => [w.bindingType, w.key, w.value]).sort(),
			);
		}
		assert.throws(
			() => buildStepPlan(entriesOf({ to: "b", set: "x" }), [], target),
			/several binding types/,
		);
	});

	test("qualified guards and sources keep simultaneously active same-key input/header writes distinct", () => {
		const paths = [
			{
				from: "input:a",
				to: "input:b",
				when: { path: "input:mode", equals: "on" },
			},
			{
				from: "header:a",
				to: "header:b",
				when: { path: "header:mode", equals: "ready" },
			},
		];
		const values = [
			input("a", "INPUT"),
			{ ...input("a", "HEADER"), bindingType: "zeebe:taskHeader" },
			input("mode", "on"),
			{ ...input("mode", "ready"), bindingType: "zeebe:taskHeader" },
		];
		const target = {
			id: "new",
			properties: [bindings[0], bindings[2]].map(({ binding }) => ({
				binding,
			})),
		};
		for (const ordered of [paths, [...paths].reverse()]) {
			const plan = buildStepPlan(entriesOf(...ordered), values, target);
			assert.deepEqual(
				plan.writes.map((w) => [w.bindingType, w.value]).sort(),
				[
					["zeebe:input", "INPUT"],
					["zeebe:taskHeader", "HEADER"],
				],
			);
			assert.deepEqual(
				plan.facts.moved
					.map((move) => [move.from.bindingType, move.to.bindingType])
					.sort(),
				[
					["zeebe:input", "zeebe:input"],
					["zeebe:taskHeader", "zeebe:taskHeader"],
				],
			);
		}
		for (const prefix of ["input", "header"]) {
			const conflicting = [...paths, { to: `${prefix}:b`, set: "overwrite" }];
			for (const ordered of [conflicting, [...conflicting].reverse()])
				assert.throws(
					() => buildStepPlan(entriesOf(...ordered), values, target),
					/Ambiguous migration/,
				);
		}
	});

	test("duplicate conditional template properties still identify one destination", () => {
		const target = {
			id: "new",
			properties: [
				{
					id: "mode",
					value: "on",
					binding: { type: "zeebe:input", name: "mode" },
				},
				{
					binding: bindings[0].binding,
					condition: { property: "mode", equals: "on" },
				},
				{
					binding: bindings[0].binding,
					condition: { property: "mode", equals: "off" },
				},
			],
		};
		const paths = [
			{ from: "a", to: "b" },
			{ to: "input:b", set: "other" },
		];
		for (const ordered of [paths, [...paths].reverse()])
			assert.throws(
				() =>
					buildStepPlan(entriesOf(...ordered), [input("a", "VALUE")], target),
				/Ambiguous migration/,
			);
	});
});

const TASK = "Activity_17s7axj";

function template(id: string, properties: object[], paths?: unknown[]) {
	return {
		id,
		name: id,
		version: 1,
		appliesTo: ["bpmn:Task"],
		engines: { camunda: "^8.8" },
		properties: [
			{
				type: "Hidden",
				value: "worker",
				binding: { type: "zeebe:taskDefinition", property: "type" },
			},
			...properties,
		],
		...(paths
			? {
					metadata: {
						migratesFrom: {
							schemaVersion: 1,
							sources: [{ kind: "change", sourceTemplateId: "old", paths }],
						},
					},
				}
			: {}),
	};
}

function property(name: string, value: string) {
	return {
		type: "String",
		label: name,
		value,
		binding: { type: "zeebe:input", name },
	};
}

for (const reversed of [false, true]) {
	test(`CLI refuses guarded alias conflicts without stdout or file mutation (reversed=${reversed})`, async (t) => {
		const dir = mkdtempSync(join(tmpdir(), "c8-write-conflict-"));
		t.after(() => rmSync(dir, { recursive: true, force: true }));
		const old = template("old", [
			property("a", "VALUE"),
			property("mode", "on"),
		]);
		const paths = [
			{ from: "input:a", to: "b", when: { path: "input:mode", equals: "on" } },
			{ to: "input:b", set: "other", when: { path: "input:mode", in: ["on"] } },
		];
		const target = template(
			"new",
			[property("b", "")],
			reversed ? paths.reverse() : paths,
		);
		mkdirSync(join(dir, "element-templates"));
		writeFileSync(
			join(dir, "element-templates/templates.json"),
			JSON.stringify([old, target]),
		);
		const oldPath = join(dir, "old.json");
		const targetPath = join(dir, "new.json");
		const bpmn = join(dir, "process.bpmn");
		writeFileSync(oldPath, JSON.stringify(old));
		writeFileSync(targetPath, JSON.stringify(target));
		const run = (...args: string[]) =>
			asyncSpawn(
				"node",
				[
					"--experimental-strip-types",
					"src/index.ts",
					"element-template",
					...args,
				],
				{
					env: {
						...process.env,
						C8CTL_DATA_DIR: dir,
						CAMUNDA_BASE_URL: "http://test-cluster/v2",
					},
				},
			);
		const seeded = await run(
			"apply",
			oldPath,
			TASK,
			resolve("tests/fixtures/simple.bpmn"),
		);
		assert.equal(seeded.status, 0, seeded.stderr);
		writeFileSync(bpmn, seeded.stdout);
		for (const flags of [
			[],
			["--in-place", "--allow-lossy"],
			["--in-place", "--dry-run", "--json"],
		]) {
			const result = await run("change", targetPath, TASK, bpmn, ...flags);
			assert.equal(result.status, 1, result.stderr);
			assert.match(result.stderr, /Ambiguous migration/);
			assert.equal(result.stdout, "");
			assert.equal(readFileSync(bpmn, "utf-8"), seeded.stdout);
			assert.equal(existsSync(`${bpmn}.migration.lock`), false);
		}
	});
}

test("CLI persists independent qualified input/header writes with the same key", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "c8-distinct-writes-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const old = template("old", [
		property("a", "INPUT"),
		property("c", "HEADER"),
	]);
	const targetProperties = [
		property("b", ""),
		{
			type: "String",
			label: "Header",
			value: "",
			binding: { type: "zeebe:taskHeader", key: "b" },
		},
	];
	const paths = [
		{ from: "input:a", to: "input:b" },
		{ from: "input:c", to: "header:b" },
	];
	mkdirSync(join(dir, "element-templates"));
	writeFileSync(
		join(dir, "element-templates/templates.json"),
		JSON.stringify([old]),
	);
	const oldPath = join(dir, "old.json");
	const targetPath = join(dir, "new.json");
	const bpmn = join(dir, "process.bpmn");
	writeFileSync(oldPath, JSON.stringify(old));
	const run = (...args: string[]) =>
		asyncSpawn(
			"node",
			[
				"--experimental-strip-types",
				"src/index.ts",
				"element-template",
				...args,
			],
			{
				env: {
					...process.env,
					C8CTL_DATA_DIR: dir,
					CAMUNDA_BASE_URL: "http://test-cluster/v2",
				},
			},
		);
	const seeded = await run(
		"apply",
		oldPath,
		TASK,
		resolve("tests/fixtures/simple.bpmn"),
	);
	assert.equal(seeded.status, 0, seeded.stderr);
	const vendor: VendorBundle = createRequire(import.meta.url)(
		resolveVendorBundle(),
	);
	for (const ordered of [paths, [...paths].reverse()]) {
		const target: MigrationTemplate = template(
			"new",
			targetProperties,
			ordered,
		);
		writeFileSync(targetPath, JSON.stringify(target));
		writeFileSync(bpmn, seeded.stdout);
		const result = await run(
			"change",
			targetPath,
			TASK,
			bpmn,
			"--in-place",
			"--json",
		);
		assert.equal(result.status, 0, result.stderr);
		const envelope = JSON.parse(result.stdout);
		assert.equal(envelope.lossless, true);
		assert.deepEqual(envelope.report.dropped, []);
		assert.deepEqual(
			envelope.report.moved
				.map((move: { to: { bindingType: string; key: string } }) => [
					move.to.bindingType,
					move.to.key,
				])
				.sort(),
			[
				["zeebe:input", "b"],
				["zeebe:taskHeader", "b"],
			],
		);
		const modeler = new vendor.Modeler({
			additionalModules: [
				vendor.HeadlessTextRendererModule,
				vendor.CloudElementTemplatesCoreModule,
			],
			moddleExtensions: { zeebe: vendor.ZeebeModdleExtension },
		});
		await modeler.importXML(readFileSync(bpmn, "utf-8"));
		const element = modeler.get("elementRegistry").get(TASK);
		assert.ok(element);
		assert.deepEqual(
			enumerateElementValues(getExtensionElements(element.businessObject))
				.filter((value) => value.key === "b")
				.map((value) => [value.bindingType, value.value])
				.sort(),
			[
				["zeebe:input", "INPUT"],
				["zeebe:taskHeader", "HEADER"],
			],
		);
	}
});
