/**
 * UPD-001, UPD-002: select elements and resolve the target
 * (default-plugins/element-template/commands/migrate.ts)
 */

import assert from "node:assert";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
	createUpdateWorkspace,
	FIXTURE_BPMN,
	NEW,
	OLD,
	TASK,
	V1,
	V2,
	V3,
	versionOf,
} from "../utils/update-workspace.ts";

const w = createUpdateWorkspace();
const { ws } = w;
const {
	run,
	dataDirWithCache,
	seedMulti,
	copyOf,
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

test("without --to a deprecated template stays put and the report names declared successors", async () => {
	const result = await run(
		dataDirWithCache([OLD, NEW]),
		"update",
		OLD.id,
		TASK,
		ws.oldBpmn,
	);
	assert.strictEqual(result.status, 0, result.stderr);
	assert.strictEqual(result.stdout, readFileSync(ws.oldBpmn, "utf-8"));
	assert.match(result.stderr, /deprecated.*io\.example\.new/s);
	assert.doesNotMatch(result.stdout, /io\.example\.new/);
});

test("fails for an element without a template and for unknown elements", async () => {
	const templatePath = join(ws.workDir, "new.json");
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
		ws.oldBpmn,
		"--to",
		templatePath,
	);
	assert.strictEqual(unknown.status, 1);
	assert.match(unknown.stderr, /Element "Nope" not found/);
});

test("moves to the newest version and applies its recipe", async () => {
	const result = await run(
		dataDirWithCache([V1, V2]),
		"update",
		V1.id,
		TASK,
		ws.versionedBpmn,
	);
	assert.strictEqual(result.status, 0, result.stderr);
	assert.match(result.stdout, /modelerTemplateVersion="2"/);
	assert.match(result.stdout, /source="https:\/\/v1" target="url"/);
	assert.match(result.stderr, /> URL +https:\/\/v1 +was Endpoint/);
});

test("--to <id>@<n> pins a version and refuses a missing one", async () => {
	const missing = await run(
		dataDirWithCache([V1, V2]),
		"update",
		V1.id,
		TASK,
		ws.versionedBpmn,
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
		ws.versionedBpmn,
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
			ws.versionedBpmn,
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
		ws.versionedBpmn,
	);
	assert.strictEqual(result.status, 1);
	assert.match(result.stderr, /Unknown subcommand 'change'/);
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
	assert.match(result.stdout, /1 element updated/);
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

test("removes every temp dir it created", assertCleanedUp);
