/**
 * Behavioural tests for `element-template update`
 * (default-plugins/element-template/commands/migrate.ts)
 */

import assert from "node:assert";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { c8WithOptions } from "../utils/cli.ts";
import { input, seedTemplateCache } from "../utils/element-template.ts";

const FIXTURE_BPMN = join(
	resolve(import.meta.dirname, "..", "fixtures"),
	"simple.bpmn",
);
const TASK = "Activity_17s7axj";

const OLD = {
	id: "io.example.old",
	name: "Old connector",
	version: 1,
	deprecated: true,
	appliesTo: ["bpmn:Task"],
	engines: { camunda: "^8.8" },
	groups: [{ id: "model", label: "Model" }],
	properties: [
		{
			type: "Hidden",
			value: "io.example.old",
			binding: { type: "zeebe:taskDefinition", property: "type" },
		},
		input("provider", "azure", { label: "Provider", group: "model" }),
		input("endpoint", "", { label: "Endpoint", group: "model" }),
		input("maxTokens", "", { label: "Maximum tokens", group: "model" }),
	],
};

const NEW = {
	id: "io.example.new",
	name: "New connector",
	version: 1,
	appliesTo: ["bpmn:Task"],
	engines: { camunda: "^8.8" },
	groups: [{ id: "model", label: "Model" }],
	metadata: {
		migratesFrom: {
			schemaVersion: 1,
			sources: [
				{
					kind: "change",
					sourceTemplateId: "io.example.old",
					paths: [
						{ from: "provider", to: "backend.provider" },
						{ from: "endpoint", to: "backend.endpoint" },
						{
							to: "backend.type",
							set: "foundry",
							note: { level: "warning", message: "Backend chosen for you" },
						},
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
		input("backend.provider", "", { label: "Provider", group: "model" }),
		input("backend.endpoint", "", { label: "API endpoint", group: "model" }),
		input("backend.type", "", { label: "Backend", group: "model" }),
		input("effort", "default", { label: "Effort", group: "model" }),
	],
};

const V2 = {
	...OLD,
	id: "io.example.versioned",
	name: "Versioned connector",
	version: 2,
	deprecated: undefined,
	engines: { camunda: "^8.8" },
	metadata: {
		migratesFrom: {
			schemaVersion: 1,
			sources: [
				{
					kind: "upgrade",
					sourceTemplateId: "io.example.versioned",
					toVersion: 2,
					paths: [{ from: "endpoint", to: "url" }],
				},
			],
		},
	},
	properties: [
		{
			type: "Hidden",
			value: "io.example.versioned",
			binding: { type: "zeebe:taskDefinition", property: "type" },
		},
		input("provider", "azure", { label: "Provider", group: "model" }),
		input("url", "", { label: "URL", group: "model" }),
	],
};
const V1 = {
	...OLD,
	id: "io.example.versioned",
	name: "Versioned connector",
	version: 1,
	deprecated: undefined,
	engines: { camunda: "^8.8" },
	properties: [
		{
			type: "Hidden",
			value: "io.example.versioned",
			binding: { type: "zeebe:taskDefinition", property: "type" },
		},
		input("provider", "azure", { label: "Provider", group: "model" }),
		input("endpoint", "", { label: "Endpoint", group: "model" }),
	],
};

let workDir: string;
let oldBpmn: string;
let versionedBpmn: string;
const cleanups: string[] = [];

function dataDirWithCache(templates: object[]): string {
	const dataDir = mkdtempSync(join(tmpdir(), "c8ctl-migrate-data-"));
	cleanups.push(dataDir);
	seedTemplateCache(dataDir, templates);
	return dataDir;
}

function run(dataDir: string, ...args: string[]) {
	return c8WithOptions(
		{ env: { C8CTL_DATA_DIR: dataDir } },
		"element-template",
		...args,
	);
}

function runWithPreload(dataDir: string, preload: string, args: string[]) {
	return c8WithOptions(
		{ env: { C8CTL_DATA_DIR: dataDir }, nodeArgs: ["--require", preload] },
		"element-template",
		...args,
	);
}

function failingSaveXmlPreload(): string {
	const bundle = resolve(
		import.meta.dirname,
		"..",
		"..",
		"dist",
		"vendor",
		"bpmn-element-templates.cjs",
	);
	const preload = join(workDir, "fail-save-xml.cjs");
	writeFileSync(
		preload,
		`const v = require(${JSON.stringify(bundle)});
v.Modeler.prototype.saveXML = () => Promise.reject(new Error("saveXML must not run"));
`,
	);
	return preload;
}

async function seedBpmn(
	template: object,
	values: string[],
	name: string,
): Promise<string> {
	const templatePath = join(workDir, `${name}.template.json`);
	writeFileSync(templatePath, JSON.stringify(template));
	const dataDir = dataDirWithCache([]);
	const result = await run(
		dataDir,
		"apply",
		templatePath,
		TASK,
		FIXTURE_BPMN,
		...values.flatMap((v) => ["--set", v]),
	);
	assert.strictEqual(result.status, 0, result.stderr);
	const out = join(workDir, `${name}.bpmn`);
	writeFileSync(out, result.stdout);
	return out;
}

before(async () => {
	workDir = mkdtempSync(join(tmpdir(), "c8ctl-migrate-"));
	cleanups.push(workDir);
	oldBpmn = await seedBpmn(
		OLD,
		["provider=azure", "endpoint=https://x", "maxTokens=2000"],
		"old",
	);
	versionedBpmn = await seedBpmn(
		V1,
		["provider=azure", "endpoint=https://v1"],
		"v1",
	);
});

function removeCleanups(): void {
	for (const dir of cleanups) {
		rmSync(dir, { recursive: true, force: true });
	}
}

// Safety net when the last test below does not run.
after(removeCleanups);

describe("migration catalog selection authority", () => {
	test("rejects conflicting cached targets before selection on every cache-driven path", async () => {
		const successor = {
			...NEW,
			metadata: {
				migratesFrom: {
					schemaVersion: 1,
					sources: [{ kind: "change", sourceTemplateId: V1.id }],
				},
			},
		};
		for (const [target, commands] of [
			[
				V2,
				[
					["update", V1.id, TASK, versionedBpmn],
					["update", V1.id, TASK, versionedBpmn, "--to", `${V2.id}@2`],
					["update", V1.id, TASK, versionedBpmn, "--to", V2.id],
				],
			],
			[
				successor,
				[["update", V1.id, TASK, versionedBpmn, "--to", successor.id]],
			],
		] as const) {
			const shadow = { ...target, name: "Conflicting cached target" };
			const diagnostics: string[] = [];
			for (const duplicates of [
				[target, shadow],
				[shadow, target],
			]) {
				const dataDir = dataDirWithCache([V1, ...duplicates]);
				for (const command of commands) {
					const result = await run(dataDir, ...command, "--dry-run", "--json");
					assert.strictEqual(result.status, 1, result.stdout);
					assert.strictEqual(result.stdout, "");
					assert.match(result.stderr, /Conflicting definitions for template/);
					diagnostics.push(
						result.stderr.slice(
							result.stderr.indexOf("Conflicting definitions"),
						),
					);
				}
			}
			assert.ok(diagnostics.every((message) => message === diagnostics[0]));
			for (const command of commands) {
				const result = await run(
					dataDirWithCache([V1, target, structuredClone(target)]),
					...command,
					"--dry-run",
					"--allow-lossy",
					"--json",
				);
				assert.strictEqual(result.status, 0, result.stderr);
				assert.strictEqual(result.stderr, "");
				assert.strictEqual(
					JSON.parse(result.stdout).results[0].to.id,
					target.id,
				);
			}
		}
	});
});

describe("migration engine eligibility", () => {
	for (const namespace of ["urn:unrelated", "", undefined]) {
		test(`rejects spoofed modeler namespace ${JSON.stringify(namespace)} on every selection path`, async () => {
			const file = join(workDir, `spoofed-namespace-${String(namespace)}.bpmn`);
			const xml = readFileSync(versionedBpmn, "utf-8").replace(
				/ xmlns:modeler="[^"]*"/,
				namespace === undefined ? "" : ` xmlns:modeler="${namespace}"`,
			);
			writeFileSync(file, xml);
			for (const args of [
				["update", V1.id, TASK, file],
				["update", V1.id, TASK, file, "--to", `${V2.id}@2`],
				["update", V1.id, TASK, file, "--to", V2.id],
			]) {
				const result = await run(
					dataDirWithCache([V1, V2]),
					...args,
					"--in-place",
					"--allow-lossy",
				);
				assert.strictEqual(result.status, 1, result.stderr);
				assert.match(result.stderr, /Cannot verify template compatibility/);
				assert.strictEqual(result.stdout, "");
				assert.strictEqual(readFileSync(file, "utf-8"), xml);
				assert.ok(!existsSync(`${file}.migration.lock`));
			}
		});
	}
	for (const splitPrefixes of [false, true]) {
		test(`accepts namespace-qualified engine metadata with ${splitPrefixes ? "split" : "aliased"} prefixes`, async () => {
			const file = join(workDir, `aliased-namespace-${splitPrefixes}.bpmn`);
			const xml = readFileSync(versionedBpmn, "utf-8")
				.replaceAll("modeler:", "metadata:")
				.replace("xmlns:modeler=", "xmlns:metadata=")
				.replace(
					"metadata:executionPlatformVersion=",
					splitPrefixes
						? 'xmlns:engine="http://camunda.org/schema/modeler/1.0" engine:executionPlatformVersion='
						: "metadata:executionPlatformVersion=",
				);
			writeFileSync(file, xml);
			for (const [templates, args, version] of [
				[[V1, V2], ["update", V1.id, TASK, file], 2],
				[[V1, V2], ["update", V1.id, TASK, file, "--to", `${V2.id}@2`], 2],
				[[V1, V2], ["update", V1.id, TASK, file, "--to", V2.id], 2],
				[[V1, NEW], ["update", V1.id, TASK, file, "--to", NEW.id], 1],
			] as const) {
				const cache = templates.map((template) =>
					template.id === NEW.id
						? {
								...NEW,
								metadata: {
									migratesFrom: {
										schemaVersion: 1,
										sources: [{ kind: "change", sourceTemplateId: V1.id }],
									},
								},
							}
						: template,
				);
				const result = await run(dataDirWithCache(cache), ...args);
				assert.strictEqual(result.status, 0, result.stderr);
				assert.match(
					result.stdout,
					new RegExp(`modelerTemplateVersion="${version}"`),
				);
			}
		});
	}
	for (const version of [
		"release-8.8.0",
		"8.8.0-junk trailing",
		"8.8.0.1",
		"8",
		"8.08.0",
		"08.8",
		"v8.8.0",
		"8.8-alpha1",
		"8.8.0-01",
		"8.8.0-alpha..1",
		"8.8.0+build..1",
		"8.8.0&#10;",
		"8.8.0&#13;",
		"^8.8",
		"",
		undefined,
	]) {
		test(`rejects malformed document version ${JSON.stringify(version)} on every selection path`, async () => {
			const file = join(
				workDir,
				`invalid-version-${encodeURIComponent(String(version))}.bpmn`,
			);
			const xml = readFileSync(versionedBpmn, "utf-8").replace(
				/ modeler:executionPlatformVersion="[^"]*"/,
				version === undefined
					? ""
					: ` modeler:executionPlatformVersion="${version}"`,
			);
			writeFileSync(file, xml);
			for (const args of [
				["update", V1.id, TASK, file],
				["update", V1.id, TASK, file, "--to", `${V2.id}@2`],
				["update", V1.id, TASK, file, "--to", V2.id],
			]) {
				const result = await run(
					dataDirWithCache([V1, V2]),
					...args,
					"--in-place",
					"--allow-lossy",
				);
				assert.strictEqual(result.status, 1, result.stderr);
				assert.match(
					result.stderr,
					/Cannot verify template compatibility.*executionPlatformVersion/,
				);
				assert.strictEqual(result.stdout, "");
				assert.strictEqual(readFileSync(file, "utf-8"), xml);
				assert.ok(!existsSync(`${file}.migration.lock`));
			}
		});
	}
	for (const platform of [
		undefined,
		"",
		"Camunda Platform",
		"Camunda Cloud junk",
	]) {
		test(`rejects unsupported document platform ${JSON.stringify(platform)}`, async () => {
			const file = join(
				workDir,
				`invalid-platform-${encodeURIComponent(String(platform))}.bpmn`,
			);
			const xml = readFileSync(versionedBpmn, "utf-8").replace(
				/ modeler:executionPlatform="[^"]*"/,
				platform === undefined
					? ""
					: ` modeler:executionPlatform="${platform}"`,
			);
			writeFileSync(file, xml);
			for (const args of [
				["update", V1.id, TASK, file],
				["update", V1.id, TASK, file, "--to", `${V2.id}@2`],
				["update", V1.id, TASK, file, "--to", V2.id],
			]) {
				const result = await run(
					dataDirWithCache([V1, V2]),
					...args,
					"--in-place",
					"--allow-lossy",
				);
				assert.strictEqual(result.status, 1, result.stderr);
				assert.match(
					result.stderr,
					/Cannot verify template compatibility.*executionPlatform/,
				);
				assert.strictEqual(result.stdout, "");
				assert.strictEqual(readFileSync(file, "utf-8"), xml);
			}
		});
	}
	for (const [name, engines] of [
		["null engines", null],
		["string engines", "^8.8"],
		["array engines", []],
		["boolean engines", false],
		["null range", { camunda: null }],
		["numeric range", { camunda: 8.8 }],
		["boolean range", { camunda: false }],
		["object range", { camunda: {} }],
		["array range", { camunda: ["^8.8"] }],
		["empty range", { camunda: "" }],
		["blank range", { camunda: " " }],
		["junk range", { camunda: "release-8.8.0" }],
		["invalid prerelease range", { camunda: "8.8.0-01" }],
		["incompatible range", { camunda: ">=99.0.0" }],
	] as const) {
		test(`rejects explicit targets with ${name} before writing`, async () => {
			const target = { ...V2, engines };
			const templatePath = join(workDir, `engine-target-${name}.json`);
			writeFileSync(templatePath, JSON.stringify(target));
			for (const to of [`${V2.id}@2`, templatePath]) {
				const file = join(workDir, `engine-target-${name}.bpmn`);
				const xml = readFileSync(versionedBpmn, "utf-8");
				writeFileSync(file, xml);
				const result = await run(
					dataDirWithCache([V1, target]),
					"update",
					V1.id,
					TASK,
					file,
					"--to",
					to,
					"--in-place",
					"--allow-lossy",
				);
				assert.strictEqual(result.status, 1, result.stderr);
				assert.match(result.stderr, /not compatible with Camunda/);
				assert.strictEqual(result.stdout, "");
				assert.strictEqual(readFileSync(file, "utf-8"), xml);
			}
		});
		test(`excludes ${name} from automatic targets and source lineage`, async () => {
			const invalidUpgrade = {
				...OLD,
				version: 2,
				engines,
				metadata: {
					migratesFrom: {
						schemaVersion: 1,
						sources: [
							{ kind: "upgrade", sourceTemplateId: OLD.id, toVersion: 2 },
						],
					},
				},
			};
			const successor = {
				...NEW,
				metadata: {
					migratesFrom: {
						schemaVersion: 1,
						sources: [
							{ kind: "change", sourceTemplateId: OLD.id, minSourceVersion: 2 },
						],
					},
				},
			};
			const cache = dataDirWithCache([OLD, invalidUpgrade, successor]);
			const discovered = await run(cache, "update", OLD.id, TASK, oldBpmn);
			assert.strictEqual(discovered.status, 0, discovered.stderr);
			assert.strictEqual(discovered.stdout, readFileSync(oldBpmn, "utf-8"));
			assert.match(discovered.stderr, /already on/);
			const update = await run(
				dataDirWithCache([V1, { ...V2, engines }]),
				"update",
				V1.id,
				TASK,
				versionedBpmn,
			);
			assert.strictEqual(update.status, 0, update.stderr);
			assert.strictEqual(update.stdout, readFileSync(versionedBpmn, "utf-8"));
			const unpinned = await run(
				dataDirWithCache([V1, { ...V2, engines }]),
				"update",
				V1.id,
				TASK,
				versionedBpmn,
				"--to",
				V2.id,
			);
			assert.strictEqual(unpinned.status, 0, unpinned.stderr);
			assert.strictEqual(unpinned.stdout, readFileSync(versionedBpmn, "utf-8"));
			const chosen = await run(
				dataDirWithCache([OLD, NEW, { ...NEW, version: 2, engines }]),
				"update",
				OLD.id,
				TASK,
				oldBpmn,
				"--to",
				NEW.id,
			);
			assert.strictEqual(chosen.status, 0, chosen.stderr);
			assert.match(chosen.stdout, /modelerTemplateVersion="1"/);
		});
		test(`rejects a required source step with ${name} before mutation`, async () => {
			const latest = {
				...OLD,
				version: 3,
				metadata: {
					migratesFrom: {
						schemaVersion: 1,
						sources: [
							{ kind: "upgrade", sourceTemplateId: OLD.id, toVersion: 2 },
							{ kind: "upgrade", sourceTemplateId: OLD.id, toVersion: 3 },
						],
					},
				},
			};
			const file = join(workDir, `engine-step-${name}.bpmn`);
			const xml = readFileSync(oldBpmn, "utf-8");
			writeFileSync(file, xml);
			const result = await run(
				dataDirWithCache([OLD, { ...OLD, version: 2, engines }, latest, NEW]),
				"update",
				OLD.id,
				TASK,
				file,
				"--to",
				`${NEW.id}@1`,
				"--in-place",
				"--allow-lossy",
			);
			assert.strictEqual(result.status, 1, result.stderr);
			assert.match(result.stderr, /version 2 is not available/);
			assert.match(result.stderr, /Nothing was written/);
			assert.strictEqual(readFileSync(file, "utf-8"), xml);
		});
	}
	for (const version of ["8.8", "8.8.0", "8.8.0+build.1"]) {
		test(`accepts document version ${version} with absent legacy engine constraints`, async () => {
			const file = join(workDir, `valid-engine-${version}.bpmn`);
			writeFileSync(
				file,
				readFileSync(versionedBpmn, "utf-8").replace(
					/modeler:executionPlatformVersion="[^"]*"/,
					`modeler:executionPlatformVersion="${version}"`,
				),
			);
			for (const engines of [undefined, {}, { modeler: ">=5.0" }]) {
				const result = await run(
					dataDirWithCache([V1, { ...V2, engines }]),
					"update",
					V1.id,
					TASK,
					file,
				);
				assert.strictEqual(result.status, 0, result.stderr);
				assert.match(result.stdout, /modelerTemplateVersion="2"/);
			}
		});
	}
	test("preserves prerelease semantics instead of coercing to a stable engine", async () => {
		const file = join(workDir, "prerelease-engine.bpmn");
		writeFileSync(
			file,
			readFileSync(versionedBpmn, "utf-8").replace(
				/modeler:executionPlatformVersion="[^"]*"/,
				'modeler:executionPlatformVersion="8.8.0-alpha1"',
			),
		);
		const result = await run(
			dataDirWithCache([V1, V2]),
			"update",
			V1.id,
			TASK,
			file,
			"--to",
			`${V2.id}@2`,
		);
		assert.strictEqual(result.status, 1, result.stderr);
		assert.match(result.stderr, /not compatible with Camunda 8\.8\.0-alpha1/);
		assert.strictEqual(result.stdout, "");
	});
	test("automatically selects templates explicitly supporting a prerelease engine", async () => {
		const file = join(workDir, "supported-prerelease-engine.bpmn");
		writeFileSync(
			file,
			readFileSync(versionedBpmn, "utf-8").replace(
				/modeler:executionPlatformVersion="[^"]*"/,
				'modeler:executionPlatformVersion="8.8.0-alpha1"',
			),
		);
		const engines = { camunda: "8.8.0-alpha1" };
		for (const args of [
			["update", V1.id, TASK, file],
			["update", V1.id, TASK, file, "--to", V2.id],
		]) {
			const result = await run(
				dataDirWithCache([
					{ ...V1, engines },
					{ ...V2, engines },
				]),
				...args,
			);
			assert.strictEqual(result.status, 0, result.stderr);
			assert.match(result.stdout, /modelerTemplateVersion="2"/);
		}
	});
	test("preserves unconstrained legacy eligibility for prerelease engines on every target path", async () => {
		const file = join(workDir, "legacy-prerelease-engine.bpmn");
		const xml = readFileSync(oldBpmn, "utf-8").replace(
			/modeler:executionPlatformVersion="[^"]*"/,
			'modeler:executionPlatformVersion="8.8.0-alpha.1+build.2"',
		);
		writeFileSync(file, xml);
		for (const engines of [undefined, {}, { modeler: ">=5.0" }]) {
			const source = { ...OLD, engines };
			const successor = { ...NEW, engines };
			const upgrade = { ...source, version: 2 };
			const cache = dataDirWithCache([source, upgrade, successor]);
			for (const [args, expected] of [
				[["update", OLD.id, TASK, file], /modelerTemplateVersion="2"/],
				[
					["update", OLD.id, TASK, file, "--to", `${NEW.id}@1`],
					/modelerTemplate="io\.example\.new"/,
				],
				[
					["update", OLD.id, TASK, file, "--to", NEW.id],
					/modelerTemplate="io\.example\.new"/,
				],
			] as const) {
				const result = await run(cache, ...args);
				assert.strictEqual(result.status, 0, result.stderr);
				assert.match(result.stdout, expected);
			}
		}
	});
});

