/**
 * UPD-006: report channels, dry run and JSON
 * (default-plugins/element-template/commands/migrate.ts)
 */

import assert from "node:assert";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
	createUpdateWorkspace,
	NEW,
	OLD,
	TASK,
	V1,
	V2,
} from "../utils/update-workspace.ts";

const w = createUpdateWorkspace();
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

let multi: string;
before(async () => {
	multi = await seedMulti("multi", [
		[TASK, V1, ["provider=azure", "endpoint=https://a"]],
		["Task_B", V1, ["provider=azure", "endpoint=https://b"]],
		["Task_C", V1, ["provider=azure", "endpoint=https://c"]],
	]);
});

test("migrates to a template file, printing the BPMN and a report on stderr", async () => {
	const templatePath = join(ws.workDir, "new.json");
	writeFileSync(templatePath, JSON.stringify(NEW));
	const result = await run(
		dataDirWithCache([OLD]),
		"update",
		OLD.id,
		TASK,
		ws.oldBpmn,
		"--to",
		templatePath,
	);
	assert.strictEqual(result.status, 0, result.stderr);
	assert.match(result.stdout, /modelerTemplate="io.example.new"/);
	assert.match(result.stdout, /source="https:\/\/x" target="backend.endpoint"/);
	assert.match(result.stdout, /source="foundry" target="backend.type"/);
	assert.match(result.stderr, /Dropped \(1\)/);
	assert.match(result.stderr, /Model › Maximum tokens {2}2000/);
	assert.match(result.stderr, /Moved \(2\)/);
	assert.match(result.stderr, /Backend chosen for you/);
	assert.match(result.stderr, /Summary: 1 updated, 0 skipped/);
	assert.doesNotMatch(result.stdout, /Dropped/);
});

test("writes the file with --in-place and reports on stdout", async () => {
	const copy = join(ws.workDir, "inplace.bpmn");
	writeFileSync(copy, readFileSync(ws.oldBpmn));
	const templatePath = join(ws.workDir, "new.json");
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
	assert.match(readFileSync(copy, "utf-8"), /modelerTemplate="io.example.new"/);
	assert.match(result.stdout, /Dropped \(1\)/);
	assert.match(result.stdout, /Updated /);
});

test("--dry-run previews the report and leaves the file alone", async () => {
	const templatePath = join(ws.workDir, "new.json");
	writeFileSync(templatePath, JSON.stringify(NEW));
	const before = readFileSync(ws.oldBpmn, "utf-8");
	const result = await run(
		dataDirWithCache([OLD]),
		"update",
		OLD.id,
		TASK,
		ws.oldBpmn,
		"--to",
		templatePath,
		"--dry-run",
		"--allow-lossy",
	);
	assert.strictEqual(result.status, 0, result.stderr);
	assert.match(result.stdout, /Dry run: nothing was written/);
	assert.doesNotMatch(result.stdout, /<bpmn:definitions/);
	assert.strictEqual(readFileSync(ws.oldBpmn, "utf-8"), before);
});

test("a lossy --dry-run without --allow-lossy exits 1 and still prints the report", async () => {
	const templatePath = join(ws.workDir, "new.json");
	writeFileSync(templatePath, JSON.stringify(NEW));
	const before = readFileSync(ws.oldBpmn, "utf-8");
	const result = await run(
		dataDirWithCache([OLD]),
		"update",
		OLD.id,
		TASK,
		ws.oldBpmn,
		"--to",
		templatePath,
		"--dry-run",
	);
	assert.strictEqual(result.status, 1, result.stderr);
	assert.match(result.stdout, /Dropped \(1\)/);
	assert.match(result.stdout, /A write would be blocked/);
	assert.strictEqual(readFileSync(ws.oldBpmn, "utf-8"), before);
});

test("--dry-run does not serialize the diagram", async () => {
	const templatePath = join(ws.workDir, "new.json");
	writeFileSync(templatePath, JSON.stringify(NEW));
	const result = await runWithPreload(
		dataDirWithCache([OLD]),
		failingSaveXmlPreload(),
		[
			"update",
			OLD.id,
			TASK,
			ws.oldBpmn,
			"--to",
			templatePath,
			"--dry-run",
			"--allow-lossy",
		],
	);
	assert.strictEqual(result.status, 0, result.stderr);
	assert.match(result.stdout, /Dry run: nothing was written/);
});

test("--json --dry-run emits the report as one JSON document", async () => {
	const templatePath = join(ws.workDir, "new.json");
	writeFileSync(templatePath, JSON.stringify(NEW));
	const result = await run(
		dataDirWithCache([OLD]),
		"update",
		OLD.id,
		TASK,
		ws.oldBpmn,
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
	const templatePath = join(ws.workDir, "new.json");
	writeFileSync(templatePath, JSON.stringify(NEW));
	const result = await run(
		dataDirWithCache([OLD]),
		"update",
		OLD.id,
		TASK,
		ws.oldBpmn,
		"--to",
		templatePath,
		"--json",
	);
	assert.strictEqual(result.status, 1);
	assert.match(result.stderr, /--json needs --in-place or --dry-run/);
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

test("removes every temp dir it created", assertCleanedUp);
