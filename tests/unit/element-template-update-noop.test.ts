/**
 * MIG-010: a no-op keeps its output contract and leaves the filesystem untouched
 * (default-plugins/element-template/commands/migrate.ts)
 */

import assert from "node:assert/strict";
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { isRecord } from "../../src/core/index.ts";
import { c8WithOptions } from "../utils/cli.ts";
import { seedTemplateCache } from "../utils/element-template.ts";
import {
	createUpdateWorkspace,
	updateFixtures,
} from "../utils/update-workspace.ts";

const TASK = "Activity_17s7axj";
const ID = "io.example.noop-contract";
const NAME = "No-op contract";
const template = {
	id: ID,
	name: NAME,
	version: 2,
	appliesTo: ["bpmn:Task"],
	engines: { camunda: "^8.8" },
	properties: [
		{
			type: "Hidden",
			value: "worker",
			binding: { type: "zeebe:taskDefinition", property: "type" },
		},
		{
			type: "String",
			label: "Message",
			value: "default",
			binding: { type: "zeebe:input", name: "message" },
		},
	],
};
// "latest" resolves the target from the cache; "to-file" passes it with --to <path>.
const modes = ["latest", "to-file"] as const;
type Mode = (typeof modes)[number];
let root: string;
let original: string;

function run({
	dir,
	args,
	stdin,
	env,
	globals = [],
}: {
	dir: string;
	args: string[];
	stdin?: string;
	env?: Record<string, string | undefined>;
	globals?: string[];
}) {
	return c8WithOptions(
		{
			stdin,
			env: {
				C8CTL_DATA_DIR: join(dir, "data"),
				C8CTL_OUTPUT_MODE: "text",
				...env,
			},
		},
		...globals,
		"element-template",
		...args,
	);
}

before(async () => {
	root = mkdtempSync(join(tmpdir(), "c8-noop-contract-"));
	const path = join(root, "seed.json");
	writeFileSync(path, JSON.stringify(template));
	const result = await run({
		dir: root,
		args: [
			"apply",
			path,
			TASK,
			resolve("tests/fixtures/simple.bpmn"),
			"--set",
			"message=kept & exact",
		],
	});
	assert.equal(result.status, 0, result.stderr);
	// Noncanonical whitespace detects serialization even when the model is unchanged.
	original = `${result.stdout.replaceAll("\n", "\r\n")}\r\n  \r\n`;
});

after(() => {
	if (root) rmSync(root, { recursive: true, force: true });
});

function fixture(target: object = template) {
	const dir = mkdtempSync(join(root, "case-"));
	seedTemplateCache(join(dir, "data"), [target]);
	const path = join(dir, "target.json");
	writeFileSync(path, JSON.stringify(target));
	const file = join(dir, "process.bpmn");
	writeFileSync(file, original);
	utimesSync(file, new Date("2000-01-01"), new Date("2000-01-01"));
	return { dir, path, file };
}

async function initializedFixture() {
	const files = fixture();
	const initialized = await run({
		dir: files.dir,
		args: ["info", files.path],
	});
	assert.equal(initialized.status, 0, initialized.stderr);
	return files;
}

function argsFor({
	mode,
	path,
	file,
}: {
	mode: Mode;
	path: string;
	file?: string;
}) {
	return [
		"update",
		ID,
		TASK,
		...(file ? [file] : []),
		...(mode === "to-file" ? ["--to", path] : []),
	];
}

function fileIdentity(file: string) {
	const { dev, ino, size, mode, mtimeNs, ctimeNs } = statSync(file, {
		bigint: true,
	});
	return { dev, ino, size, mode, mtimeNs, ctimeNs };
}

function filesystemSnapshot(dir: string) {
	return readdirSync(dir, { recursive: true, withFileTypes: true }).map(
		(entry) => {
			const path = join(entry.parentPath, entry.name);
			return entry.isFile()
				? { path, identity: fileIdentity(path), bytes: readFileSync(path) }
				: { path };
		},
	);
}

