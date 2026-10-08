/**
 * Behavioural tests for `element-template update` and `element-template change`
 * (default-plugins/element-template/commands/migrate.ts)
 */

import assert from "node:assert";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { before, describe, test } from "node:test";
import { asyncSpawn } from "../utils/spawn.ts";

const CLI = "src/index.ts";
const FIXTURE_BPMN = join(
	resolve(import.meta.dirname, "..", "fixtures"),
	"simple.bpmn",
);
const TASK = "Activity_17s7axj";

function input(name: string, value: string, label: string) {
	return {
		type: "String",
		value,
		label,
		group: "model",
		binding: { type: "zeebe:input", name },
	};
}

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
		input("provider", "azure", "Provider"),
		input("endpoint", "", "Endpoint"),
		input("maxTokens", "", "Maximum tokens"),
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
		input("backend.provider", "", "Provider"),
		input("backend.endpoint", "", "API endpoint"),
		input("backend.type", "", "Backend"),
		input("effort", "default", "Effort"),
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
		input("provider", "azure", "Provider"),
		input("url", "", "URL"),
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
		input("provider", "azure", "Provider"),
		input("endpoint", "", "Endpoint"),
	],
};

let workDir: string;
let oldBpmn: string;
let versionedBpmn: string;
const cleanups: string[] = [];

function dataDirWithCache(templates: object[]): string {
	const dataDir = mkdtempSync(join(tmpdir(), "c8ctl-migrate-data-"));
	cleanups.push(dataDir);
	const cacheDir = join(dataDir, "element-templates");
	mkdirSync(cacheDir, { recursive: true });
	writeFileSync(join(cacheDir, "templates.json"), JSON.stringify(templates));
	writeFileSync(join(cacheDir, "fetched-at"), String(Date.now()));
	return dataDir;
}

async function run(dataDir: string, ...args: string[]) {
	return asyncSpawn(
		"node",
		["--experimental-strip-types", CLI, "element-template", ...args],
		{
			env: {
				...process.env,
				CAMUNDA_BASE_URL: "http://test-cluster/v2",
				HOME: "/tmp/c8ctl-test-nonexistent-home",
				C8CTL_DATA_DIR: dataDir,
				NO_COLOR: "1",
			},
		},
	);
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

process.on("exit", () => {
	for (const dir of cleanups) {
		rmSync(dir, { recursive: true, force: true });
	}
});

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
					["update", TASK, versionedBpmn],
					["change", `${V2.id}@2`, TASK, versionedBpmn],
					["change", V2.id, TASK, versionedBpmn],
				],
			],
			[successor, [["change", "--successor", TASK, versionedBpmn]]],
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
					"--json",
				);
				assert.strictEqual(result.status, 0, result.stderr);
				assert.strictEqual(result.stderr, "");
				assert.strictEqual(JSON.parse(result.stdout).to.id, target.id);
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
				["update", TASK, file],
				["change", `${V2.id}@2`, TASK, file],
				["change", "--successor", TASK, file],
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
				[[V1, V2], ["update", TASK, file], 2],
				[[V1, V2], ["change", `${V2.id}@2`, TASK, file], 2],
				[[V1, V2], ["change", V2.id, TASK, file], 2],
				[[V1, NEW], ["change", "--successor", TASK, file], 1],
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
				["update", TASK, file],
				["change", `${V2.id}@2`, TASK, file],
				["change", "--successor", TASK, file],
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
				["update", TASK, file],
				["change", `${V2.id}@2`, TASK, file],
				["change", "--successor", TASK, file],
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
			for (const args of [
				["update", TASK, "--to-version", "2"],
				["change", `${V2.id}@2`, TASK],
				["change", templatePath, TASK],
			]) {
				const file = join(workDir, `engine-target-${name}.bpmn`);
				const xml = readFileSync(versionedBpmn, "utf-8");
				writeFileSync(file, xml);
				const result = await run(
					dataDirWithCache([V1, target]),
					...args,
					file,
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
			const discovered = await run(
				cache,
				"change",
				"--successor",
				TASK,
				oldBpmn,
			);
			assert.strictEqual(discovered.status, 1, discovered.stderr);
			assert.match(discovered.stderr, /No template declares a migration/);
			assert.strictEqual(discovered.stdout, "");
			const update = await run(
				dataDirWithCache([V1, { ...V2, engines }]),
				"update",
				TASK,
				versionedBpmn,
			);
			assert.strictEqual(update.status, 0, update.stderr);
			assert.strictEqual(update.stdout, readFileSync(versionedBpmn, "utf-8"));
			const unpinned = await run(
				dataDirWithCache([V1, { ...V2, engines }]),
				"change",
				V2.id,
				TASK,
				versionedBpmn,
			);
			assert.strictEqual(unpinned.status, 0, unpinned.stderr);
			assert.strictEqual(unpinned.stdout, readFileSync(versionedBpmn, "utf-8"));
			const chosen = await run(
				dataDirWithCache([OLD, NEW, { ...NEW, version: 2, engines }]),
				"change",
				"--successor",
				TASK,
				oldBpmn,
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
				"change",
				`${NEW.id}@1`,
				TASK,
				file,
				"--in-place",
				"--allow-lossy",
			);
			assert.strictEqual(result.status, 1, result.stderr);
			assert.match(result.stderr, /version 2 is not available/);
			assert.strictEqual(result.stdout, "");
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
			TASK,
			file,
			"--to-version",
			"2",
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
			["update", TASK, file],
			["change", V2.id, TASK, file],
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
			for (const args of [
				["update", TASK, file],
				["change", `${NEW.id}@1`, TASK, file],
				["change", NEW.id, TASK, file],
				["change", "--successor", TASK, file],
			]) {
				const result = await run(cache, ...args);
				assert.strictEqual(result.status, 0, result.stderr);
				assert.match(
					result.stdout,
					args[0] === "update"
						? /modelerTemplateVersion="2"/
						: /modelerTemplate="io\.example\.new"/,
				);
			}
		}
	});
});

