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
	assert.match(result.stderr, /\n {2}Dropped\n/);
	assert.match(result.stderr, /Model › Maximum tokens {2}2000/);
	assert.match(result.stderr, /> API endpoint +https:\/\/x +was Endpoint/);
	assert.match(result.stderr, /Backend chosen for you/);
	assert.match(result.stderr, /1 element updated\. BPMN written to stdout\./);
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
	assert.match(result.stdout, /\n {2}Dropped\n/);
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
	assert.match(result.stdout, /\n {2}Dropped\n/);
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
		"deprecation",
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

test("--json names the element, the recipe file as given and the deprecated selector", async () => {
	const recipePath = join(ws.workDir, "old-to-new.recipe.json");
	writeFileSync(recipePath, JSON.stringify(NEW.metadata.migratesFrom));
	const result = await run(
		dataDirWithCache([OLD, NEW]),
		"update",
		OLD.id,
		TASK,
		ws.oldBpmn,
		"--to",
		NEW.id,
		"--recipe",
		recipePath,
		"--dry-run",
		"--allow-lossy",
		"--json",
	);
	assert.strictEqual(result.status, 0, result.stderr);
	const json = JSON.parse(result.stdout);
	const [entry] = json.results;
	assert.strictEqual(entry.elementName, "Do Something");
	assert.deepStrictEqual(entry.recipe, {
		source: "file",
		path: recipePath,
		used: true,
		refusal: null,
	});
	assert.deepStrictEqual(json.deprecation, {
		templateId: OLD.id,
		successors: [NEW.id],
	});
	assert.deepStrictEqual(
		entry.report.moved.map((m: { source: string; value: string }) => [
			m.source,
			m.value,
		]),
		[
			["recipe", "azure"],
			["recipe", "https://x"],
		],
	);
	assert.strictEqual(entry.counts.moved, 2);
});

test("--json names the successors of a deprecated selector without --to", async () => {
	const result = await run(
		dataDirWithCache([OLD, NEW]),
		"update",
		OLD.id,
		TASK,
		ws.oldBpmn,
		"--dry-run",
		"--json",
	);
	assert.strictEqual(result.status, 0, result.stderr);
	const json = JSON.parse(result.stdout);
	assert.strictEqual(json.results[0].status, "unchanged");
	assert.deepStrictEqual(json.deprecation, {
		templateId: OLD.id,
		successors: [NEW.id],
	});
});

test("--json reports deprecation as null for a current template", async () => {
	const result = await run(
		dataDirWithCache([V1, V2]),
		"update",
		V1.id,
		multi,
		"--dry-run",
		"--json",
	);
	assert.strictEqual(JSON.parse(result.stdout).deprecation, null);
});

test("a carry-over failure without a recipe names --recipe and --map as next steps", async () => {
	const strict = {
		...NEW,
		id: "io.example.strict",
		metadata: undefined,
		properties: [
			...NEW.properties.slice(0, 1),
			{
				type: "Dropdown",
				value: "openai",
				label: "Provider",
				group: "model",
				choices: [{ name: "OpenAI", value: "openai" }],
				binding: { type: "zeebe:input", name: "provider" },
			},
		],
	};
	const templatePath = join(ws.workDir, "strict.json");
	writeFileSync(templatePath, JSON.stringify(strict));
	const args = [
		"update",
		OLD.id,
		TASK,
		ws.oldBpmn,
		"--to",
		templatePath,
		"--dry-run",
	];
	const json = await run(dataDirWithCache([OLD]), ...args, "--json");
	assert.strictEqual(json.status, 1);
	const [entry] = JSON.parse(json.stdout).results;
	assert.strictEqual(entry.status, "failed");
	assert.strictEqual(entry.elementName, "Do Something");
	assert.match(entry.error, /carry-over: destination "input:provider"/);
	assert.match(entry.hint, /--recipe <file>/);
	assert.match(entry.hint, /--map <from>=<to>/);
	const text = await run(dataDirWithCache([OLD]), ...args);
	assert.strictEqual(text.status, 1);
	assert.ok(text.stderr.includes(entry.hint), text.stderr);
	assert.match(
		text.stderr,
		/Nothing was written because an element failed\.\n$/,
	);
});

test("removes every temp dir it created", assertCleanedUp);
