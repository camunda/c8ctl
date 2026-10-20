/**
 * Bindings the migration engine cannot read: a value the target does not
 * keep counts as a loss (default-plugins/element-template/migration/report.ts)
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { c8WithOptions } from "../utils/cli.ts";
import {
	DIAGRAM,
	input,
	seedTemplateCache,
} from "../utils/element-template.ts";

const CALL_DIAGRAM = DIAGRAM.replace(
	'<bpmn:serviceTask id="Task_1" />',
	'<bpmn:callActivity id="Task_1" />',
);

const calledElement = {
	type: "String",
	label: "Process ID",
	value: "default-process",
	binding: { type: "zeebe:calledElement", property: "processId" },
};

const template = (version: number, properties: object[]) => ({
	$schema:
		"https://unpkg.com/@camunda/zeebe-element-templates-json-schema/resources/schema.json",
	id: "io.example.call",
	name: "Call",
	version,
	appliesTo: ["bpmn:CallActivity"],
	engines: { camunda: "^8.8" },
	properties,
});

const SOURCE = template(1, [calledElement]);
const KEEPS = template(2, [calledElement]);
const DROPS = template(2, []);

let dir = "";
let bpmn = "";
const run = (...args: string[]) =>
	c8WithOptions({ env: { C8CTL_DATA_DIR: dir } }, "element-template", ...args);

before(async () => {
	dir = mkdtempSync(join(tmpdir(), "c8ctl-unread-bindings-"));
	seedTemplateCache(dir, [SOURCE]);
	const sourcePath = join(dir, "source.json");
	writeFileSync(sourcePath, JSON.stringify(SOURCE));
	writeFileSync(join(dir, "keeps.json"), JSON.stringify(KEEPS));
	writeFileSync(join(dir, "drops.json"), JSON.stringify(DROPS));
	bpmn = join(dir, "call.bpmn");
	writeFileSync(bpmn, CALL_DIAGRAM);
	const applied = await run("apply", sourcePath, "Task_1", bpmn);
	assert.equal(applied.status, 0, applied.stderr);
	assert.match(applied.stdout, /processId="default-process"/);
	writeFileSync(
		bpmn,
		applied.stdout.replace(
			'processId="default-process"',
			'processId="user-process"',
		),
	);
});

after(() => rmSync(dir, { recursive: true, force: true }));

test("a target without the binding needs --allow-lossy", async () => {
	const original = readFileSync(bpmn, "utf-8");
	const refused = await run(
		"update",
		SOURCE.id,
		"Task_1",
		bpmn,
		"--to",
		join(dir, "drops.json"),
		"--in-place",
	);
	assert.equal(refused.status, 1);
	assert.match(refused.stderr, /1 unchecked \(processId\)/);
	assert.match(refused.stderr, /--allow-lossy/);
	assert.equal(readFileSync(bpmn, "utf-8"), original);

	const preview = await run(
		"update",
		SOURCE.id,
		"Task_1",
		bpmn,
		"--to",
		join(dir, "drops.json"),
		"--dry-run",
		"--json",
	);
	assert.equal(preview.status, 1);
	const [result] = JSON.parse(preview.stdout).results;
	assert.equal(result.lossless, false);
	assert.deepEqual(
		result.report.skipped.unchecked.map((u: { key: string }) => u.key),
		["processId"],
	);
});

test("an implicit floor step that drops the binding needs --allow-lossy even when the target restores it", async () => {
	const original = readFileSync(bpmn, "utf-8");
	const next = {
		...template(1, [calledElement]),
		id: "io.example.call.next",
		metadata: {
			migratesFrom: {
				schemaVersion: 1,
				sources: [
					{ kind: "change", sourceTemplateId: SOURCE.id, minSourceVersion: 2 },
				],
			},
		},
	};
	writeFileSync(join(dir, "next.json"), JSON.stringify(next));
	seedTemplateCache(dir, [SOURCE, DROPS]);
	const args = [
		"update",
		SOURCE.id,
		"Task_1",
		bpmn,
		"--to",
		join(dir, "next.json"),
	];
	const preview = await run(...args, "--dry-run", "--json");
	assert.equal(preview.status, 1, preview.stderr);
	const [result] = JSON.parse(preview.stdout).results;
	assert.equal(result.lossless, false);
	assert.deepEqual(
		result.report.skipped.unchecked.map((u: { key: string }) => u.key),
		["processId"],
	);
	const refused = await run(...args, "--in-place");
	assert.equal(refused.status, 1);
	assert.match(refused.stderr, /--allow-lossy/);
	assert.equal(readFileSync(bpmn, "utf-8"), original);
});

for (const embedded of [true, false]) {
	test(`${embedded ? "embedded" : "explicit"}: an inactive definition at the floor does not hide an unread binding loss`, async () => {
		const original = readFileSync(bpmn, "utf-8");
		const recipe = {
			schemaVersion: 1,
			sources: [
				{ kind: "change", sourceTemplateId: SOURCE.id, minSourceVersion: 2 },
			],
		};
		const next = {
			...template(1, [calledElement]),
			id: "io.example.call.next",
			...(embedded ? { metadata: { migratesFrom: recipe } } : {}),
		};
		const floor = template(2, [
			{
				type: "Hidden",
				id: "mode",
				value: "a",
				binding: { type: "zeebe:input", name: "mode" },
			},
			{
				...calledElement,
				type: "Hidden",
				value: "floor-process",
				condition: { property: "mode", equals: "a" },
			},
			{ ...calledElement, condition: { property: "mode", equals: "b" } },
		]);
		writeFileSync(join(dir, "next.json"), JSON.stringify(next));
		writeFileSync(join(dir, "recipe.json"), JSON.stringify(recipe));
		seedTemplateCache(dir, [SOURCE, floor]);
		const args = [
			"update",
			SOURCE.id,
			"Task_1",
			bpmn,
			"--to",
			join(dir, "next.json"),
			...(embedded ? [] : ["--recipe", join(dir, "recipe.json")]),
		];
		const preview = await run(...args, "--dry-run", "--json");
		assert.equal(preview.status, 1, preview.stderr);
		const [result] = JSON.parse(preview.stdout).results;
		assert.equal(result.lossless, false);
		assert.deepEqual(
			result.report.skipped.unchecked.map((u: { key: string }) => u.key),
			["processId"],
		);
		const refused = await run(...args, "--in-place");
		assert.equal(refused.status, 1);
		assert.match(refused.stderr, /--allow-lossy/);
		assert.equal(readFileSync(bpmn, "utf-8"), original);
	});
}

for (const embedded of [true, false]) {
	test(`${embedded ? "embedded" : "explicit"}: an implicit floor step that keeps the unread binding is lossless`, async () => {
		const recipe = {
			schemaVersion: 1,
			sources: [
				{ kind: "change", sourceTemplateId: SOURCE.id, minSourceVersion: 2 },
			],
		};
		const next = {
			...template(1, [calledElement]),
			id: "io.example.call.next",
			...(embedded ? { metadata: { migratesFrom: recipe } } : {}),
		};
		const copy = join(dir, `keeps-${embedded}.bpmn`);
		writeFileSync(copy, readFileSync(bpmn, "utf-8"));
		writeFileSync(join(dir, "next.json"), JSON.stringify(next));
		writeFileSync(join(dir, "recipe.json"), JSON.stringify(recipe));
		seedTemplateCache(dir, [SOURCE, KEEPS]);
		const args = [
			"update",
			SOURCE.id,
			"Task_1",
			copy,
			"--to",
			join(dir, "next.json"),
			...(embedded ? [] : ["--recipe", join(dir, "recipe.json")]),
		];
		const preview = await run(...args, "--dry-run", "--json");
		assert.equal(preview.status, 0, preview.stderr);
		const [result] = JSON.parse(preview.stdout).results;
		assert.equal(result.lossless, true);
		assert.deepEqual(result.report.skipped.unchecked, []);
		const written = await run(...args, "--in-place");
		assert.equal(written.status, 0, written.stderr);
		assert.match(readFileSync(copy, "utf-8"), /processId="user-process"/);
	});
}

test("a target with the identical binding keeps the value", async () => {
	const copy = join(dir, "keeps.bpmn");
	writeFileSync(copy, readFileSync(bpmn, "utf-8"));
	const result = await run(
		"update",
		SOURCE.id,
		"Task_1",
		copy,
		"--to",
		join(dir, "keeps.json"),
		"--in-place",
		"--json",
	);
	assert.equal(result.status, 0, result.stderr);
	const [element] = JSON.parse(result.stdout).results;
	assert.equal(element.lossless, true);
	assert.deepEqual(element.report.skipped.unchecked, []);
	assert.match(readFileSync(copy, "utf-8"), /processId="user-process"/);
});

for (const [name, cache, unchecked] of [
	// Without a definition, every unread value set on the element counts.
	[
		"a source missing from the cache",
		[],
		["processId", "propagateAllChildVariables", "propagateAllParentVariables"],
	],
	[
		"an engine-incompatible cached source",
		[{ ...SOURCE, engines: { camunda: "^9.0" } }],
		["processId"],
	],
] as const) {
	test(`${name} still needs --allow-lossy for a dropped unread binding`, async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "c8ctl-unread-source-"));
		try {
			seedTemplateCache(dataDir, [...cache]);
			const result = await c8WithOptions(
				{ env: { C8CTL_DATA_DIR: dataDir } },
				"element-template",
				"update",
				SOURCE.id,
				"Task_1",
				bpmn,
				"--to",
				join(dir, "drops.json"),
				"--dry-run",
				"--json",
			);
			assert.equal(result.status, 1, result.stderr);
			const [element] = JSON.parse(result.stdout).results;
			assert.equal(element.lossless, false);
			assert.deepEqual(
				element.report.skipped.unchecked.map((u: { key: string }) => u.key),
				[...unchecked],
			);
		} finally {
			rmSync(dataDir, { recursive: true, force: true });
		}
	});
}

describe("a source template that is not available", () => {
	// The applied source is in neither the cache nor a local dir, so update
	// knows its id and version but not its shape.
	const id = "io.example.call-recipe";
	const recipe = {
		schemaVersion: 1,
		sources: [
			{
				kind: "upgrade",
				sourceTemplateId: id,
				toVersion: 2,
				paths: [{ from: "a", to: "b" }],
			},
		],
	};
	const source = { ...template(1, [calledElement, input("a")]), id };
	const target = { ...template(2, [input("b")]), id };
	let applied = "";

	before(async () => {
		const sourcePath = join(dir, "recipe-source.json");
		writeFileSync(sourcePath, JSON.stringify(source));
		writeFileSync(join(dir, "recipe-target.json"), JSON.stringify(target));
		writeFileSync(
			join(dir, "recipe-embedded.json"),
			JSON.stringify({ ...target, metadata: { migratesFrom: recipe } }),
		);
		writeFileSync(join(dir, "recipe.json"), JSON.stringify(recipe));
		const diagram = join(dir, "recipe-call.bpmn");
		writeFileSync(diagram, CALL_DIAGRAM);
		const result = await run(
			"apply",
			sourcePath,
			"Task_1",
			diagram,
			"--set",
			"a=moved-value",
			"--set",
			"processId=user-process",
		);
		assert.equal(result.status, 0, result.stderr);
		applied = result.stdout;
	});

	test("a misspelled first-step read is reported, not accepted silently", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "c8ctl-stub-typo-"));
		try {
			const typoTarget = {
				...target,
				metadata: {
					migratesFrom: {
						...recipe,
						sources: [
							{
								...recipe.sources[0],
								paths: [{ from: "typo", to: "b" }],
							},
						],
					},
				},
			};
			writeFileSync(join(dataDir, "typo.json"), JSON.stringify(typoTarget));
			const bpmnCopy = join(dataDir, "call.bpmn");
			writeFileSync(bpmnCopy, applied);
			const update = (...extra: string[]) =>
				c8WithOptions(
					{ env: { C8CTL_DATA_DIR: dataDir } },
					"element-template",
					"update",
					id,
					"Task_1",
					bpmnCopy,
					"--to",
					join(dataDir, "typo.json"),
					...extra,
				);
			const preview = await update("--dry-run", "--json");
			assert.equal(preview.status, 1, preview.stderr);
			const [element] = JSON.parse(preview.stdout).results;
			assert.equal(element.lossless, false);
			assert.deepEqual(element.report.skipped.noMatch, [
				{ from: "typo", to: "b" },
			]);
			const refused = await update("--in-place");
			assert.equal(refused.status, 1);
			assert.match(refused.stderr, /--allow-lossy/);
			assert.equal(readFileSync(bpmnCopy, "utf-8"), applied);
		} finally {
			rmSync(dataDir, { recursive: true, force: true });
		}
	});

	for (const [name, when] of [
		["an absent-path guard", { path: "typo", exists: false }],
		["a present-path guard", { path: "typo", exists: true }],
	] as const) {
		test(`${name} on a missing path is reported for a stub source`, async () => {
			const dataDir = mkdtempSync(join(tmpdir(), "c8ctl-stub-guard-"));
			try {
				const guarded = {
					...target,
					metadata: {
						migratesFrom: {
							...recipe,
							sources: [
								{
									...recipe.sources[0],
									paths: [{ set: "S", to: "b", when }],
								},
							],
						},
					},
				};
				writeFileSync(join(dataDir, "guard.json"), JSON.stringify(guarded));
				const bpmnCopy = join(dataDir, "call.bpmn");
				writeFileSync(bpmnCopy, applied);
				const preview = await c8WithOptions(
					{ env: { C8CTL_DATA_DIR: dataDir } },
					"element-template",
					"update",
					id,
					"Task_1",
					bpmnCopy,
					"--to",
					join(dataDir, "guard.json"),
					"--dry-run",
					"--json",
				);
				assert.equal(preview.status, 1, preview.stderr);
				const [element] = JSON.parse(preview.stdout).results;
				assert.equal(element.lossless, false);
				assert.deepEqual(element.report.skipped.noMatch, [
					{ from: "typo", to: "b" },
				]);
			} finally {
				rmSync(dataDir, { recursive: true, force: true });
			}
		});
	}

	for (const [name, recipeArgs] of [
		["an embedded recipe", ["--to", "recipe-embedded.json"]],
		[
			"a --recipe file",
			["--to", "recipe-target.json", "--recipe", "recipe.json"],
		],
	] as const) {
		test(`${name} is used, and a dropped unread binding still needs --allow-lossy`, async () => {
			const dataDir = mkdtempSync(join(tmpdir(), "c8ctl-stub-source-"));
			const bpmnCopy = join(dataDir, "call.bpmn");
			writeFileSync(bpmnCopy, applied);
			const args = recipeArgs.map((a) =>
				a.endsWith(".json") ? join(dir, a) : a,
			);
			const update = (...extra: string[]) =>
				c8WithOptions(
					{ env: { C8CTL_DATA_DIR: dataDir } },
					"element-template",
					"update",
					id,
					"Task_1",
					bpmnCopy,
					...args,
					...extra,
				);
			try {
				const preview = await update("--dry-run", "--json");
				assert.equal(preview.status, 1, preview.stderr);
				const [element] = JSON.parse(preview.stdout).results;
				assert.equal(element.recipe.used, true);
				assert.equal(element.recipe.refusal, null);
				assert.equal(element.lossless, false);
				assert.ok(
					element.report.skipped.unchecked.some(
						(u: { key: string }) => u.key === "processId",
					),
				);

				const refused = await update("--in-place");
				assert.equal(refused.status, 1);
				assert.match(refused.stderr, /--allow-lossy/);
				assert.equal(readFileSync(bpmnCopy, "utf-8"), applied);

				const authorized = await update("--in-place", "--allow-lossy");
				assert.equal(authorized.status, 0, authorized.stderr);
				const written = readFileSync(bpmnCopy, "utf-8");
				assert.match(written, /source="moved-value" target="b"/);
				assert.match(written, /modelerTemplateVersion="2"/);
			} finally {
				rmSync(dataDir, { recursive: true, force: true });
			}
		});
	}
});

describe("an unread binding across intermediate versions", () => {
	const id = "io.example.call-chain";
	const chain = [
		{ ...template(1, [calledElement, input("a")]), id },
		{ ...template(2, [input("b")]), id },
		{
			...template(3, [calledElement, input("c")]),
			id,
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
		},
	];

	test("a version that drops it makes the later re-add lossy", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "c8ctl-unread-chain-"));
		try {
			seedTemplateCache(dataDir, chain);
			const sourcePath = join(dataDir, "v1.json");
			const targetPath = join(dataDir, "v3.json");
			writeFileSync(sourcePath, JSON.stringify(chain[0]));
			writeFileSync(targetPath, JSON.stringify(chain[2]));
			const diagram = join(dataDir, "chain.bpmn");
			writeFileSync(diagram, CALL_DIAGRAM);
			const env = { C8CTL_DATA_DIR: dataDir };
			const applied = await c8WithOptions(
				{ env },
				"element-template",
				"apply",
				sourcePath,
				"Task_1",
				diagram,
				"--set",
				"processId=user-process",
			);
			assert.equal(applied.status, 0, applied.stderr);
			writeFileSync(diagram, applied.stdout);

			const preview = await c8WithOptions(
				{ env },
				"element-template",
				"update",
				id,
				"Task_1",
				diagram,
				"--to",
				targetPath,
				"--dry-run",
				"--json",
			);
			assert.equal(preview.status, 1, preview.stderr);
			const [element] = JSON.parse(preview.stdout).results;
			assert.equal(element.lossless, false);
			assert.deepEqual(
				element.report.skipped.unchecked.map((u: { key: string }) => u.key),
				["processId"],
			);
		} finally {
			rmSync(dataDir, { recursive: true, force: true });
		}
	});
});