function assertNoopJson({
	stdout,
	dryRun,
	file,
}: {
	stdout: string;
	mode: Mode;
	dryRun: boolean;
	file?: string;
}) {
	const document: unknown = JSON.parse(stdout);
	assert.ok(isRecord(document));
	assert.equal(document.dryRun, dryRun);
	assert.equal(document.command, "element-template update");
	assert.deepEqual(document.summary, {
		updated: 0,
		skipped: 0,
		unchanged: 1,
		failed: 0,
		dropped: 0,
		blocked: 0,
	});
	assert.ok(Array.isArray(document.results));
	assert.equal(document.results.length, 1);
	const envelope: unknown = document.results[0];
	assert.ok(isRecord(envelope));
	assert.equal(envelope.status, "unchanged");
	assert.equal(envelope.elementId, TASK);
	assert.equal(envelope.action, undefined);
	assert.equal(envelope.noop, true);
	assert.equal(envelope.dryRun, dryRun);
	assert.equal(envelope.lossless, true);
	assert.equal(envelope.file, file);
	assert.deepEqual(envelope.from, envelope.to);
	assert.ok(isRecord(envelope.from));
	assert.equal(envelope.from.id, ID);
	assert.equal(envelope.from.version, 2);
	assert.deepEqual(envelope.recipe, {
		source: "none",
		used: false,
		refusal: null,
	});
	assert.deepEqual(envelope.report, {
		dropped: [],
		added: [],
		changed: [],
		moved: [],
		kept: [],
		notes: [],
		skipped: { guard: [], template: [], noMatch: [], feel: [] },
	});
}

describe("migration no-op output contract", () => {
	for (const mode of modes) {
		for (const input of ["file", "stdin"] as const) {
			for (const output of ["xml", "dry-text", "dry-json"] as const) {
				test(`${mode}: ${input} ${output} preserves exact input and separates channels`, async () => {
					const { dir, path, file } = fixture();
					const identity = fileIdentity(file);
					const files = readdirSync(dir);
					const flags = output === "xml" ? [] : ["--dry-run"];
					if (output === "dry-json") flags.push("--json");
					const result = await run({
						dir,
						args: [
							...argsFor({
								mode,
								path,
								file: input === "file" ? file : undefined,
							}),
							...flags,
						],
						stdin: input === "stdin" ? original : undefined,
					});
					assert.equal(result.status, 0, result.stderr);
					if (output === "xml") {
						assert.equal(result.stdout, original);
						assert.match(result.stderr, /already on.*nothing to do/);
						assert.doesNotMatch(result.stderr, /<\?xml|<bpmn:/);
					} else {
						assert.equal(result.stderr, "");
						assert.doesNotMatch(result.stdout, /<\?xml|<bpmn:/);
						if (output === "dry-json")
							assertNoopJson({ stdout: result.stdout, mode, dryRun: true });
						else assert.match(result.stdout, /already on.*nothing to do/);
					}
					assert.equal(readFileSync(file, "utf-8"), original);
					assert.deepEqual(fileIdentity(file), identity);
					assert.deepEqual(readdirSync(dir), files);
				});
			}
		}
		for (const dryRun of [false, true]) {
			for (const json of [false, true]) {
				test(`${mode}: in-place no-op never rewrites (dryRun=${dryRun}, json=${json})`, async () => {
					const { dir, path, file } = fixture();
					const identity = fileIdentity(file);
					const files = readdirSync(dir);
					const result = await run({
						dir,
						args: [
							...argsFor({ mode, path, file }),
							"--in-place",
							...(dryRun ? ["--dry-run"] : []),
							...(json ? ["--json"] : []),
						],
					});
					assert.equal(result.status, 0, result.stderr);
					assert.equal(result.stderr, "");
					assert.doesNotMatch(result.stdout, /<\?xml|<bpmn:/);
					if (json)
						assertNoopJson({ stdout: result.stdout, mode, dryRun, file });
					else assert.match(result.stdout, /already on.*nothing to do/);
					assert.equal(readFileSync(file, "utf-8"), original);
					assert.deepEqual(fileIdentity(file), identity);
					assert.deepEqual(readdirSync(dir), files);
				});
			}
		}
		for (const input of ["file", "stdin"] as const) {
			test(`${mode}: no-op does not bypass JSON/XML mode refusal (${input})`, async () => {
				const { dir, path, file } = fixture();
				const identity = fileIdentity(file);
				const result = await run({
					dir,
					args: [
						...argsFor({
							mode,
							path,
							file: input === "file" ? file : undefined,
						}),
						"--json",
					],
					stdin: input === "stdin" ? original : undefined,
				});
				assert.equal(result.status, 1, result.stderr);
				assert.equal(result.stdout, "");
				assert.match(result.stderr, /--json needs --in-place or --dry-run/);
				assert.equal(readFileSync(file, "utf-8"), original);
				assert.deepEqual(fileIdentity(file), identity);
			});
		}
	}
});

