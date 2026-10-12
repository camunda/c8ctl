/**
 * UPD-003: --map moves values to the target
 * (default-plugins/element-template/commands/migrate.ts)
 */

import assert from "node:assert";
import { readFileSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import {
	createUpdateWorkspace,
	DST,
	SRC,
	TASK,
	taskXml,
	V1,
	V2,
} from "../utils/update-workspace.ts";

const w = createUpdateWorkspace();
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

test("removes every temp dir it created", assertCleanedUp);
