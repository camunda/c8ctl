/**
 * UPD-002: the template cache is loaded once per run
 * (default-plugins/element-template/commands/migrate.ts)
 */

import assert from "node:assert/strict";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
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

async function run(...args: string[]) {
	rmSync(readLog, { force: true });
	const result = await c8WithOptions(
		{
			nodeArgs: ["--import", PRELOAD],
			env: {
				C8CTL_DATA_DIR: dataDir,
				C8CTL_OUTPUT_MODE: "text",
				CACHE_READ_LOG: readLog,
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