describe("no-op global output settings and error channels", () => {
	for (const mode of modes) {
		for (const setting of [
			"environment",
			"session",
			"text-override",
			"leading-json",
		] as const) {
			test(`${mode}: ${setting} output settings preserve the no-op contract and filesystem`, async () => {
				const { dir, path, file } = await initializedFixture();
				if (setting === "session" || setting === "text-override") {
					const configured = await c8WithOptions(
						{
							env: {
								C8CTL_DATA_DIR: join(dir, "data"),
								C8CTL_OUTPUT_MODE: "text",
							},
						},
						"output",
						"json",
					);
					assert.equal(configured.status, 0, configured.stderr);
				}
				const snapshot = filesystemSnapshot(dir);
				const text = setting === "text-override";
				const result = await run({
					dir,
					args: [
						...argsFor({ mode, path, file }),
						...(text ? [] : ["--dry-run"]),
					],
					globals: setting === "leading-json" ? ["--json"] : [],
					env: {
						C8CTL_OUTPUT_MODE:
							setting === "environment"
								? "json"
								: setting === "session"
									? undefined
									: "text",
					},
				});
				assert.equal(result.status, 0, result.stderr);
				if (text) {
					assert.equal(result.stdout, original);
					assert.match(result.stderr, /already on.*nothing to do/);
				} else {
					assert.equal(result.stderr, "");
					assertNoopJson({ stdout: result.stdout, mode, dryRun: true });
				}
				assert.deepEqual(filesystemSnapshot(dir), snapshot);
			});
		}
		for (const input of ["file", "stdin"] as const) {
			for (const failure of ["json-xml", "invalid-recipe"] as const) {
				test(`${mode}: ${input} ${failure} emits one JSON error only on stderr`, async () => {
					const { dir, path, file } = await initializedFixture();
					const recipePath = join(dir, "invalid.json");
					writeFileSync(recipePath, "{");
					const snapshot = filesystemSnapshot(dir);
					const result = await run({
						dir,
						args: [
							...argsFor({
								mode,
								path,
								file: input === "file" ? file : undefined,
							}),
							...(failure === "invalid-recipe"
								? ["--dry-run", "--recipe", recipePath]
								: []),
							"--fields",
							"noop",
						],
						stdin: input === "stdin" ? original : undefined,
						env: { C8CTL_OUTPUT_MODE: "json" },
					});
					assert.equal(result.status, 1, result.stderr);
					assert.equal(result.stdout, "");
					const error: unknown = JSON.parse(result.stderr);
					assert.ok(isRecord(error));
					assert.equal(error.status, "error");
					assert.equal(typeof error.message, "string");
					assert.match(
						String(error.message),
						failure === "json-xml"
							? /--json needs --in-place or --dry-run/
							: /Cannot read recipe/,
					);
					assert.doesNotMatch(
						result.stderr,
						/already on|nothing to do|<\?xml|<bpmn:/,
					);
					assert.deepEqual(filesystemSnapshot(dir), snapshot);
				});
			}
		}
		for (const output of ["xml", "dry-json", "in-place-json"] as const) {
			test(`${mode}: --fields filters JSON without corrupting XML (${output})`, async () => {
				const { dir, path, file } = await initializedFixture();
				const snapshot = filesystemSnapshot(dir);
				const result = await run({
					dir,
					args: [
						...argsFor({ mode, path, file }),
						...(output === "xml"
							? []
							: ["--json", output === "dry-json" ? "--dry-run" : "--in-place"]),
						"--fields",
						"Results,Dry-Run,Command",
					],
				});
				assert.equal(result.status, 0, result.stderr);
				if (output === "xml") {
					assert.equal(result.stdout, original);
					assert.match(result.stderr, /already on.*nothing to do/);
				} else {
					assert.equal(result.stderr, "");
					const filtered: unknown = JSON.parse(result.stdout);
					assert.ok(isRecord(filtered));
					assert.deepEqual(Object.keys(filtered).sort(), [
						"command",
						"dryRun",
						"results",
					]);
					assert.equal(filtered.dryRun, output === "dry-json");
					assert.equal(filtered.command, "element-template update");
					assert.ok(Array.isArray(filtered.results));
					assert.ok(isRecord(filtered.results[0]));
					assert.equal(filtered.results[0].noop, true);
				}
				assert.deepEqual(filesystemSnapshot(dir), snapshot);
			});
		}
		for (const json of [false, true]) {
			test(`${mode}: debug and verbose diagnostics never contaminate ${json ? "JSON" : "XML"} stdout`, async () => {
				const { dir, path, file } = await initializedFixture();
				const snapshot = filesystemSnapshot(dir);
				const result = await run({
					dir,
					args: [
						...argsFor({ mode, path }),
						"--verbose",
						...(json ? ["--dry-run", "--json"] : []),
					],
					stdin: original,
					env: { C8CTL_DEBUG: "1" },
				});
				assert.equal(result.status, 0, result.stderr);
				assert.match(result.stderr, /debug/i);
				assert.doesNotMatch(result.stderr, /<\?xml|<bpmn:/);
				if (json) assertNoopJson({ stdout: result.stdout, mode, dryRun: true });
				else {
					assert.equal(result.stdout, original);
					assert.match(result.stderr, /already on.*nothing to do/);
				}
				assert.equal(readFileSync(file, "utf-8"), original);
				assert.deepEqual(filesystemSnapshot(dir), snapshot);
			});
		}
	}
});