describe("element-template change", () => {
	test("lossy in-place migration requires authorization and preserves the original on refusal", async () => {
		const copy = join(workDir, "lossy-refused.bpmn");
		const before = readFileSync(oldBpmn, "utf-8");
		writeFileSync(copy, before);
		const templatePath = join(workDir, "lossy-target.json");
		writeFileSync(templatePath, JSON.stringify(NEW));
		const result = await run(
			dataDirWithCache([OLD]),
			"change",
			templatePath,
			TASK,
			copy,
			"--in-place",
		);
		assert.notStrictEqual(result.status, 0);
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
			"change",
			templatePath,
			TASK,
			oldBpmn,
			"--recipe",
			recipePath,
			"--allow-lossy",
		);
		assert.notStrictEqual(result.status, 0);
		assert.match(result.stderr, /source|applicable/);
	});
	test("rejects engine-incompatible explicit targets and successor candidates", async () => {
		const incompatible = { ...NEW, engines: { camunda: ">=99.0.0" } };
		const templatePath = join(workDir, "incompatible.json");
		writeFileSync(templatePath, JSON.stringify(incompatible));
		for (const args of [
			["change", templatePath, TASK, oldBpmn],
			["change", "--successor", TASK, oldBpmn],
		]) {
			const result = await run(dataDirWithCache([OLD, incompatible]), ...args);
			assert.notStrictEqual(result.status, 0, result.stdout);
			assert.match(result.stderr, /compatible|migration/);
		}
	});
	test("explicit target content wins over a conflicting cached identity", async () => {
		const templatePath = join(workDir, "authoritative.json");
		writeFileSync(templatePath, JSON.stringify(NEW));
		const stale = { ...NEW, properties: [input("stale", "STALE", "Stale")] };
		const result = await run(
			dataDirWithCache([OLD, stale]),
			"change",
			templatePath,
			TASK,
			oldBpmn,
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
			"change",
			templatePath,
			TASK,
			oldBpmn,
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
		assert.doesNotMatch(result.stdout, /Dropped/);
	});

	test("writes the file with --in-place and reports on stdout", async () => {
		const copy = join(workDir, "inplace.bpmn");
		writeFileSync(copy, readFileSync(oldBpmn));
		const templatePath = join(workDir, "new.json");
		writeFileSync(templatePath, JSON.stringify(NEW));
		const result = await run(
			dataDirWithCache([OLD]),
			"change",
			templatePath,
			TASK,
			copy,
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
			"change",
			templatePath,
			TASK,
			oldBpmn,
			"--dry-run",
		);
		assert.strictEqual(result.status, 0, result.stderr);
		assert.match(result.stdout, /Dry run: nothing was written/);
		assert.doesNotMatch(result.stdout, /<bpmn:definitions/);
		assert.strictEqual(readFileSync(oldBpmn, "utf-8"), before);
	});

	test("--json --dry-run emits the report as JSON", async () => {
		const templatePath = join(workDir, "new.json");
		writeFileSync(templatePath, JSON.stringify(NEW));
		const result = await run(
			dataDirWithCache([OLD]),
			"change",
			templatePath,
			TASK,
			oldBpmn,
			"--dry-run",
			"--json",
		);
		assert.strictEqual(result.status, 0, result.stderr);
		const json = JSON.parse(result.stdout);
		assert.strictEqual(json.action, "change");
		assert.strictEqual(json.recipe.source, "embedded");
		assert.strictEqual(json.lossless, false);
		assert.strictEqual(json.report.dropped[0].value, "2000");
		assert.strictEqual(json.report.moved.length, 2);
	});

	test("--json without --in-place or --dry-run is refused", async () => {
		const templatePath = join(workDir, "new.json");
		writeFileSync(templatePath, JSON.stringify(NEW));
		const result = await run(
			dataDirWithCache([OLD]),
			"change",
			templatePath,
			TASK,
			oldBpmn,
			"--json",
		);
		assert.notStrictEqual(result.status, 0);
		assert.match(
			result.stderr + result.stdout,
			/--json needs --in-place or --dry-run/,
		);
	});

	test("--successor picks the template that declares a migration", async () => {
		const result = await run(
			dataDirWithCache([OLD, NEW]),
			"change",
			"--successor",
			TASK,
			oldBpmn,
		);
		assert.strictEqual(result.status, 0, result.stderr);
		assert.match(result.stdout, /modelerTemplate="io.example.new"/);
	});

	test("--successor fails when no template declares a migration", async () => {
		const result = await run(
			dataDirWithCache([OLD]),
			"change",
			"--successor",
			TASK,
			oldBpmn,
		);
		assert.notStrictEqual(result.status, 0);
		assert.match(
			result.stderr + result.stdout,
			/No template declares a migration from 'io.example.old'/,
		);
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
			"change",
			templatePath,
			TASK,
			oldBpmn,
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
			"change",
			templatePath,
			TASK,
			oldBpmn,
			"--recipe",
			recipePath,
		);
		assert.notStrictEqual(result.status, 0);
		assert.match(result.stderr + result.stdout, /Update c8ctl/);
	});

	test("fails for an element without a template and for unknown elements", async () => {
		const templatePath = join(workDir, "new.json");
		writeFileSync(templatePath, JSON.stringify(NEW));
		const noTemplate = await run(
			dataDirWithCache([OLD]),
			"change",
			templatePath,
			TASK,
			FIXTURE_BPMN,
		);
		assert.notStrictEqual(noTemplate.status, 0);
		assert.match(
			noTemplate.stderr + noTemplate.stdout,
			/no element template applied/,
		);
		const unknown = await run(
			dataDirWithCache([OLD]),
			"change",
			templatePath,
			"Nope",
			oldBpmn,
		);
		assert.notStrictEqual(unknown.status, 0);
		assert.match(unknown.stderr + unknown.stdout, /Element "Nope" not found/);
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
			TASK,
			versionedBpmn,
			"--recipe",
			recipePath,
		);
		assert.notStrictEqual(result.status, 0);
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
			TASK,
			file,
			"--in-place",
		);
		assert.notStrictEqual(result.status, 0);
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
			TASK,
			missingEngine,
		);
		assert.notStrictEqual(missing.status, 0);
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
		const result = await run(
			dataDirWithCache([V1, { ...V2, engines: { camunda: ">=99" } }, v3]),
			"update",
			TASK,
			versionedBpmn,
			"--in-place",
		);
		assert.notStrictEqual(result.status, 0);
		assert.match(result.stderr, /version 2 is not available/);
	});
	test("moves to the newest version and applies its recipe", async () => {
		const result = await run(
			dataDirWithCache([V1, V2]),
			"update",
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
			TASK,
			versionedBpmn,
		);
		assert.strictEqual(result.status, 0, result.stderr);
		assert.strictEqual(result.stdout, readFileSync(versionedBpmn, "utf-8"));
		assert.match(result.stderr, /already on/);
	});
	test("JSON no-ops preserve the report envelope for update and change", async () => {
		const templatePath = join(workDir, "same.json");
		writeFileSync(templatePath, JSON.stringify(V1));
		for (const args of [
			["update", TASK, versionedBpmn],
			["change", templatePath, TASK, versionedBpmn],
		]) {
			const result = await run(
				dataDirWithCache([V1]),
				...args,
				"--dry-run",
				"--json",
			);
			assert.strictEqual(result.status, 0, result.stderr);
			const json = JSON.parse(result.stdout);
			assert.strictEqual(json.noop, true);
			assert.strictEqual(json.lossless, true);
			assert.deepStrictEqual(json.report.moved, []);
			assert.strictEqual(result.stderr, "");
		}
	});

	test("--to-version pins a version and refuses a missing one", async () => {
		const missing = await run(
			dataDirWithCache([V1, V2]),
			"update",
			TASK,
			versionedBpmn,
			"--to-version",
			"7",
		);
		assert.notStrictEqual(missing.status, 0);
		assert.match(missing.stderr + missing.stdout, /has no version 7/);
	});

	test("needs the template in the cache", async () => {
		const result = await run(
			dataDirWithCache([NEW]),
			"update",
			TASK,
			versionedBpmn,
		);
		assert.notStrictEqual(result.status, 0);
		assert.match(result.stderr + result.stdout, /not in the local cache/);
	});

	test("rejects --successor on update", async () => {
		const successor = await run(
			dataDirWithCache([V1, V2]),
			"update",
			"--successor",
			TASK,
			versionedBpmn,
		);
		assert.notStrictEqual(successor.status, 0);
		assert.match(
			successor.stderr + successor.stdout,
			/--successor is only valid for change/,
		);
	});
});

test("migrate tests leave no temp data behind", () => {
	assert.ok(existsSync(workDir));
});
