/**
 * MIG-006: unusable explicit recipes and lossy overwrites fail closed
 * (default-plugins/element-template/commands/migrate.ts)
 */

import assert from "node:assert/strict";
import {
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { c8WithEnv } from "../utils/cli.ts";
import {
	labelledInput as input,
	seedTemplateCache,
} from "../utils/element-template.ts";
import {
	createUpdateWorkspace,
	updateFixtures,
} from "../utils/update-workspace.ts";

const TASK = "Activity_17s7axj";
const dir = mkdtempSync(join(tmpdir(), "c8ctl-migration-refusal-"));
const source = {
	id: "refusal.source",
	name: "Source",
	version: 1,
	appliesTo: ["bpmn:Task"],
	properties: [input("kept", "retained"), input("removed", "lost-value")],
};
const upgrade = {
	...source,
	version: 2,
	metadata: {
		migratesFrom: {
			schemaVersion: 1,
			sources: [{ kind: "upgrade", sourceTemplateId: source.id, toVersion: 2 }],
		},
	},
};
let original: string;
const XML = /<\?xml|<bpmn:definitions/;
const out = (result: { stdout: string; stderr: string }) =>
	result.stdout + result.stderr;
// A failed or blocked run exits 1, prints its report, and never prints BPMN.
function assertRefused(
	result: { status: number | null; stdout: string; stderr: string },
	flags: string[],
) {
	assert.equal(result.status, 1, result.stderr);
	assert.doesNotMatch(result.stdout, XML);
	if (!flags.includes("--in-place") && !flags.includes("--dry-run"))
		assert.equal(result.stdout, "");
}

before(async () => {
	const path = join(dir, "source.json");
	writeFileSync(path, JSON.stringify(source));
	const seeded = await c8WithEnv(
		{ C8CTL_DATA_DIR: dir, C8CTL_OUTPUT_MODE: "text" },
		"element-template",
		"apply",
		path,
		TASK,
		"tests/fixtures/simple.bpmn",
	);
	assert.equal(seeded.status, 0, seeded.stderr);
	original = seeded.stdout;
});
after(() => rmSync(dir, { recursive: true, force: true }));

for (const args of [
	["help", "element-template"],
	["completion", "bash"],
	["completion", "zsh"],
	["completion", "fish"],
]) {
	test(`loss authorization is discoverable through ${args.join(" ")}`, async () => {
		const result = await c8WithEnv(
			{ C8CTL_DATA_DIR: dir, C8CTL_OUTPUT_MODE: "text" },
			...args,
		);
		assert.equal(result.status, 0, result.stderr);
		assert.ok(
			result.stdout.includes("allow-lossy"),
			`${args.join(" ")} must expose --allow-lossy`,
		);
	});
}

function setup({
	action = "change",
	recipe,
	embedded = false,
	lineage = [],
	lossy = false,
	targetProperties,
	sourceTemplate = source,
	diagram = original,
}: {
	action?: "change" | "update";
	recipe?: unknown;
	embedded?: boolean;
	lineage?: object[];
	lossy?: boolean;
	targetProperties?: object[];
	sourceTemplate?: object;
	diagram?: string;
} = {}) {
	const work = mkdtempSync(join(dir, "case-"));
	const target = {
		...source,
		id: action === "change" ? "refusal.target" : source.id,
		name: "Target",
		version: 3,
		properties:
			targetProperties ?? (lossy ? [input("kept")] : source.properties),
		...(embedded ? { metadata: { migratesFrom: recipe } } : {}),
	};
	seedTemplateCache(work, [sourceTemplate, ...lineage, target]);
	const targetPath = join(work, "target.json");
	writeFileSync(targetPath, JSON.stringify(target));
	const recipePath = join(work, "recipe.json");
	if (recipe !== undefined && !embedded)
		writeFileSync(
			recipePath,
			typeof recipe === "string" ? recipe : JSON.stringify(recipe),
		);
	const file = join(work, "diagram.bpmn");
	writeFileSync(file, diagram);
	const mtime = statSync(file).mtimeMs;
	return {
		file,
		run: (...flags: string[]) =>
			c8WithEnv(
				{ C8CTL_DATA_DIR: work, C8CTL_OUTPUT_MODE: "text", NO_COLOR: "1" },
				"element-template",
				"update",
				source.id,
				TASK,
				file,
				...(action === "change" ? ["--to", targetPath] : []),
				...(recipe !== undefined && !embedded ? ["--recipe", recipePath] : []),
				...flags,
			),
		assertUnchanged: () => {
			assert.equal(readFileSync(file, "utf8"), diagram);
			assert.equal(statSync(file).mtimeMs, mtime);
		},
	};
}

for (const action of ["change", "update"] as const) {
	const entry =
		action === "change"
			? { kind: "change", sourceTemplateId: source.id }
			: { kind: "upgrade", sourceTemplateId: source.id, toVersion: 3 };
	for (const scenario of [
		{
			name: "wrong source ID",
			sources: [{ kind: "change", sourceTemplateId: "unrelated.source" }],
			diagnostic: /wrong source ID.*refusal\.source/i,
			// An explicit recipe without an entry for the source is refused up front.
			explicitDiagnostic: /no source entry for template 'refusal\.source'/,
			lineage: [upgrade],
		},
		{
			name: "coverage refusal",
			sources: [
				{
					kind: "upgrade",
					sourceTemplateId: source.id,
					toVersion: 2,
					paths: [{ from: "missing", to: "kept" }],
				},
			],
			diagnostic: /incomplete.*reads.*missing/,
			lineage: [
				{
					...upgrade,
					metadata: {
						migratesFrom: {
							schemaVersion: 1,
							sources: [
								{
									kind: "upgrade",
									sourceTemplateId: source.id,
									toVersion: 2,
									paths: [{ from: "missing", to: "kept" }],
								},
							],
						},
					},
				},
			],
		},
		...(action === "change"
			? [
					{
						name: "hop coverage refusal",
						sources: [
							{ ...entry, paths: [{ from: "misspelled", to: "kept" }] },
						],
						diagnostic:
							/incomplete.*change from refusal\.source reads .*misspelled/,
						lineage: [],
					},
				]
			: []),
	]) {
		// A change recipe's upgrades belong to the target, never the source.
		const sources =
			action === "change" && scenario.name === "coverage refusal"
				? [{ ...entry, minSourceVersion: 2 }]
				: scenario.sources;
		for (const embedded of [false, true]) {
			test(`${action}: ${embedded ? "embedded" : "explicit"} ${scenario.name} fails closed`, async () => {
				const fixture = setup({
					action,
					recipe: { schemaVersion: 1, sources },
					embedded,
					lineage: scenario.lineage,
				});
				for (const flags of [[], ["--in-place"], ["--in-place", "--json"]]) {
					const result = await fixture.run(...flags);
					assertRefused(result, flags);
					assert.match(
						out(result),
						(!embedded && scenario.explicitDiagnostic) || scenario.diagnostic,
					);
					if (embedded) assert.match(result.stderr, /--allow-lossy/);
					fixture.assertUnchanged();
				}
				if (!embedded) {
					for (const flags of [
						["--in-place", "--allow-lossy"],
						["--dry-run"],
						["--dry-run", "--json"],
						["--dry-run", "--json", "--allow-lossy"],
					]) {
						const result = await fixture.run(...flags);
						assertRefused(result, flags);
						assert.match(
							out(result),
							(!embedded && scenario.explicitDiagnostic) || scenario.diagnostic,
						);
						fixture.assertUnchanged();
					}
				} else {
					const textPreview = await fixture.run("--dry-run");
					assertRefused(textPreview, ["--dry-run"]);
					assert.match(textPreview.stdout, scenario.diagnostic);
					assert.match(textPreview.stdout, /Requires --allow-lossy/);
					fixture.assertUnchanged();
					const preview = await fixture.run("--dry-run", "--json");
					assertRefused(preview, ["--dry-run", "--json"]);
					const doc = JSON.parse(preview.stdout);
					assert.equal(doc.summary.blocked, 1);
					const envelope = doc.results[0];
					assert.equal(envelope.requiresAuthorization, true);
					assert.equal(envelope.authorized, false);
					assert.equal(envelope.recipe.used, false);
					assert.match(envelope.recipe.refusal, scenario.diagnostic);
					fixture.assertUnchanged();
					for (const flags of [
						["--allow-lossy"],
						["--in-place", "--allow-lossy", "--json"],
					]) {
						const result = await fixture.run(...flags);
						assert.equal(result.status, 0, result.stderr);
						if (flags.includes("--json")) {
							const authorized = JSON.parse(result.stdout).results[0];
							assert.equal(authorized.authorized, true);
							assert.match(authorized.recipe.refusal, scenario.diagnostic);
						} else {
							assert.match(result.stderr, scenario.diagnostic);
							assert.match(result.stderr, /Authorized with --allow-lossy/);
							fixture.assertUnchanged();
						}
					}
				}
			});
		}
	}

	if (action === "update") {
		for (const embedded of [false, true]) {
			test(`update: ${embedded ? "embedded" : "explicit"} recipe that stops short of the target carries values over`, async () => {
				const fixture = setup({
					action,
					embedded,
					recipe: {
						schemaVersion: 1,
						sources: [{ ...entry, toVersion: 1 }],
					},
				});
				const result = await fixture.run("--dry-run", "--json");
				assert.equal(result.status, 0, result.stderr);
				const envelope = JSON.parse(result.stdout).results[0];
				assert.equal(envelope.recipe.refusal, null);
				assert.equal(envelope.requiresAuthorization, false);
				fixture.assertUnchanged();
			});
		}
	}

	for (const embedded of [false, true]) {
		for (const paths of [undefined, []]) {
			test(`${action}: intentional ${paths ? "empty" : "omitted"} paths use an ${embedded ? "embedded" : "explicit"} recipe`, async () => {
				const fixture = setup({
					action,
					embedded,
					recipe: { schemaVersion: 1, sources: [{ ...entry, paths }] },
				});
				const result = await fixture.run("--dry-run", "--json");
				assert.equal(result.status, 0, result.stderr);
				const envelope = JSON.parse(result.stdout).results[0];
				assert.equal(envelope.recipe.used, true);
				assert.equal(envelope.recipe.refusal, null);
				assert.equal(envelope.requiresAuthorization, false);
				fixture.assertUnchanged();
			});
		}
	}
}

for (const recipe of [
	"{ invalid JSON",
	{ schemaVersion: 1, sources: [{ kind: "invalid" }] },
]) {
	test(`invalid explicit recipe syntax cannot be authorized: ${JSON.stringify(recipe)}`, async () => {
		const fixture = setup({ recipe });
		for (const flags of [
			["--in-place", "--allow-lossy"],
			["--dry-run", "--json"],
		]) {
			const result = await fixture.run(...flags);
			assert.equal(result.status, 1, result.stderr);
			assert.equal(result.stdout, "");
			assert.match(result.stderr, /recipe.*(?:JSON|Invalid|kind)/i);
			fixture.assertUnchanged();
		}
	});
}

for (const action of ["change", "update"] as const) {
	test(`${action}: an empty explicit recipe path cannot become ordinary carry-over`, async () => {
		const fixture = setup({ action });
		for (const recipeFlags of [["--recipe="], ["--recipe", ""]]) {
			for (const flags of [
				["--in-place", "--allow-lossy"],
				["--dry-run", "--json", "--allow-lossy"],
			]) {
				const result = await fixture.run(...recipeFlags, ...flags);
				assert.equal(result.status, 1, result.stderr);
				assert.equal(result.stdout, "");
				assert.match(result.stderr, /--recipe requires a value/);
				fixture.assertUnchanged();
			}
		}
	});
}

test("invalid required source recipe cannot silently satisfy a target floor", async () => {
	const fixture = setup({
		recipe: {
			schemaVersion: 1,
			sources: [
				{ kind: "change", sourceTemplateId: source.id, minSourceVersion: 2 },
			],
		},
		lineage: [
			{
				...upgrade,
				metadata: {
					migratesFrom: {
						schemaVersion: 1,
						sources: [
							{
								kind: "upgrade",
								sourceTemplateId: source.id,
								toVersion: 2,
								unknown: true,
							},
						],
					},
				},
			},
		],
	});
	for (const flags of [
		["--in-place", "--allow-lossy"],
		["--dry-run", "--json"],
	]) {
		const result = await fixture.run(...flags);
		assertRefused(result, flags);
		assert.match(out(result), /Invalid migration recipe.*unknown/);
		fixture.assertUnchanged();
	}
});

test("ordinary carry-over previews losses and requires authorization only for overwrite", async () => {
	const fixture = setup({ lossy: true });
	for (const json of [false, true]) {
		const preview = await fixture.run(
			"--in-place",
			"--dry-run",
			...(json ? ["--json"] : []),
		);
		// The equivalent --in-place run would be blocked, so the preview exits 1.
		assertRefused(preview, ["--in-place", "--dry-run"]);
		if (json) {
			const doc = JSON.parse(preview.stdout);
			assert.equal(doc.summary.blocked, 1);
			const envelope = doc.results[0];
			assert.equal(envelope.requiresAuthorization, true);
			assert.equal(envelope.authorized, false);
			assert.equal(envelope.lossless, false);
			assert.equal(envelope.recipe.used, false);
			assert.equal(envelope.recipe.refusal, null);
			assert.ok(
				envelope.report.dropped.some(
					(field: { key: string }) => field.key === "removed",
				),
			);
		} else {
			assert.match(preview.stdout, /Dropped/);
			assert.match(preview.stdout, /Requires --allow-lossy/);
		}
		fixture.assertUnchanged();
	}
	const refused = await fixture.run("--in-place");
	assert.equal(refused.status, 1, refused.stderr);
	assert.equal(refused.stdout, "");
	assert.match(refused.stderr, /--allow-lossy/);
	fixture.assertUnchanged();
	const xml = await fixture.run();
	assert.equal(xml.status, 0, xml.stderr);
	assert.match(xml.stderr, /Dropped/);
	assert.doesNotMatch(xml.stdout, /lost-value/);
	fixture.assertUnchanged();
	const authorized = await fixture.run("--in-place", "--allow-lossy", "--json");
	assert.equal(authorized.status, 0, authorized.stderr);
	assert.equal(JSON.parse(authorized.stdout).results[0].authorized, true);
	assert.doesNotMatch(readFileSync(fixture.file, "utf8"), /lost-value/);
});

describe("change floor above the reached version", () => {
	const floor = (minSourceVersion: number) => ({
		schemaVersion: 1,
		sources: [
			{ kind: "change", sourceTemplateId: source.id, minSourceVersion },
		],
	});

	for (const embedded of [false, true]) {
		const kind = embedded ? "embedded" : "explicit";

		test(`${kind}: a loaded floor version is reached by an implicit step`, async () => {
			const fixture = setup({
				recipe: floor(2),
				embedded,
				lineage: [{ ...source, version: 2 }],
			});
			const json = await fixture.run("--dry-run", "--json");
			assert.equal(json.status, 0, json.stderr);
			const envelope = JSON.parse(json.stdout).results[0];
			assert.equal(envelope.status, "updated");
			assert.equal(envelope.recipe.used, true);
			assert.equal(envelope.recipe.refusal, null);
			assert.equal(envelope.requiresAuthorization, false);
			assert.deepEqual(
				envelope.report.steps.map(
					(step: { kind: string; toVersion: number; implicit?: true }) => [
						step.kind,
						step.toVersion,
						step.implicit,
					],
				),
				[
					["version", 2, true],
					["hop", 3, undefined],
				],
			);
			fixture.assertUnchanged();
			const text = await fixture.run("--dry-run");
			assert.match(
				text.stdout,
				/The element is on v1, which is too old for this recipe\. Updating it to v2 first\./,
			);
			const written = await fixture.run("--in-place");
			assert.equal(written.status, 0, written.stderr);
			assert.notEqual(readFileSync(fixture.file, "utf8"), original);
		});

		test(`${kind}: a value the floor version lacks is reported as dropped even when the target defaults it`, async () => {
			const fixture = setup({
				recipe: floor(2),
				embedded,
				lineage: [
					{ ...source, version: 2, properties: [input("kept", "retained")] },
				],
				targetProperties: [
					input("kept", "retained"),
					input("removed", "other-default"),
				],
			});
			const preview = await fixture.run("--dry-run", "--json");
			assertRefused(preview, ["--dry-run", "--json"]);
			const envelope = JSON.parse(preview.stdout).results[0];
			assert.equal(envelope.lossless, false);
			assert.equal(envelope.requiresAuthorization, true);
			assert.deepEqual(
				envelope.report.dropped.map((item: { key: string; value: string }) => [
					item.key,
					item.value,
				]),
				[["removed", "lost-value"]],
			);
			const blocked = await fixture.run("--in-place");
			assertRefused(blocked, ["--in-place"]);
			assert.match(blocked.stderr, /--allow-lossy/);
			fixture.assertUnchanged();
			const authorized = await fixture.run("--in-place", "--allow-lossy");
			assert.equal(authorized.status, 0, authorized.stderr);
			assert.notEqual(readFileSync(fixture.file, "utf8"), original);
		});

		test(`${kind}: a value the floor version overwrites at a hidden binding is reported as dropped`, async () => {
			const fixture = setup({
				recipe: floor(2),
				embedded,
				lineage: [
					{
						...source,
						version: 2,
						properties: [
							input("kept", "retained"),
							input("removed", "floor-default", { type: "Hidden" }),
						],
					},
				],
			});
			const preview = await fixture.run("--dry-run", "--json");
			assertRefused(preview, ["--dry-run", "--json"]);
			const envelope = JSON.parse(preview.stdout).results[0];
			assert.equal(envelope.lossless, false);
			assert.equal(envelope.requiresAuthorization, true);
			assert.deepEqual(
				envelope.report.dropped.map((item: { key: string; value: string }) => [
					item.key,
					item.value,
				]),
				[["removed", "lost-value"]],
			);
			const blocked = await fixture.run("--in-place");
			assertRefused(blocked, ["--in-place"]);
			fixture.assertUnchanged();
		});

		test(`${kind}: a conditional hidden replacement at the floor is reported as dropped`, async () => {
			const fixture = setup({
				recipe: floor(2),
				embedded,
				lineage: [
					{
						...source,
						version: 2,
						properties: [
							input("kept", "retained"),
							input("mode", "a", { id: "mode", type: "Hidden" }),
							input("removed", "floor-default", {
								type: "Hidden",
								condition: { property: "mode", equals: "a" },
							}),
							input("removed", "", {
								condition: { property: "mode", equals: "b" },
							}),
						],
					},
				],
			});
			const preview = await fixture.run("--dry-run", "--json");
			assertRefused(preview, ["--dry-run", "--json"]);
			const envelope = JSON.parse(preview.stdout).results[0];
			assert.equal(envelope.lossless, false);
			assert.deepEqual(
				envelope.report.dropped.map((item: { key: string; value: string }) => [
					item.key,
					item.value,
				]),
				[["removed", "lost-value"]],
			);
			const blocked = await fixture.run("--in-place");
			assertRefused(blocked, ["--in-place"]);
			fixture.assertUnchanged();
		});

		test(`${kind}: an inactive property that normalizes to the replacement does not hide the loss`, async () => {
			const fixture = setup({
				recipe: floor(2),
				embedded,
				lineage: [
					{
						...source,
						version: 2,
						properties: [
							input("kept", "retained"),
							input("mode", "a", { id: "mode", type: "Hidden" }),
							input("removed", "=true", {
								type: "Hidden",
								condition: { property: "mode", equals: "a" },
							}),
							input("removed", "", {
								type: "Boolean",
								feel: "static",
								condition: { property: "mode", equals: "b" },
							}),
						],
					},
				],
			});
			const preview = await fixture.run("--dry-run", "--json");
			assertRefused(preview, ["--dry-run", "--json"]);
			const envelope = JSON.parse(preview.stdout).results[0];
			assert.equal(envelope.lossless, false);
			assert.deepEqual(
				envelope.report.dropped.map((item: { key: string; value: string }) => [
					item.key,
					item.value,
				]),
				[["removed", "lost-value"]],
			);
			const blocked = await fixture.run("--in-place");
			assertRefused(blocked, ["--in-place"]);
			fixture.assertUnchanged();
		});

		test(`${kind}: a recipe rename after a floor overwrite does not hide the loss`, async () => {
			const rename = {
				schemaVersion: 1,
				sources: [
					{
						kind: "change",
						sourceTemplateId: source.id,
						minSourceVersion: 2,
						paths: [{ from: "removed", to: "moved" }],
					},
				],
			};
			const fixture = setup({
				recipe: rename,
				embedded,
				lineage: [
					{
						...source,
						version: 2,
						properties: [
							input("kept", "retained"),
							input("removed", "floor-default", { type: "Hidden" }),
						],
					},
				],
				targetProperties: [input("kept", "retained"), input("moved")],
			});
			const preview = await fixture.run("--dry-run", "--json");
			assertRefused(preview, ["--dry-run", "--json"]);
			const envelope = JSON.parse(preview.stdout).results[0];
			assert.equal(envelope.lossless, false);
			assert.deepEqual(
				envelope.report.dropped.map((item: { key: string; value: string }) => [
					item.key,
					item.value,
				]),
				[["removed", "lost-value"]],
			);
			const blocked = await fixture.run("--in-place");
			assertRefused(blocked, ["--in-place"]);
			fixture.assertUnchanged();
		});

		test(`${kind}: a pre-floor upgrade move that keeps the value is not reported as dropped`, async () => {
			const fixture = setup({
				recipe: floor(3),
				embedded,
				lineage: [
					{
						...source,
						version: 2,
						properties: [
							input("kept", "retained"),
							input("removed", "lost-value"),
							input("moved"),
						],
					},
					{
						...source,
						version: 3,
						properties: [input("kept", "retained"), input("moved")],
						metadata: {
							migratesFrom: {
								schemaVersion: 1,
								sources: [
									{
										kind: "upgrade",
										sourceTemplateId: source.id,
										toVersion: 2,
										paths: [{ from: "removed", to: "moved" }],
									},
								],
							},
						},
					},
				],
				targetProperties: [input("kept", "retained"), input("moved")],
			});
			const preview = await fixture.run("--dry-run", "--json");
			assert.equal(preview.status, 0, preview.stderr);
			const envelope = JSON.parse(preview.stdout).results[0];
			assert.equal(envelope.lossless, true);
			assert.equal(envelope.requiresAuthorization, false);
			assert.deepEqual(envelope.report.dropped, []);
			const written = await fixture.run("--in-place");
			assert.equal(written.status, 0, written.stderr);
			assert.notEqual(readFileSync(fixture.file, "utf8"), original);
		});

		test(`${kind}: a Hidden floor replacement that adds "=" does not count as normalization`, async () => {
			const replaced = input("moved", "=lost-value", { type: "Hidden" });
			const fixture = setup({
				recipe: floor(3),
				embedded,
				lineage: [
					{
						...source,
						version: 2,
						properties: [
							input("kept", "retained"),
							input("removed", "lost-value"),
							input("moved"),
						],
					},
					{
						...source,
						version: 3,
						properties: [input("kept", "retained"), replaced],
						metadata: {
							migratesFrom: {
								schemaVersion: 1,
								sources: [
									{
										kind: "upgrade",
										sourceTemplateId: source.id,
										toVersion: 2,
										paths: [{ from: "removed", to: "moved" }],
									},
								],
							},
						},
					},
				],
				targetProperties: [input("kept", "retained"), replaced],
			});
			const preview = await fixture.run("--dry-run", "--json");
			assertRefused(preview, ["--dry-run", "--json"]);
			const envelope = JSON.parse(preview.stdout).results[0];
			assert.equal(envelope.lossless, false);
			const blocked = await fixture.run("--in-place");
			assertRefused(blocked, ["--in-place"]);
			fixture.assertUnchanged();
		});

		test(`${kind}: an inactive Hidden duplicate does not make normalization a reset`, async () => {
			const editable = input("moved", "", { feel: "required" });
			const inactive = input("moved", "other", {
				type: "Hidden",
				condition: { property: "kept", equals: "never" },
			});
			const fixture = setup({
				recipe: floor(3),
				embedded,
				lineage: [
					{
						...source,
						version: 2,
						properties: [
							input("kept", "retained"),
							input("removed", "lost-value"),
							input("moved"),
						],
					},
					{
						...source,
						version: 3,
						properties: [input("kept", "retained"), editable, inactive],
						metadata: {
							migratesFrom: {
								schemaVersion: 1,
								sources: [
									{
										kind: "upgrade",
										sourceTemplateId: source.id,
										toVersion: 2,
										paths: [{ from: "removed", to: "moved" }],
									},
								],
							},
						},
					},
				],
				targetProperties: [input("kept", "retained"), editable, inactive],
			});
			const preview = await fixture.run("--dry-run", "--json");
			assert.equal(preview.status, 0, preview.stderr);
			const envelope = JSON.parse(preview.stdout).results[0];
			assert.equal(envelope.lossless, true);
			assert.deepEqual(envelope.report.dropped, []);
		});

		test(`${kind}: a pre-floor move whose value the floor normalizes is not reported as dropped`, async () => {
			const fixture = setup({
				recipe: floor(3),
				embedded,
				lineage: [
					{
						...source,
						version: 2,
						properties: [
							input("kept", "retained"),
							input("removed", "lost-value"),
							input("moved"),
						],
					},
					{
						...source,
						version: 3,
						properties: [
							input("kept", "retained"),
							input("moved", "", { feel: "required" }),
						],
						metadata: {
							migratesFrom: {
								schemaVersion: 1,
								sources: [
									{
										kind: "upgrade",
										sourceTemplateId: source.id,
										toVersion: 2,
										paths: [{ from: "removed", to: "moved" }],
									},
								],
							},
						},
					},
				],
				targetProperties: [
					input("kept", "retained"),
					input("moved", "", { feel: "required" }),
				],
			});
			const preview = await fixture.run("--dry-run", "--json");
			assert.equal(preview.status, 0, preview.stderr);
			const envelope = JSON.parse(preview.stdout).results[0];
			assert.equal(envelope.lossless, true);
			assert.equal(envelope.requiresAuthorization, false);
			assert.deepEqual(envelope.report.dropped, []);
			const written = await fixture.run("--in-place");
			assert.equal(written.status, 0, written.stderr);
			assert.notEqual(readFileSync(fixture.file, "utf8"), original);
		});

		test(`${kind}: a pre-floor upgrade move that translates the value is not reported as dropped`, async () => {
			const fixture = setup({
				recipe: floor(3),
				embedded,
				lineage: [
					{
						...source,
						version: 2,
						properties: [
							input("kept", "retained"),
							input("removed", "lost-value"),
							input("moved"),
						],
					},
					{
						...source,
						version: 3,
						properties: [input("kept", "retained"), input("moved")],
						metadata: {
							migratesFrom: {
								schemaVersion: 1,
								sources: [
									{
										kind: "upgrade",
										sourceTemplateId: source.id,
										toVersion: 2,
										paths: [
											{
												from: "removed",
												to: "moved",
												valueMap: {
													rules: [{ match: "lost-value", value: "translated" }],
												},
											},
										],
									},
								],
							},
						},
					},
				],
				targetProperties: [input("kept", "retained"), input("moved")],
			});
			const preview = await fixture.run("--dry-run", "--json");
			assert.equal(preview.status, 0, preview.stderr);
			const envelope = JSON.parse(preview.stdout).results[0];
			assert.equal(envelope.lossless, true);
			assert.equal(envelope.requiresAuthorization, false);
			assert.deepEqual(envelope.report.dropped, []);
			const written = await fixture.run("--in-place");
			assert.equal(written.status, 0, written.stderr);
			assert.notEqual(readFileSync(fixture.file, "utf8"), original);
		});

		test(`${kind}: an intermediate-only default removed by the implicit step is not reported as dropped`, async () => {
			const fixture = setup({
				recipe: floor(3),
				embedded,
				lineage: [
					{
						...source,
						version: 2,
						properties: [
							input("kept", "retained"),
							input("removed", "lost-value"),
							input("temporary", "generated-default"),
						],
					},
					{
						...source,
						version: 3,
						properties: [
							input("kept", "retained"),
							input("removed", "lost-value"),
						],
						metadata: {
							migratesFrom: {
								schemaVersion: 1,
								sources: [
									{
										kind: "upgrade",
										sourceTemplateId: source.id,
										toVersion: 2,
										paths: [],
									},
								],
							},
						},
					},
				],
				targetProperties: [
					input("kept", "retained"),
					input("removed", "lost-value"),
				],
			});
			const preview = await fixture.run("--dry-run", "--json");
			assert.equal(preview.status, 0, preview.stderr);
			const envelope = JSON.parse(preview.stdout).results[0];
			assert.equal(envelope.lossless, true);
			assert.equal(envelope.requiresAuthorization, false);
			assert.deepEqual(envelope.report.dropped, []);
			const written = await fixture.run("--in-place");
			assert.equal(written.status, 0, written.stderr);
			assert.notEqual(readFileSync(fixture.file, "utf8"), original);
		});

		test(`${kind}: a value the floor normalizes to a FEEL wrapper is not reported as dropped`, async () => {
			const fixture = setup({
				recipe: floor(3),
				embedded,
				lineage: [
					{
						...source,
						version: 2,
						properties: [
							input("kept", "retained"),
							input("removed", "lost-value"),
						],
					},
					{
						...source,
						version: 3,
						properties: [
							input("kept", "retained"),
							input("removed", "", { feel: "required" }),
						],
						metadata: {
							migratesFrom: {
								schemaVersion: 1,
								sources: [
									{
										kind: "upgrade",
										sourceTemplateId: source.id,
										toVersion: 2,
										paths: [],
									},
								],
							},
						},
					},
				],
				targetProperties: [
					input("kept", "retained"),
					input("removed", "", { feel: "required" }),
				],
			});
			const preview = await fixture.run("--dry-run", "--json");
			assert.equal(preview.status, 0, preview.stderr);
			const envelope = JSON.parse(preview.stdout).results[0];
			assert.equal(envelope.lossless, true);
			assert.equal(envelope.requiresAuthorization, false);
			assert.deepEqual(envelope.report.dropped, []);
			const written = await fixture.run("--in-place");
			assert.equal(written.status, 0, written.stderr);
			assert.notEqual(readFileSync(fixture.file, "utf8"), original);
		});

		test(`${kind}: a floor normalization that changes the value meaning is reported as dropped`, async () => {
			const fixture = setup({
				recipe: floor(3),
				embedded,
				lineage: [
					{
						...source,
						version: 2,
						properties: [
							input("kept", "retained"),
							input("removed", "lost-value"),
						],
					},
					{
						...source,
						version: 3,
						properties: [
							input("kept", "retained"),
							input("removed", "", { type: "Boolean", feel: "static" }),
						],
						metadata: {
							migratesFrom: {
								schemaVersion: 1,
								sources: [
									{
										kind: "upgrade",
										sourceTemplateId: source.id,
										toVersion: 2,
										paths: [],
									},
								],
							},
						},
					},
				],
				targetProperties: [
					input("kept", "retained"),
					input("removed", "", { type: "Boolean", feel: "static" }),
				],
			});
			const preview = await fixture.run("--dry-run", "--json");
			assertRefused(preview, ["--dry-run", "--json"]);
			const envelope = JSON.parse(preview.stdout).results[0];
			assert.equal(envelope.lossless, false);
			assert.deepEqual(
				envelope.report.dropped.map((item: { key: string; value: string }) => [
					item.key,
					item.value,
				]),
				[["removed", "lost-value"]],
			);
			const blocked = await fixture.run("--in-place");
			assertRefused(blocked, ["--in-place"]);
			fixture.assertUnchanged();
		});

		test(`${kind}: a Hidden source value the floor resets is not reported as dropped`, async () => {
			const managed = (value: string) => ({
				type: "Hidden",
				value,
				binding: { type: "zeebe:taskHeader", key: "managed" },
			});
			const hiddenSource = {
				...source,
				properties: [input("kept", "retained"), managed("old")],
			};
			const seedPath = join(dir, "hidden-source.json");
			writeFileSync(seedPath, JSON.stringify(hiddenSource));
			const seeded = await c8WithEnv(
				{ C8CTL_DATA_DIR: dir, C8CTL_OUTPUT_MODE: "text" },
				"element-template",
				"apply",
				seedPath,
				TASK,
				"tests/fixtures/simple.bpmn",
			);
			assert.equal(seeded.status, 0, seeded.stderr);
			const fixture = setup({
				recipe: floor(3),
				embedded,
				sourceTemplate: hiddenSource,
				diagram: seeded.stdout,
				lineage: [
					{
						...source,
						version: 2,
						properties: [input("kept", "retained"), managed("new")],
					},
					{
						...source,
						version: 3,
						properties: [input("kept", "retained"), managed("new")],
					},
				],
				targetProperties: [input("kept", "retained"), managed("new")],
			});
			const preview = await fixture.run("--dry-run", "--json");
			assert.equal(preview.status, 0, preview.stderr);
			const envelope = JSON.parse(preview.stdout).results[0];
			assert.equal(envelope.lossless, true);
			assert.deepEqual(envelope.report.dropped, []);
		});

		test(`${kind}: a surviving --map recovers a value the floor version lacks`, async () => {
			const fixture = setup({
				recipe: floor(2),
				embedded,
				lineage: [
					{ ...source, version: 2, properties: [input("kept", "retained")] },
				],
				targetProperties: [input("kept", "retained"), input("moved")],
			});
			const preview = await fixture.run(
				"--dry-run",
				"--json",
				"--map",
				"removed=moved",
			);
			assert.equal(preview.status, 0, preview.stderr);
			const envelope = JSON.parse(preview.stdout).results[0];
			assert.equal(envelope.lossless, true);
			assert.equal(envelope.requiresAuthorization, false);
			assert.deepEqual(envelope.report.dropped, []);
			assert.equal(envelope.report.moved.length, 1);
			fixture.assertUnchanged();
		});

		test(`${kind}: a floor above the newest compatible version fails and --allow-lossy cannot override it`, async () => {
			const fixture = setup({
				recipe: floor(4),
				embedded,
				lineage: [{ ...source, version: 2 }],
			});
			for (const flags of [
				[],
				["--in-place"],
				["--in-place", "--allow-lossy"],
				["--dry-run", "--json"],
				["--dry-run", "--json", "--allow-lossy"],
			]) {
				const result = await fixture.run(...flags);
				assertRefused(result, flags);
				assert.match(
					out(result),
					/Template 'refusal\.source' v4 or later is required, but the newest version compatible with Camunda 8\.8.*\(from the BPMN executionPlatformVersion\) is v2\./,
				);
				assert.doesNotMatch(out(result), /Requires --allow-lossy/);
				fixture.assertUnchanged();
			}
		});

		test(`${kind}: a floor missing from the compatible catalog lands on the lowest compatible version above it`, async () => {
			const fixture = setup({
				recipe: floor(2),
				embedded,
				lineage: [{ ...source, version: 3 }],
			});
			const result = await fixture.run("--dry-run", "--json");
			assert.equal(result.status, 0, out(result));
			assert.match(out(result), /"implicit": ?true/);
			assert.match(out(result), /"toVersion": ?3/);
		});
	}
});

test("embedded fallback dry-run reports prospective losses without authorization or writes", async () => {
	const fixture = setup({
		embedded: true,
		lossy: true,
		recipe: {
			schemaVersion: 1,
			sources: [{ kind: "change", sourceTemplateId: "unrelated.source" }],
		},
	});
	for (const json of [false, true]) {
		const result = await fixture.run("--dry-run", ...(json ? ["--json"] : []));
		// Without --allow-lossy the equivalent write would be blocked.
		assertRefused(result, ["--dry-run"]);
		if (json) {
			const envelope = JSON.parse(result.stdout).results[0];
			assert.equal(envelope.lossless, false);
			assert.equal(envelope.requiresAuthorization, true);
			assert.equal(envelope.recipe.used, false);
			assert.match(envelope.recipe.refusal, /wrong source ID/i);
			assert.ok(envelope.report.dropped.length > 0);
		} else {
			assert.match(result.stdout, /wrong source ID/i);
			assert.match(result.stdout, /Dropped/);
			assert.match(result.stdout, /Requires --allow-lossy/);
		}
		fixture.assertUnchanged();
	}
});

describe("update CLI: unusable recipes and lossy overwrites (shared update fixtures)", () => {
	const w = createUpdateWorkspace();
	const { TASK, OLD, NEW } = updateFixtures;
	const { ws } = w;
	const { run, dataDirWithCache, setup, teardown, assertCleanedUp } = w;
	before(setup);
	after(teardown);

	test("--recipe overrides the embedded recipe", async () => {
		const templatePath = join(ws.workDir, "new.json");
		writeFileSync(templatePath, JSON.stringify(NEW));
		const recipePath = join(ws.workDir, "recipe.json");
		writeFileSync(
			recipePath,
			JSON.stringify({
				schemaVersion: 1,
				sources: [
					{
						kind: "change",
						sourceTemplateId: "io.example.old",
						paths: [{ from: "endpoint", to: "backend.provider" }],
					},
				],
			}),
		);
		const result = await run(
			dataDirWithCache([OLD]),
			"update",
			OLD.id,
			TASK,
			ws.oldBpmn,
			"--to",
			templatePath,
			"--recipe",
			recipePath,
		);
		assert.strictEqual(result.status, 0, result.stderr);
		assert.match(
			result.stdout,
			/source="https:\/\/x" target="backend.provider"/,
		);
	});

	test("rejects an invalid recipe file before changing anything", async () => {
		const templatePath = join(ws.workDir, "new.json");
		writeFileSync(templatePath, JSON.stringify(NEW));
		const recipePath = join(ws.workDir, "bad-recipe.json");
		writeFileSync(
			recipePath,
			JSON.stringify({ schemaVersion: 2, sources: [] }),
		);
		const result = await run(
			dataDirWithCache([OLD]),
			"update",
			OLD.id,
			TASK,
			ws.oldBpmn,
			"--to",
			templatePath,
			"--recipe",
			recipePath,
		);
		assert.strictEqual(result.status, 1);
		assert.match(result.stderr, /Update c8ctl/);
	});

	const NEWER_RECIPE = { schemaVersion: 2, future: true, sources: [] };
	const unusableRecipe = (sources: object[]) => ({ schemaVersion: 1, sources });

	for (const { label, recipe, error } of [
		{ label: "a newer", recipe: NEWER_RECIPE, error: /Update c8ctl/ },
		{
			label: "an owner-invalid",
			recipe: unusableRecipe([{ kind: "change", sourceTemplateId: NEW.id }]),
			error: /change source must differ from recipe owner/,
		},
	]) {
		test(`fails the run when the target carries ${label} recipe`, async () => {
			const templatePath = join(ws.workDir, "unusable-target.json");
			writeFileSync(
				templatePath,
				JSON.stringify({ ...NEW, metadata: { migratesFrom: recipe } }),
			);
			await assertRunFails(
				dataDirWithCache([OLD]),
				templatePath,
				"io.example.new@1",
				error,
			);
		});
	}

	for (const { label, recipe, error } of [
		{ label: "a newer", recipe: NEWER_RECIPE, error: /Update c8ctl/ },
		{
			label: "an owner-invalid",
			recipe: unusableRecipe([
				{ kind: "upgrade", sourceTemplateId: OLD.id, toVersion: 3 },
			]),
			error: /upgrade version 3 exceeds owner version 2/,
		},
	]) {
		test(`fails the run when the source lineage carries ${label} recipe`, async () => {
			const templatePath = join(ws.workDir, "new.json");
			writeFileSync(templatePath, JSON.stringify(NEW));
			const source = { ...OLD, version: 2, metadata: { migratesFrom: recipe } };
			await assertRunFails(
				dataDirWithCache([OLD, source]),
				templatePath,
				"io.example.old@2",
				error,
			);
		});
	}

	test("fails the run when an engine-incompatible applied source carries a newer recipe", async () => {
		const templatePath = join(ws.workDir, "new.json");
		writeFileSync(templatePath, JSON.stringify(NEW));
		// The element is on old@2, which the engine filter drops from the catalog.
		const applied = {
			...OLD,
			version: 2,
			engines: { camunda: "^99.0" },
			metadata: { migratesFrom: NEWER_RECIPE },
		};
		const bpmn = join(ws.workDir, "old-v2.bpmn");
		const xml = readFileSync(ws.oldBpmn, "utf-8");
		const appliedV2 = xml.replace(
			'modelerTemplateVersion="1"',
			'modelerTemplateVersion="2"',
		);
		assert.notStrictEqual(appliedV2, xml);
		writeFileSync(bpmn, appliedV2);
		await assertRunFails(
			dataDirWithCache([OLD, applied]),
			templatePath,
			"io.example.old@2",
			/Update c8ctl/,
			bpmn,
		);
	});

	async function assertRunFails(
		dataDir: string,
		templatePath: string,
		owner: string,
		error: RegExp,
		bpmn = ws.oldBpmn,
	) {
		for (const flags of [
			["--in-place", "--allow-lossy"],
			["--dry-run", "--json"],
		]) {
			const before = readFileSync(bpmn, "utf-8");
			const result = await run(
				dataDir,
				"update",
				OLD.id,
				TASK,
				bpmn,
				"--to",
				templatePath,
				...flags,
			);
			assert.strictEqual(result.status, 1, result.stderr);
			assert.strictEqual(result.stdout, "");
			assert.match(
				result.stderr,
				new RegExp(
					`Template ${owner.replaceAll(".", "\\.")} carries an unusable recipe\\.`,
				),
			);
			assert.match(result.stderr, error);
			assert.strictEqual(readFileSync(bpmn, "utf-8"), before);
		}
	}

	test("removes every temp dir it created", assertCleanedUp);
});
