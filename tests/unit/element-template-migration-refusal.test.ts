import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { c8WithEnv } from "../utils/cli.ts";

const TASK = "Activity_17s7axj";
const dir = mkdtempSync(join(tmpdir(), "c8ctl-migration-refusal-"));
const input = (name: string, value = "") => ({
	type: "String",
	label: name,
	value,
	binding: { type: "zeebe:input", name },
});
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
}: {
	action?: "change" | "update";
	recipe?: unknown;
	embedded?: boolean;
	lineage?: object[];
	lossy?: boolean;
} = {}) {
	const work = mkdtempSync(join(dir, "case-"));
	const cache = join(work, "element-templates");
	mkdirSync(cache);
	const target = {
		...source,
		id: action === "change" ? "refusal.target" : source.id,
		name: "Target",
		version: 3,
		properties: lossy ? [input("kept")] : source.properties,
		...(embedded ? { metadata: { migratesFrom: recipe } } : {}),
	};
	writeFileSync(
		join(cache, "templates.json"),
		JSON.stringify([source, ...lineage, target]),
	);
	writeFileSync(join(cache, "fetched-at"), String(Date.now()));
	const targetPath = join(work, "target.json");
	writeFileSync(targetPath, JSON.stringify(target));
	const recipePath = join(work, "recipe.json");
	if (recipe !== undefined && !embedded)
		writeFileSync(
			recipePath,
			typeof recipe === "string" ? recipe : JSON.stringify(recipe),
		);
	const file = join(work, "diagram.bpmn");
	writeFileSync(file, original);
	const mtime = statSync(file).mtimeMs;
	return {
		file,
		run: (...flags: string[]) =>
			c8WithEnv(
				{ C8CTL_DATA_DIR: work, C8CTL_OUTPUT_MODE: "text", NO_COLOR: "1" },
				"element-template",
				action,
				...(action === "change" ? [targetPath] : []),
				TASK,
				file,
				...(recipe !== undefined && !embedded ? ["--recipe", recipePath] : []),
				...flags,
			),
		assertUnchanged: () => {
			assert.equal(readFileSync(file, "utf8"), original);
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
			lineage: [upgrade],
		},
		{
			name:
				action === "change" ? "unmet source floor" : "no applicable upgrade",
			sources: [
				action === "change"
					? { ...entry, minSourceVersion: 3 }
					: { ...entry, toVersion: 1 },
			],
			diagnostic:
				action === "change"
					? /unmet source floor.*3.*reached.*2/i
					: /no applicable upgrade.*1.*3/i,
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
					assert.equal(result.status, 1, result.stderr);
					assert.equal(result.stdout, "");
					assert.match(result.stderr, scenario.diagnostic);
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
						assert.equal(result.status, 1, result.stderr);
						assert.equal(result.stdout, "");
						assert.match(result.stderr, scenario.diagnostic);
						fixture.assertUnchanged();
					}
				} else {
					const textPreview = await fixture.run("--dry-run");
					assert.equal(textPreview.status, 0, textPreview.stderr);
					assert.match(textPreview.stdout, scenario.diagnostic);
					assert.match(textPreview.stdout, /Requires --allow-lossy/);
					fixture.assertUnchanged();
					const preview = await fixture.run("--dry-run", "--json");
					assert.equal(preview.status, 0, preview.stderr);
					const envelope = JSON.parse(preview.stdout);
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
							const authorized = JSON.parse(result.stdout);
							assert.equal(authorized.authorized, true);
							assert.match(authorized.recipe.refusal, scenario.diagnostic);
						} else {
							assert.match(result.stderr, scenario.diagnostic);
							assert.match(result.stderr, /authorized with --allow-lossy/);
							fixture.assertUnchanged();
						}
					}
				}
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
				const envelope = JSON.parse(result.stdout);
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
		assert.equal(result.status, 1, result.stderr);
		assert.equal(result.stdout, "");
		assert.match(result.stderr, /Invalid migration recipe.*unknown/);
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
		assert.equal(preview.status, 0, preview.stderr);
		if (json) {
			const envelope = JSON.parse(preview.stdout);
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
	assert.equal(JSON.parse(authorized.stdout).authorized, true);
	assert.doesNotMatch(readFileSync(fixture.file, "utf8"), /lost-value/);
});

test("loaded source versions without upgrades do not satisfy an explicit floor", async () => {
	const fixture = setup({
		recipe: {
			schemaVersion: 1,
			sources: [
				{ kind: "change", sourceTemplateId: source.id, minSourceVersion: 2 },
			],
		},
		lineage: [{ ...source, version: 2 }],
	});
	const result = await fixture.run("--in-place", "--allow-lossy", "--json");
	assert.equal(result.status, 1, result.stderr);
	assert.equal(result.stdout, "");
	assert.match(result.stderr, /unmet source floor.*2.*reached.*1/i);
	fixture.assertUnchanged();
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
		assert.equal(result.status, 0, result.stderr);
		if (json) {
			const envelope = JSON.parse(result.stdout);
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