describe("element-template update to another template", () => {
	test("lossy in-place migration requires authorization and preserves the original on refusal", async () => {
		const copy = join(workDir, "lossy-refused.bpmn");
		const before = readFileSync(oldBpmn, "utf-8");
		writeFileSync(copy, before);
		const templatePath = join(workDir, "lossy-target.json");
		writeFileSync(templatePath, JSON.stringify(NEW));
		const result = await run(
			dataDirWithCache([OLD]),
			"update",
			OLD.id,
			TASK,
			copy,
			"--to",
			templatePath,
			"--in-place",
		);
		assert.strictEqual(result.status, 1);
		assert.match(result.stderr, /--allow-lossy/);
		assert.strictEqual(readFileSync(copy, "utf-8"), before);
	});
	test("explicit recipe with the wrong source fails even with loss authorization", async () => {
		const templatePath = join(workDir, "wrong-source-target.json");
		writeFileSync(templatePath, JSON.stringify(NEW));
		const recipePath = join(workDir, "wrong-source-recipe.json");
		writeFileSync(
			recipePath,
			JSON.stringify({
				schemaVersion: 1,
				sources: [{ kind: "change", sourceTemplateId: "unrelated" }],
			}),
		);
		const result = await run(
			dataDirWithCache([OLD]),
			"update",
			OLD.id,
			TASK,
			oldBpmn,
			"--to",
			templatePath,
			"--recipe",
			recipePath,
			"--allow-lossy",
		);
		assert.strictEqual(result.status, 1);
		assert.match(result.stderr, /source|applicable/);
	});
	test("rejects engine-incompatible explicit targets", async () => {
		const incompatible = { ...NEW, engines: { camunda: ">=99.0.0" } };
		const templatePath = join(workDir, "incompatible.json");
		writeFileSync(templatePath, JSON.stringify(incompatible));
		for (const to of [templatePath, incompatible.id]) {
			const result = await run(
				dataDirWithCache([OLD, incompatible]),
				"update",
				OLD.id,
				TASK,
				oldBpmn,
				"--to",
				to,
			);
			assert.strictEqual(result.status, 1, result.stdout);
			assert.match(result.stderr, /compatible|migration/);
		}
	});
	test("explicit target content wins over a conflicting cached identity", async () => {
		const templatePath = join(workDir, "authoritative.json");
		writeFileSync(templatePath, JSON.stringify(NEW));
		const stale = {
			...NEW,
			properties: [input("stale", "STALE", { label: "Stale", group: "model" })],
		};
		// Not deprecated: a deprecated source also scans cached successors, which conflict with the file.
		const result = await run(
			dataDirWithCache([{ ...OLD, deprecated: undefined }, stale]),
			"update",
			OLD.id,
			TASK,
			oldBpmn,
			"--to",
			templatePath,
		);
		assert.strictEqual(result.status, 0, result.stderr);
		assert.match(
			result.stdout,
			/source="https:\/\/x" target="backend.endpoint"/,
		);
		assert.doesNotMatch(result.stdout, /STALE/);
	});
	test("migrates to a template file, printing the BPMN and a report on stderr", async () => {
		const templatePath = join(workDir, "new.json");
		writeFileSync(templatePath, JSON.stringify(NEW));
		const result = await run(
			dataDirWithCache([OLD]),
			"update",
			OLD.id,
			TASK,
			oldBpmn,
			"--to",
			templatePath,
		);
		assert.strictEqual(result.status, 0, result.stderr);
		assert.match(result.stdout, /modelerTemplate="io.example.new"/);
		assert.match(
			result.stdout,
			/source="https:\/\/x" target="backend.endpoint"/,
		);
		assert.match(result.stdout, /source="foundry" target="backend.type"/);
		assert.match(result.stderr, /Dropped \(1\)/);
		assert.match(result.stderr, /Model › Maximum tokens {2}2000/);
		assert.match(result.stderr, /Moved \(2\)/);
		assert.match(result.stderr, /Backend chosen for you/);
		assert.match(result.stderr, /Summary: 1 updated, 0 skipped/);
		assert.doesNotMatch(result.stdout, /Dropped/);
	});

	test("writes the file with --in-place and reports on stdout", async () => {
		const copy = join(workDir, "inplace.bpmn");
		writeFileSync(copy, readFileSync(oldBpmn));
		const templatePath = join(workDir, "new.json");
		writeFileSync(templatePath, JSON.stringify(NEW));
		const result = await run(
			dataDirWithCache([OLD]),
			"update",
			OLD.id,
			TASK,
			copy,
			"--to",
			templatePath,
			"--in-place",
			"--allow-lossy",
		);
		assert.strictEqual(result.status, 0, result.stderr);
		assert.match(
			readFileSync(copy, "utf-8"),
			/modelerTemplate="io.example.new"/,
		);
		assert.match(result.stdout, /Dropped \(1\)/);
		assert.match(result.stdout, /Updated /);
	});

	test("--dry-run previews the report and leaves the file alone", async () => {
		const templatePath = join(workDir, "new.json");
		writeFileSync(templatePath, JSON.stringify(NEW));
		const before = readFileSync(oldBpmn, "utf-8");
		const result = await run(
			dataDirWithCache([OLD]),
			"update",
			OLD.id,
			TASK,
			oldBpmn,
			"--to",
			templatePath,
			"--dry-run",
			"--allow-lossy",
		);
		assert.strictEqual(result.status, 0, result.stderr);
		assert.match(result.stdout, /Dry run: nothing was written/);
		assert.doesNotMatch(result.stdout, /<bpmn:definitions/);
		assert.strictEqual(readFileSync(oldBpmn, "utf-8"), before);
	});

	test("a lossy --dry-run without --allow-lossy exits 1 and still prints the report", async () => {
		const templatePath = join(workDir, "new.json");
		writeFileSync(templatePath, JSON.stringify(NEW));
		const before = readFileSync(oldBpmn, "utf-8");
		const result = await run(
			dataDirWithCache([OLD]),
			"update",
			OLD.id,
			TASK,
			oldBpmn,
			"--to",
			templatePath,
			"--dry-run",
		);
		assert.strictEqual(result.status, 1, result.stderr);
		assert.match(result.stdout, /Dropped \(1\)/);
		assert.match(result.stdout, /A write would be blocked/);
		assert.strictEqual(readFileSync(oldBpmn, "utf-8"), before);
	});

	test("--dry-run does not serialize the diagram", async () => {
		const templatePath = join(workDir, "new.json");
		writeFileSync(templatePath, JSON.stringify(NEW));
		const result = await runWithPreload(
			dataDirWithCache([OLD]),
			failingSaveXmlPreload(),
			[
				"update",
				OLD.id,
				TASK,
				oldBpmn,
				"--to",
				templatePath,
				"--dry-run",
				"--allow-lossy",
			],
		);
		assert.strictEqual(result.status, 0, result.stderr);
		assert.match(result.stdout, /Dry run: nothing was written/);
	});

	test("serialization failure surfaces without --dry-run", async () => {
		const templatePath = join(workDir, "new.json");
		writeFileSync(templatePath, JSON.stringify(NEW));
		const result = await runWithPreload(
			dataDirWithCache([OLD]),
			failingSaveXmlPreload(),
			["update", OLD.id, TASK, oldBpmn, "--to", templatePath],
		);
		assert.strictEqual(result.status, 1);
		assert.match(result.stderr, /saveXML must not run/);
	});

	test("--json --dry-run emits the report as one JSON document", async () => {
		const templatePath = join(workDir, "new.json");
		writeFileSync(templatePath, JSON.stringify(NEW));
		const result = await run(
			dataDirWithCache([OLD]),
			"update",
			OLD.id,
			TASK,
			oldBpmn,
			"--to",
			templatePath,
			"--dry-run",
			"--allow-lossy",
			"--json",
		);
		assert.strictEqual(result.status, 0, result.stderr);
		const json = JSON.parse(result.stdout);
		assert.strictEqual(json.command, "element-template update");
		assert.strictEqual(json.dryRun, true);
		assert.strictEqual(json.results.length, 1);
		const [entry] = json.results;
		assert.strictEqual(entry.status, "updated");
		assert.strictEqual(entry.action, undefined);
		assert.strictEqual(entry.elementId, TASK);
		assert.strictEqual(entry.recipe.source, "embedded");
		assert.strictEqual(entry.lossless, false);
		assert.strictEqual(entry.requiresAuthorization, true);
		assert.strictEqual(entry.authorized, true);
		assert.strictEqual(entry.report.dropped[0].value, "2000");
		assert.strictEqual(entry.report.moved.length, 2);
		assert.deepStrictEqual(json.summary, {
			updated: 1,
			skipped: 0,
			unchanged: 0,
			failed: 0,
			dropped: 1,
			blocked: 0,
		});
	});

	test("--json without --in-place or --dry-run is refused", async () => {
		const templatePath = join(workDir, "new.json");
		writeFileSync(templatePath, JSON.stringify(NEW));
		const result = await run(
			dataDirWithCache([OLD]),
			"update",
			OLD.id,
			TASK,
			oldBpmn,
			"--to",
			templatePath,
			"--json",
		);
		assert.strictEqual(result.status, 1);
		assert.match(result.stderr, /--json needs --in-place or --dry-run/);
	});

	test("without --to a deprecated template stays put and the report names declared successors", async () => {
		const result = await run(
			dataDirWithCache([OLD, NEW]),
			"update",
			OLD.id,
			TASK,
			oldBpmn,
		);
		assert.strictEqual(result.status, 0, result.stderr);
		assert.strictEqual(result.stdout, readFileSync(oldBpmn, "utf-8"));
		assert.match(result.stderr, /deprecated.*io\.example\.new/s);
		assert.doesNotMatch(result.stdout, /io\.example\.new/);
	});

	test("--recipe overrides the embedded recipe", async () => {
		const templatePath = join(workDir, "new.json");
		writeFileSync(templatePath, JSON.stringify(NEW));
		const recipePath = join(workDir, "recipe.json");
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
			oldBpmn,
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
		const templatePath = join(workDir, "new.json");
		writeFileSync(templatePath, JSON.stringify(NEW));
		const recipePath = join(workDir, "bad-recipe.json");
		writeFileSync(
			recipePath,
			JSON.stringify({ schemaVersion: 2, sources: [] }),
		);
		const result = await run(
			dataDirWithCache([OLD]),
			"update",
			OLD.id,
			TASK,
			oldBpmn,
			"--to",
			templatePath,
			"--recipe",
			recipePath,
		);
		assert.strictEqual(result.status, 1);
		assert.match(result.stderr, /Update c8ctl/);
	});

	test("fails for an element without a template and for unknown elements", async () => {
		const templatePath = join(workDir, "new.json");
		writeFileSync(templatePath, JSON.stringify(NEW));
		const noTemplate = await run(
			dataDirWithCache([OLD]),
			"update",
			OLD.id,
			TASK,
			FIXTURE_BPMN,
			"--to",
			templatePath,
		);
		assert.strictEqual(noTemplate.status, 1);
		assert.match(noTemplate.stderr, /no element template applied/);
		const unknown = await run(
			dataDirWithCache([OLD]),
			"update",
			OLD.id,
			"Nope",
			oldBpmn,
			"--to",
			templatePath,
		);
		assert.strictEqual(unknown.status, 1);
		assert.match(unknown.stderr, /Element "Nope" not found/);
	});
});

