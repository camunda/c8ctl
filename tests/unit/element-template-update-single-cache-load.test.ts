/**
 * UPD-002: the template cache is loaded once per run
 * (default-plugins/element-template/commands/migrate.ts)
 */

import assert from "node:assert/strict";
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
import { after, before, describe, test } from "node:test";
import { pathToFileURL } from "node:url";
import { c8WithOptions } from "../utils/cli.ts";
import {
	labelledInput as input,
	seedTemplateCache,
} from "../utils/element-template.ts";

const TASK = "Activity_17s7axj";
const FIXTURE = resolve(import.meta.dirname, "../fixtures/simple.bpmn");
const PRELOAD = resolve(
	import.meta.dirname,
	"../fixtures/count-cache-reads.mjs",
);
const SOURCE = {
	id: "io.example.single-load.source",
	name: "Source",
	version: 1,
	appliesTo: ["bpmn:Task"],
	engines: { camunda: "^8.8" },
	properties: [input("a", "kept")],
};
const UPGRADE = { ...SOURCE, version: 2, name: "Upgrade" };
const SCHEMA =
	"https://unpkg.com/@camunda/zeebe-element-templates-json-schema/resources/schema.json";
const NEXT = {
	...SOURCE,
	id: "io.example.single-load.next",
	name: "Next",
	metadata: {
		migratesFrom: {
			schemaVersion: 1,
			sources: [
				{
					kind: "change",
					sourceTemplateId: SOURCE.id,
					paths: [{ from: "input:a", to: "input:a" }],
				},
			],
		},
	},
};

let dir: string;
let dataDir: string;
let bpmn: string;
let readLog: string;
let localBpmn: string;
let nextPath: string;

async function run(...args: string[]) {
	rmSync(readLog, { force: true });
	const result = await c8WithOptions(
		{
			nodeArgs: ["--import", pathToFileURL(PRELOAD).href],
			env: {
				C8CTL_DATA_DIR: dataDir,
				C8CTL_OUTPUT_MODE: "text",
				CACHE_READ_LOG: readLog,
				C8CTL_MODELER_DIR: join(dir, "modeler"),
				HOME: dir,
			},
			timeout: 30_000,
		},
		"element-template",
		...args,
	);
	const reads = existsSync(readLog) ? readFileSync(readLog).length : 0;
	return { ...result, reads };
}

before(async () => {
	dir = mkdtempSync(join(tmpdir(), "c8ctl-single-cache-load-"));
	dataDir = join(dir, "data");
	readLog = join(dir, "reads.log");
	seedTemplateCache(dataDir, [SOURCE, UPGRADE, NEXT]);
	const sourcePath = join(dir, "source.json");
	writeFileSync(sourcePath, JSON.stringify(SOURCE));
	const seeded = await run("apply", sourcePath, TASK, FIXTURE);
	assert.equal(seeded.status, 0, seeded.stderr);
	bpmn = join(dir, "diagram.bpmn");
	writeFileSync(bpmn, seeded.stdout);
	// A project whose templates are all local; local templates need `$schema`.
	const project = join(dir, "project");
	const localDir = join(project, ".camunda", "element-templates");
	mkdirSync(localDir, { recursive: true });
	writeFileSync(
		join(localDir, "local.json"),
		JSON.stringify([SOURCE, UPGRADE].map((t) => ({ $schema: SCHEMA, ...t }))),
	);
	localBpmn = join(project, "diagram.bpmn");
	writeFileSync(localBpmn, seeded.stdout);
	nextPath = join(project, "next.json");
	writeFileSync(nextPath, JSON.stringify({ $schema: SCHEMA, ...NEXT }));
});

after(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("migrate loads the template cache once per run", () => {
	const cases: [string, () => string[]][] = [
		["update", () => ["update", SOURCE.id, TASK, bpmn, "--dry-run"]],
		[
			"update --to <id>",
			() => ["update", SOURCE.id, TASK, bpmn, "--to", NEXT.id, "--dry-run"],
		],
	];
	for (const [name, args] of cases) {
		test(`${name} reads templates.json exactly once`, async () => {
			const result = await run(...args());
			assert.equal(result.status, 0, result.stderr);
			assert.equal(result.reads, 1);
		});
	}
});

describe("a run on local templates does not read templates.json", () => {
	const cases: [string, () => string[]][] = [
		["update", () => []],
		["update --to <file of another id>", () => ["--to", nextPath]],
	];
	for (const [name, extra] of cases) {
		test(name, async () => {
			const result = await run(
				"update",
				SOURCE.id,
				TASK,
				localBpmn,
				"--dry-run",
				...extra(),
			);
			assert.equal(result.status, 0, result.stderr);
			assert.match(result.stdout, /updated/);
			assert.equal(result.reads, 0);
		});
	}
});