describe("recipe validation before no-op", () => {
	const entry = { kind: "upgrade", sourceTemplateId: ID, toVersion: 2 };
	const invalid = [
		{ name: "unsupported schema", recipe: { schemaVersion: 2, sources: [] } },
		{
			name: "unknown key",
			recipe: { schemaVersion: 1, sources: [entry], typo: true },
		},
		{
			name: "invalid unselected entry",
			recipe: {
				schemaVersion: 1,
				sources: [entry, { kind: "unknown", sourceTemplateId: "other" }],
			},
		},
		{
			name: "invalid owner relation",
			recipe: {
				schemaVersion: 1,
				sources: [{ ...entry, sourceTemplateId: "other" }],
			},
		},
		{
			name: "upgrade above owner version",
			recipe: { schemaVersion: 1, sources: [{ ...entry, toVersion: 3 }] },
		},
		{
			name: "duplicate markers",
			recipe: { schemaVersion: 1, sources: [entry, entry] },
		},
	];
	for (const mode of modes) {
		for (const source of ["file", "embedded"] as const) {
			for (const paths of [undefined, []]) {
				test(`${mode}: accepts valid ${source} recipe with ${paths ? "empty" : "omitted"} paths as a lossless no-op`, async () => {
					const recipe = { schemaVersion: 1, sources: [{ ...entry, paths }] };
					const { dir, path, file } = fixture(
						source === "embedded"
							? { ...template, metadata: { migratesFrom: recipe } }
							: template,
					);
					const recipePath = join(dir, "recipe.json");
					writeFileSync(recipePath, JSON.stringify(recipe));
					const identity = fileIdentity(file);
					const result = await run({
						dir,
						args: [
							...argsFor({ mode, path, file }),
							"--dry-run",
							"--json",
							...(source === "file" ? ["--recipe", recipePath] : []),
						],
					});
					assert.equal(result.status, 0, result.stderr);
					assert.equal(result.stderr, "");
					assertNoopJson({ stdout: result.stdout, mode, dryRun: true });
					assert.equal(readFileSync(file, "utf-8"), original);
					assert.deepEqual(fileIdentity(file), identity);
				});
			}
			for (const { name, recipe } of invalid) {
				test(`${mode}: rejects ${source} ${name} without output or rewrite`, async () => {
					const { dir, path, file } = fixture(
						source === "embedded"
							? { ...template, metadata: { migratesFrom: recipe } }
							: template,
					);
					const recipePath = join(dir, "recipe.json");
					writeFileSync(recipePath, JSON.stringify(recipe));
					const identity = fileIdentity(file);
					const files = readdirSync(dir);
					const result = await run({
						dir,
						args: [
							...argsFor({ mode, path, file }),
							"--in-place",
							"--json",
							...(source === "file" ? ["--recipe", recipePath] : []),
						],
					});
					assert.equal(result.status, 1, result.stderr);
					assert.equal(result.stdout, "");
					assert.match(result.stderr, /recipe|schemaVersion|sources/i);
					assert.doesNotMatch(result.stderr, /already on|nothing to do/);
					assert.equal(readFileSync(file, "utf-8"), original);
					assert.deepEqual(fileIdentity(file), identity);
					assert.deepEqual(readdirSync(dir), files);
				});
			}
		}
		for (const contents of ["{", undefined]) {
			test(`${mode}: rejects ${contents === undefined ? "missing" : "malformed JSON"} recipe during dry-run no-op`, async () => {
				const { dir, path, file } = fixture();
				const recipePath = join(dir, "unreadable.json");
				if (contents !== undefined) writeFileSync(recipePath, contents);
				const identity = fileIdentity(file);
				const result = await run({
					dir,
					args: [
						...argsFor({ mode, path, file }),
						"--recipe",
						recipePath,
						"--dry-run",
						"--json",
					],
				});
				assert.equal(result.status, 1, result.stderr);
				assert.equal(result.stdout, "");
				assert.match(result.stderr, /Cannot read recipe/);
				assert.equal(readFileSync(file, "utf-8"), original);
				assert.deepEqual(fileIdentity(file), identity);
			});
		}
	}
});