describe("element-template update", () => {
	test("no-op still validates a supplied recipe", async () => {
		const recipePath = join(workDir, "invalid-noop-recipe.json");
		writeFileSync(
			recipePath,
			JSON.stringify({ schemaVersion: 2, sources: [] }),
		);
		const result = await run(
			dataDirWithCache([V1]),
			"update",
			V1.id,
			TASK,
			versionedBpmn,
			"--recipe",
			recipePath,
		);
		assert.strictEqual(result.status, 1);
		assert.match(result.stderr, /schemaVersion/);
	});
	test("an existing writer lock prevents overwriting and is not removed", async () => {
		const file = join(workDir, "locked.bpmn");
		const before = readFileSync(versionedBpmn, "utf-8");
		writeFileSync(file, before);
		writeFileSync(`${file}.migration.lock`, "another writer");
		const result = await run(
			dataDirWithCache([V1, V2]),
			"update",
			V1.id,
			TASK,
			file,
			"--in-place",
		);
		assert.strictEqual(result.status, 1);
		assert.match(result.stderr, /migration lock/);
		assert.strictEqual(readFileSync(file, "utf-8"), before);
		assert.strictEqual(
			readFileSync(`${file}.migration.lock`, "utf-8"),
			"another writer",
		);
	});
	test("rejects missing engine metadata and incompatible required intermediate versions", async () => {
		const missingEngine = join(workDir, "missing-engine.bpmn");
		writeFileSync(
			missingEngine,
			readFileSync(versionedBpmn, "utf-8").replace(
				/ modeler:executionPlatformVersion="[^"]*"/,
				"",
			),
		);
		const missing = await run(
			dataDirWithCache([V1, V2]),
			"update",
			V1.id,
			TASK,
			missingEngine,
		);
		assert.strictEqual(missing.status, 1);
		assert.match(missing.stderr, /executionPlatformVersion/);
		const v3 = {
			...V2,
			version: 3,
			metadata: {
				migratesFrom: {
					schemaVersion: 1,
					sources: [
						{
							kind: "upgrade",
							sourceTemplateId: V1.id,
							toVersion: 2,
							paths: [{ from: "endpoint", to: "url" }],
						},
						{
							kind: "upgrade",
							sourceTemplateId: V1.id,
							toVersion: 3,
							paths: [],
						},
					],
				},
			},
		};
		const file = join(workDir, "missing-intermediate.bpmn");
		const xml = readFileSync(versionedBpmn, "utf-8");
		writeFileSync(file, xml);
		const result = await run(
			dataDirWithCache([V1, { ...V2, engines: { camunda: ">=99" } }, v3]),
			"update",
			V1.id,
			TASK,
			file,
			"--in-place",
		);
		assert.strictEqual(result.status, 1);
		assert.match(result.stderr, /version 2 is not available/);
		assert.strictEqual(readFileSync(file, "utf-8"), xml);
	});
	test("moves to the newest version and applies its recipe", async () => {
		const result = await run(
			dataDirWithCache([V1, V2]),
			"update",
			V1.id,
			TASK,
			versionedBpmn,
		);
		assert.strictEqual(result.status, 0, result.stderr);
		assert.match(result.stdout, /modelerTemplateVersion="2"/);
		assert.match(result.stdout, /source="https:\/\/v1" target="url"/);
		assert.match(result.stderr, /Model › Endpoint → URL/);
	});

	test("reports when the element is already up to date", async () => {
		const result = await run(
			dataDirWithCache([V1]),
			"update",
			V1.id,
			TASK,
			versionedBpmn,
		);
		assert.strictEqual(result.status, 0, result.stderr);
		assert.strictEqual(result.stdout, readFileSync(versionedBpmn, "utf-8"));
		assert.match(result.stderr, /already on/);
	});
	test("JSON no-ops preserve the report envelope with and without --to", async () => {
		const templatePath = join(workDir, "same.json");
		writeFileSync(templatePath, JSON.stringify(V1));
		for (const extra of [[], ["--to", templatePath]]) {
			const result = await run(
				dataDirWithCache([V1]),
				"update",
				V1.id,
				TASK,
				versionedBpmn,
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

	test("--to <id>@<n> pins a version and refuses a missing one", async () => {
		const missing = await run(
			dataDirWithCache([V1, V2]),
			"update",
			V1.id,
			TASK,
			versionedBpmn,
			"--to",
			`${V1.id}@7`,
		);
		assert.strictEqual(missing.status, 1);
		assert.match(missing.stderr, /has no version 7/);
	});

	test("needs the template in the cache", async () => {
		const result = await run(
			dataDirWithCache([NEW]),
			"update",
			V1.id,
			TASK,
			versionedBpmn,
		);
		assert.strictEqual(result.status, 1);
		assert.match(result.stderr, /Element template .* not found/);
	});

	test("the removed --successor and --to-version flags are not recognized", async () => {
		// The global parser warns and ignores unknown flags, so the update never changes the template id.
		// "--to-version 2" leaves "2" behind as a stray positional argument, which fails.
		for (const [removed, status] of [
			[["--successor"], 0],
			[["--to-version", "2"], 1],
		] as const) {
			const result = await run(
				dataDirWithCache([V1, V2]),
				"update",
				V1.id,
				TASK,
				versionedBpmn,
				...removed,
			);
			assert.strictEqual(result.status, status, result.stderr);
			assert.match(result.stderr, new RegExp(`Unknown flag ${removed[0]}`));
			assert.doesNotMatch(result.stdout, /io\.example\.new/);
		}
	});

	test("the change subcommand no longer exists", async () => {
		const result = await run(
			dataDirWithCache([V1, V2]),
			"change",
			V1.id,
			TASK,
			versionedBpmn,
		);
		assert.strictEqual(result.status, 1);
		assert.match(result.stderr, /Unknown subcommand 'change'/);
	});
});

const V3 = { ...V2, version: 3, metadata: undefined };
const SRC = {
	...OLD,
	id: "io.example.mapsrc",
	name: "Map source",
	deprecated: undefined,
	properties: [
		{
			type: "Hidden",
			value: "io.example.mapsrc",
			binding: { type: "zeebe:taskDefinition", property: "type" },
		},
		input("provider", "azure", { label: "Provider", group: "model" }),
		input("endpoint", "", { label: "Endpoint", group: "model" }),
	],
};
const DST = {
	...NEW,
	id: "io.example.mapdst",
	name: "Map destination",
	metadata: undefined,
	properties: [
		{
			type: "Hidden",
			value: "io.example.mapdst",
			binding: { type: "zeebe:taskDefinition", property: "type" },
		},
		input("provider", "azure", { label: "Provider", group: "model" }),
		input("url", "", { label: "URL", group: "model" }),
	],
};

/** simple.bpmn plus extra tasks, each with a shape so the modeler registers it. */
function multiTaskXml(): string {
	const tasks = ["Task_B", "Task_C", "Task_X"];
	return readFileSync(FIXTURE_BPMN, "utf-8")
		.replace(
			"</bpmn:process>",
			`${tasks.map((id) => `<bpmn:task id="${id}" />`).join("")}</bpmn:process>`,
		)
		.replace(
			"</bpmndi:BPMNPlane>",
			`${tasks
				.map(
					(id, i) =>
						`<bpmndi:BPMNShape id="${id}_di" bpmnElement="${id}"><dc:Bounds x="270" y="${200 + i * 100}" width="100" height="80" /></bpmndi:BPMNShape>`,
				)
				.join("")}</bpmndi:BPMNPlane>`,
		);
}

/** Applies each template to its element, one `apply` per element, and returns the file. */
async function seedMulti(
	name: string,
	applications: [elementId: string, template: object, values: string[]][],
): Promise<string> {
	const file = join(workDir, `${name}.bpmn`);
	writeFileSync(file, multiTaskXml());
	for (const [index, [elementId, template, values]] of applications.entries()) {
		const templatePath = join(workDir, `${name}.${index}.template.json`);
		writeFileSync(templatePath, JSON.stringify(template));
		const result = await run(
			dataDirWithCache([]),
			"apply",
			templatePath,
			elementId,
			file,
			...values.flatMap((v) => ["--set", v]),
		);
		assert.strictEqual(result.status, 0, result.stderr);
		writeFileSync(file, result.stdout);
	}
	return file;
}

function taskXml(xml: string, id: string): string {
	const match = xml.match(
		new RegExp(`<bpmn:task id="${id}"(?:[^>]*/>|[\\s\\S]*?</bpmn:task>)`),
	);
	assert.ok(match, `task ${id} not found`);
	return match[0];
}

function versionOf(xml: string, id: string): string | undefined {
	return taskXml(xml, id).match(/modelerTemplateVersion="(\d+)"/)?.[1];
}

function copyOf(file: string, name: string): { copy: string; before: string } {
	const copy = join(workDir, name);
	const before = readFileSync(file, "utf-8");
	writeFileSync(copy, before);
	return { copy, before };
}

describe("element-template update selection and write-once", () => {
	let multi: string;
	before(async () => {
		multi = await seedMulti("multi", [
			[TASK, V1, ["provider=azure", "endpoint=https://a"]],
			["Task_B", V1, ["provider=azure", "endpoint=https://b"]],
			["Task_C", V1, ["provider=azure", "endpoint=https://c"]],
		]);
	});

	test("selects every element on the template and writes the file once", async () => {
		const { copy } = copyOf(multi, "multi-all.bpmn");
		const result = await run(
			dataDirWithCache([V1, V2]),
			"update",
			V1.id,
			copy,
			"--in-place",
		);
		assert.strictEqual(result.status, 0, result.stderr);
		const xml = readFileSync(copy, "utf-8");
		for (const [id, value] of [
			[TASK, "https://a"],
			["Task_B", "https://b"],
			["Task_C", "https://c"],
		]) {
			assert.strictEqual(versionOf(xml, id), "2", id);
			assert.match(
				taskXml(xml, id),
				new RegExp(`source="${value}" target="url"`),
			);
		}
		assert.strictEqual(versionOf(xml, "Task_X"), undefined);
		assert.strictEqual(result.stdout.match(/Updated /g)?.length, 1);
		assert.match(
			result.stdout,
			/Summary: 3 updated, 0 skipped, 0 unchanged, 0 failed/,
		);
		assert.ok(!existsSync(`${copy}.migration.lock`));
	});

	test("an element id restricts the update to that element", async () => {
		const { copy } = copyOf(multi, "multi-one.bpmn");
		const result = await run(
			dataDirWithCache([V1, V2]),
			"update",
			V1.id,
			"Task_B",
			copy,
			"--in-place",
		);
		assert.strictEqual(result.status, 0, result.stderr);
		const xml = readFileSync(copy, "utf-8");
		assert.strictEqual(versionOf(xml, "Task_B"), "2");
		assert.strictEqual(versionOf(xml, TASK), "1");
		assert.strictEqual(versionOf(xml, "Task_C"), "1");
		assert.match(result.stdout, /Summary: 1 updated/);
	});

	test("fails with the template id when no element uses it", async () => {
		const { copy, before } = copyOf(multi, "multi-nomatch.bpmn");
		const result = await run(
			dataDirWithCache([V1, V2]),
			"update",
			"io.example.nope",
			copy,
			"--in-place",
		);
		assert.strictEqual(result.status, 1);
		assert.match(
			result.stderr,
			/No element in the BPMN diagram uses template 'io\.example\.nope'\./,
		);
		assert.strictEqual(readFileSync(copy, "utf-8"), before);
	});

	test("fails with the applied template when the element uses another template", async () => {
		const { copy, before } = copyOf(multi, "multi-wrong.bpmn");
		const result = await run(
			dataDirWithCache([V1, V2]),
			"update",
			OLD.id,
			"Task_B",
			copy,
			"--in-place",
		);
		assert.strictEqual(result.status, 1);
		assert.match(
			result.stderr,
			new RegExp(`Element "Task_B" uses template '${V1.id}', not '${OLD.id}'`),
		);
		assert.strictEqual(readFileSync(copy, "utf-8"), before);
	});

	test("rejects a BPMN file or a version as the first positional", async () => {
		const file = await run(dataDirWithCache([V1, V2]), "update", multi, TASK);
		assert.strictEqual(file.status, 1);
		assert.match(
			file.stderr,
			/is a BPMN file; the first argument is the applied template ID/,
		);
		const versioned = await run(
			dataDirWithCache([V1, V2]),
			"update",
			`${V1.id}@1`,
			TASK,
			multi,
		);
		assert.strictEqual(versioned.status, 1);
		assert.match(
			versioned.stderr,
			/does not take a version.*--to <template-id>@<n>/,
		);
		assert.strictEqual(versioned.stdout, "");
	});

	test("skips an element already on a higher version of the target", async () => {
		const file = await seedMulti("skipped", [
			[TASK, V1, ["provider=azure", "endpoint=https://a"]],
			["Task_B", V3, ["provider=azure", "url=https://b"]],
		]);
		const { copy } = copyOf(file, "skipped-copy.bpmn");
		const result = await run(
			dataDirWithCache([V1, V2, V3]),
			"update",
			V1.id,
			copy,
			"--to",
			`${V1.id}@2`,
			"--in-place",
			"--json",
		);
		assert.strictEqual(result.status, 0, result.stderr);
		const json = JSON.parse(result.stdout);
		const byId = Object.fromEntries(
			json.results.map((r: { elementId: string }) => [r.elementId, r]),
		);
		assert.strictEqual(byId[TASK].status, "updated");
		assert.deepStrictEqual(byId.Task_B, {
			status: "skipped",
			elementId: "Task_B",
			from: { id: V1.id, version: 3 },
			to: { id: V1.id, version: 2 },
		});
		assert.deepStrictEqual(json.summary, {
			updated: 1,
			skipped: 1,
			unchanged: 0,
			failed: 0,
			dropped: 0,
			blocked: 0,
		});
		const xml = readFileSync(copy, "utf-8");
		assert.strictEqual(versionOf(xml, TASK), "2");
		assert.strictEqual(versionOf(xml, "Task_B"), "3");
		const text = await run(
			dataDirWithCache([V1, V2, V3]),
			"update",
			V1.id,
			file,
			"--to",
			`${V1.id}@2`,
			"--dry-run",
		);
		assert.strictEqual(text.status, 0, text.stderr);
		assert.match(text.stdout, /Task_B is on v3, newer than v2; skipped/);
	});

	test("a failing element leaves the file byte-identical and exits 1 with the report", async () => {
		const v2Intermediate = { ...V2, engines: { camunda: ">=99" } };
		const v3 = {
			...V3,
			metadata: {
				migratesFrom: {
					schemaVersion: 1,
					sources: [
						{
							kind: "upgrade",
							sourceTemplateId: V1.id,
							toVersion: 2,
							paths: [{ from: "endpoint", to: "url" }],
						},
						{
							kind: "upgrade",
							sourceTemplateId: V1.id,
							toVersion: 3,
							paths: [],
						},
					],
				},
			},
		};
		const file = await seedMulti("partial", [
			[TASK, V1, ["provider=azure", "endpoint=https://a"]],
			["Task_B", V2, ["provider=azure", "url=https://b"]],
		]);
		const cache = [V1, v2Intermediate, v3];
		const { copy, before } = copyOf(file, "partial-copy.bpmn");
		const text = await run(
			dataDirWithCache(cache),
			"update",
			V1.id,
			copy,
			"--in-place",
			"--allow-lossy",
		);
		assert.strictEqual(text.status, 1, text.stderr);
		assert.match(text.stderr, /Cannot migrate .*version 2 is not available/);
		assert.match(
			text.stdout,
			/Summary: 1 updated, 0 skipped, 0 unchanged, 1 failed/,
		);
		assert.match(text.stderr, /Nothing was written/);
		assert.strictEqual(readFileSync(copy, "utf-8"), before);
		assert.ok(!existsSync(`${copy}.migration.lock`));

		const json = await run(
			dataDirWithCache(cache),
			"update",
			V1.id,
			copy,
			"--in-place",
			"--allow-lossy",
			"--json",
		);
		assert.strictEqual(json.status, 1, json.stderr);
		const document = JSON.parse(json.stdout);
		assert.deepStrictEqual(
			document.results.map((r: { status: string }) => r.status).sort(),
			["failed", "updated"],
		);
		const failed = document.results.find(
			(r: { status: string }) => r.status === "failed",
		);
		assert.match(failed.error, /version 2 is not available/);
		assert.strictEqual(document.summary.failed, 1);
		assert.strictEqual(readFileSync(copy, "utf-8"), before);

		const stdoutRun = await run(dataDirWithCache(cache), "update", V1.id, copy);
		assert.strictEqual(stdoutRun.status, 1, stdoutRun.stderr);
		assert.strictEqual(stdoutRun.stdout, "");
		assert.match(stdoutRun.stderr, /Nothing was written/);
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

	test("warns on stderr that --map was not applied to an element already on the target", async () => {
		const file = await seedMulti("noop-map", [
			[TASK, V2, ["provider=azure", "url=https://a"]],
		]);
		const before = readFileSync(file, "utf-8");
		const result = await run(
			dataDirWithCache([V1, V2]),
			"update",
			V1.id,
			file,
			"--map",
			"provider=url",
			"--in-place",
		);
		assert.strictEqual(result.status, 0, result.stderr);
		assert.match(
			result.stderr,
			new RegExp(
				`Warning: ${TASK} is already on the target template, so --map was not applied`,
			),
		);
		assert.doesNotMatch(result.stdout, /Warning/);
		assert.strictEqual(readFileSync(file, "utf-8"), before);
	});

	test("--json prints one document with dryRun, command, results and summary", async () => {
		const result = await run(
			dataDirWithCache([V1, V2]),
			"update",
			V1.id,
			multi,
			"--dry-run",
			"--json",
		);
		assert.strictEqual(result.status, 0, result.stderr);
		const json = JSON.parse(result.stdout);
		assert.deepStrictEqual(Object.keys(json).sort(), [
			"command",
			"dryRun",
			"results",
			"summary",
		]);
		assert.strictEqual(json.dryRun, true);
		assert.strictEqual(json.command, "element-template update");
		assert.deepStrictEqual(
			json.results.map((r: { elementId: string }) => r.elementId).sort(),
			[TASK, "Task_B", "Task_C"].sort(),
		);
		for (const entry of json.results) {
			assert.strictEqual(entry.status, "updated");
			assert.strictEqual(entry.action, undefined);
			assert.strictEqual(entry.lossless, true);
			assert.strictEqual(entry.requiresAuthorization, false);
			assert.strictEqual(entry.authorized, false);
		}
		assert.deepStrictEqual(json.summary, {
			updated: 3,
			skipped: 0,
			unchanged: 0,
			failed: 0,
			dropped: 0,
			blocked: 0,
		});
	});
});

describe("element-template update --map", () => {
	let multi: string;
	before(async () => {
		multi = await seedMulti("mapped", [
			[TASK, SRC, ["provider=azure", "endpoint=https://a"]],
			["Task_B", SRC, ["provider=azure", "endpoint=https://b"]],
		]);
	});
	const cache = () => dataDirWithCache([SRC, DST]);

	test("without --map the renamed value is dropped and a dry run is blocked", async () => {
		const result = await run(
			cache(),
			"update",
			SRC.id,
			multi,
			"--to",
			DST.id,
			"--dry-run",
			"--json",
		);
		assert.strictEqual(result.status, 1, result.stderr);
		const json = JSON.parse(result.stdout);
		assert.strictEqual(json.summary.dropped, 2);
		assert.strictEqual(json.summary.blocked, 2);
	});

	test("moves each element's own value, is lossless and needs no --allow-lossy", async () => {
		const dry = await run(
			cache(),
			"update",
			SRC.id,
			multi,
			"--to",
			DST.id,
			"--map",
			"endpoint=url",
			"--dry-run",
			"--json",
		);
		assert.strictEqual(dry.status, 0, dry.stderr);
		const json = JSON.parse(dry.stdout);
		for (const entry of json.results) {
			assert.strictEqual(entry.lossless, true);
			assert.strictEqual(entry.requiresAuthorization, false);
		}
		assert.strictEqual(json.summary.dropped, 0);
		assert.strictEqual(json.summary.blocked, 0);

		const { copy } = copyOf(multi, "mapped-copy.bpmn");
		const result = await run(
			cache(),
			"update",
			SRC.id,
			copy,
			"--to",
			DST.id,
			"--map",
			"endpoint=url",
			"--in-place",
		);
		assert.strictEqual(result.status, 0, result.stderr);
		const xml = readFileSync(copy, "utf-8");
		assert.match(taskXml(xml, TASK), /source="https:\/\/a" target="url"/);
		assert.doesNotMatch(taskXml(xml, TASK), /https:\/\/b/);
		assert.match(taskXml(xml, "Task_B"), /source="https:\/\/b" target="url"/);
		assert.doesNotMatch(taskXml(xml, "Task_B"), /https:\/\/a/);
		assert.match(taskXml(xml, TASK), new RegExp(`modelerTemplate="${DST.id}"`));
	});

	test("accepts a binding-type prefix on both sides", async () => {
		const result = await run(
			cache(),
			"update",
			SRC.id,
			multi,
			"--to",
			DST.id,
			"--map",
			"input:endpoint=input:url",
			"--dry-run",
			"--json",
		);
		assert.strictEqual(result.status, 0, result.stderr);
		assert.strictEqual(JSON.parse(result.stdout).summary.dropped, 0);
	});

	test("fails before writing when a name is not bound by the templates", async () => {
		for (const map of ["nope=url", "endpoint=nope"]) {
			const { copy, before } = copyOf(multi, "mapped-bad.bpmn");
			const result = await run(
				cache(),
				"update",
				SRC.id,
				copy,
				"--to",
				DST.id,
				"--map",
				map,
				"--in-place",
				"--allow-lossy",
			);
			assert.strictEqual(result.status, 1, result.stderr);
			assert.match(
				result.stderr,
				/not (a|an?) .*binding|not a settable binding/,
			);
			assert.match(result.stderr, /nope/);
			assert.strictEqual(readFileSync(copy, "utf-8"), before);
		}
	});

	test("rejects a malformed --map", async () => {
		const result = await run(
			cache(),
			"update",
			SRC.id,
			multi,
			"--to",
			DST.id,
			"--map",
			"endpoint",
			"--dry-run",
		);
		assert.strictEqual(result.status, 1);
		assert.match(result.stderr, /Invalid --map format/);
	});
});

// Registered last so a leftover temp dir fails as a test, which also surfaces
// under --experimental-test-isolation=none.
test("removes every temp dir it created", () => {
	removeCleanups();
	for (const dir of cleanups) {
		assert.strictEqual(existsSync(dir), false, `temp dir left behind: ${dir}`);
	}
});
