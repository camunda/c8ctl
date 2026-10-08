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

describe("element-template change", () => {
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
		assert.match(result.stdout + result.stderr, /already on/);
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