for (const mode of modes) {
	test(`${mode}: no-op cannot authorize in-place stdin even during dry-run`, async () => {
		const { dir, path, file } = fixture();
		const identity = fileIdentity(file);
		for (const flags of [[], ["--dry-run", "--json"]]) {
			const result = await run({
				dir,
				args: [...argsFor({ mode, path }), "--in-place", ...flags],
				stdin: original,
			});
			assert.equal(result.status, 1, result.stderr);
			assert.equal(result.stdout, "");
			assert.match(result.stderr, /--in-place cannot be used with stdin/);
			assert.equal(readFileSync(file, "utf-8"), original);
			assert.deepEqual(fileIdentity(file), identity);
		}
	});
	test(`${mode}: real migration followed by repeated stdin XML and in-place JSON is parseable and lossless`, async () => {
		const { dir, path, file } = fixture();
		const oldPath = join(dir, "old.json");
		const old = { ...template, version: 1 };
		writeFileSync(oldPath, JSON.stringify(old));
		seedTemplateCache(join(dir, "data"), [old, template]);
		const seed = await run({
			dir,
			args: [
				"apply",
				oldPath,
				TASK,
				resolve("tests/fixtures/simple.bpmn"),
				"--set",
				"message=retained",
			],
		});
		assert.equal(seed.status, 0, seed.stderr);
		writeFileSync(file, seed.stdout);
		const migrated = await run({ dir, args: argsFor({ mode, path, file }) });
		assert.equal(migrated.status, 0, migrated.stderr);
		assert.match(migrated.stderr, /No values lost/);
		assert.notEqual(migrated.stdout, seed.stdout);
		const repeated = await run({
			dir,
			args: argsFor({ mode, path }),
			stdin: migrated.stdout,
		});
		assert.equal(repeated.status, 0, repeated.stderr);
		assert.equal(repeated.stdout, migrated.stdout);
		assert.match(repeated.stderr, /already on.*nothing to do/);
		writeFileSync(file, repeated.stdout);
		const identity = fileIdentity(file);
		const json = await run({
			dir,
			args: [...argsFor({ mode, path, file }), "--in-place", "--json"],
		});
		assert.equal(json.status, 0, json.stderr);
		assert.equal(json.stderr, "");
		assertNoopJson({ stdout: json.stdout, mode, dryRun: false, file });
		assert.deepEqual(fileIdentity(file), identity);
		assert.equal(readFileSync(file, "utf-8"), repeated.stdout);
		const properties = await run({
			dir,
			args: ["edit", TASK, file, "--set", "message=retained"],
		});
		assert.equal(properties.status, 0, properties.stderr);
		assert.match(properties.stdout, /source="retained" target="message"/);
	});
}

