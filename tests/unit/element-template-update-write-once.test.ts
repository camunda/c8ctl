/**
 * UPD-004: write once, never half
 * (default-plugins/element-template/commands/migrate.ts)
 */

import assert from "node:assert";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
	createUpdateWorkspace,
	NEW,
	OLD,
	TASK,
	taskXml,
	V1,
	V2,
	V3,
	versionOf,
} from "../utils/update-workspace.ts";

const w = createUpdateWorkspace();
const { ws } = w;
const {
	run,
	runWithPreload,
	dataDirWithCache,
	failingSaveXmlPreload,
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

test("serialization failure surfaces without --dry-run", async () => {
	const templatePath = join(ws.workDir, "new.json");
	writeFileSync(templatePath, JSON.stringify(NEW));
	const result = await runWithPreload(
		dataDirWithCache([OLD]),
		failingSaveXmlPreload(),
		["update", OLD.id, TASK, ws.oldBpmn, "--to", templatePath],
	);
	assert.strictEqual(result.status, 1);
	assert.match(result.stderr, /saveXML must not run/);
});

test("an existing writer lock prevents overwriting and is not removed", async () => {
	const file = join(ws.workDir, "locked.bpmn");
	const before = readFileSync(ws.versionedBpmn, "utf-8");
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

test("a missing file is reported before a lock is taken", async () => {
	const file = join(ws.workDir, "missing", "task.bpmn");
	const result = await run(
		dataDirWithCache([V1, V2]),
		"update",
		V1.id,
		TASK,
		file,
		"--in-place",
	);
	assert.strictEqual(result.status, 1);
	assert.match(result.stderr, /File not found: .*task\.bpmn/);
	assert.doesNotMatch(result.stderr, /migration\.lock/);
});

test("a lock that cannot be created keeps its own error", {
	skip:
		(process.platform === "win32" || process.getuid?.() === 0) &&
		"needs POSIX permissions as a non-root user",
}, async () => {
	const dir = join(ws.workDir, "read-only");
	mkdirSync(dir);
	const file = join(dir, "task.bpmn");
	writeFileSync(file, readFileSync(ws.versionedBpmn, "utf-8"));
	chmodSync(dir, 0o555);
	try {
		const result = await run(
			dataDirWithCache([V1, V2]),
			"update",
			V1.id,
			TASK,
			file,
			"--in-place",
		);
		assert.strictEqual(result.status, 1);
		assert.match(result.stderr, /EACCES/);
		assert.doesNotMatch(result.stderr, /Another writer/);
	} finally {
		chmodSync(dir, 0o755);
	}
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
	assert.match(result.stdout, /3 elements updated\./);
	assert.ok(!existsSync(`${copy}.migration.lock`));
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
	assert.match(text.stdout, /1 element updated, 1 failed\./);
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

test("removes every temp dir it created", assertCleanedUp);
