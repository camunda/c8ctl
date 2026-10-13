/**
 * Bindings the migration engine cannot read: a value the target does not
 * keep counts as a loss (default-plugins/element-template/migration/report.ts)
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { c8WithOptions } from "../utils/cli.ts";
import { DIAGRAM, seedTemplateCache } from "../utils/element-template.ts";

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