describe("update CLI: no-op contract (shared update fixtures)", () => {
	const w = createUpdateWorkspace();
	const { TASK, V1, V2 } = updateFixtures;
	const { ws } = w;
	const {
		run,
		runWithPreload,
		dataDirWithCache,
		failingSaveXmlPreload,
		seedMulti,
		setup,
		teardown,
		assertCleanedUp,
	} = w;
	before(setup);
	after(teardown);

	test("no-op still validates a supplied recipe", async () => {
		const recipePath = join(ws.workDir, "invalid-noop-recipe.json");
		writeFileSync(
			recipePath,
			JSON.stringify({ schemaVersion: 2, sources: [] }),
		);
		const result = await run(
			dataDirWithCache([V1]),
			"update",
			V1.id,
			TASK,
			ws.versionedBpmn,
			"--recipe",
			recipePath,
		);
		assert.strictEqual(result.status, 1);
		assert.match(result.stderr, /schemaVersion/);
	});

	test("reports when the element is already up to date", async () => {
		const result = await run(
			dataDirWithCache([V1]),
			"update",
			V1.id,
			TASK,
			ws.versionedBpmn,
		);
		assert.strictEqual(result.status, 0, result.stderr);
		assert.strictEqual(result.stdout, readFileSync(ws.versionedBpmn, "utf-8"));
		assert.match(result.stderr, /already on/);
	});

	test("JSON no-ops preserve the report envelope with and without --to", async () => {
		const templatePath = join(ws.workDir, "same.json");
		writeFileSync(templatePath, JSON.stringify(V1));
		for (const extra of [[], ["--to", templatePath]]) {
			const result = await run(
				dataDirWithCache([V1]),
				"update",
				V1.id,
				TASK,
				ws.versionedBpmn,
				...extra,
				"--dry-run",
				"--json",
			);
			assert.strictEqual(result.status, 0, result.stderr);
			const json = JSON.parse(result.stdout);
			assert.strictEqual(json.results.length, 1);
			const [entry] = json.results;
			assert.strictEqual(entry.status, "unchanged");
			assert.strictEqual(entry.noop, true);
			assert.strictEqual(entry.lossless, true);
			assert.deepStrictEqual(entry.report.moved, []);
			assert.strictEqual(result.stderr, "");
		}
	});

	test("a run where every element is already on the target does not rewrite the file", async () => {
		const file = await seedMulti("allnoop", [
			[TASK, V2, ["provider=azure", "url=https://a"]],
			["Task_B", V2, ["provider=azure", "url=https://b"]],
		]);
		const before = readFileSync(file, "utf-8");
		const mtime = statSync(file).mtimeMs;
		const result = await runWithPreload(
			dataDirWithCache([V1, V2]),
			failingSaveXmlPreload(),
			["update", V1.id, file, "--in-place"],
		);
		assert.strictEqual(result.status, 0, result.stderr);
		assert.match(result.stdout, /Summary: 0 updated, 0 skipped, 2 unchanged/);
		assert.doesNotMatch(result.stdout, /Updated /);
		assert.strictEqual(readFileSync(file, "utf-8"), before);
		assert.strictEqual(statSync(file).mtimeMs, mtime);
	});

	test("removes every temp dir it created", assertCleanedUp);
});
