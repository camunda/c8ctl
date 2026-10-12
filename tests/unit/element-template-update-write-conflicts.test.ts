/**
 * MIG-002: the update command rejects writes to the same resolved binding
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
import { test } from "node:test";
import {
	enumerateElementValues,
	getExtensionElements,
} from "../../default-plugins/element-template/migration/element-values.ts";
import type { MigrationTemplate } from "../../default-plugins/element-template/migration/types.ts";
import { c8WithOptions } from "../utils/cli.ts";
import {
	createTestModeler,
	loadVendorBundle,
	seedTemplateCache,
} from "../utils/element-template.ts";

const TASK = "Activity_17s7axj";

function template(id: string, properties: object[], paths?: unknown[]) {
	return {
		id,
		name: id,
		version: 1,
		appliesTo: ["bpmn:Task"],
		engines: { camunda: "^8.8" },
		properties: [
			{
				type: "Hidden",
				value: "worker",
				binding: { type: "zeebe:taskDefinition", property: "type" },
			},
			...properties,
		],
		...(paths
			? {
					metadata: {
						migratesFrom: {
							schemaVersion: 1,
							sources: [{ kind: "change", sourceTemplateId: "old", paths }],
						},
					},
				}
			: {}),
	};
}

function property(name: string, value: string) {
	return {
		type: "String",
		label: name,
		value,
		binding: { type: "zeebe:input", name },
	};
}

for (const reversed of [false, true]) {
	test(`CLI refuses guarded alias conflicts without stdout or file mutation (reversed=${reversed})`, async (t) => {
		const dir = mkdtempSync(join(tmpdir(), "c8-write-conflict-"));
		t.after(() => rmSync(dir, { recursive: true, force: true }));
		const old = template("old", [
			property("a", "VALUE"),
			property("mode", "on"),
		]);
		const paths = [
			{ from: "input:a", to: "b", when: { path: "input:mode", equals: "on" } },
			{ to: "input:b", set: "other", when: { path: "input:mode", in: ["on"] } },
		];
		const target = template(
			"new",
			[property("b", "")],
			reversed ? paths.reverse() : paths,
		);
		seedTemplateCache(dir, [old, target]);
		const oldPath = join(dir, "old.json");
		const targetPath = join(dir, "new.json");
		const bpmn = join(dir, "process.bpmn");
		writeFileSync(oldPath, JSON.stringify(old));
		writeFileSync(targetPath, JSON.stringify(target));
		const run = (...args: string[]) =>
			c8WithOptions(
				{ env: { C8CTL_DATA_DIR: dir } },
				"element-template",
				...args,
			);
		const seeded = await run(
			"apply",
			oldPath,
			TASK,
			resolve("tests/fixtures/simple.bpmn"),
		);
		assert.equal(seeded.status, 0, seeded.stderr);
		writeFileSync(bpmn, seeded.stdout);
		for (const flags of [
			[],
			["--in-place", "--allow-lossy"],
			["--in-place", "--dry-run", "--json"],
		]) {
			const result = await run(
				"update",
				old.id,
				TASK,
				bpmn,
				"--to",
				targetPath,
				...flags,
			);
			assert.equal(result.status, 1, result.stderr);
			// --json reports the failure inside the JSON document on stdout.
			assert.match(
				flags.includes("--json") ? result.stdout : result.stderr,
				/Ambiguous migration/,
			);
			assert.doesNotMatch(result.stdout, /<bpmn:definitions|<\?xml/);
			if (!flags.includes("--in-place")) assert.equal(result.stdout, "");
			assert.equal(readFileSync(bpmn, "utf-8"), seeded.stdout);
			assert.equal(existsSync(`${bpmn}.migration.lock`), false);
		}
	});
}

test("CLI persists independent qualified input/header writes with the same key", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "c8-distinct-writes-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const old = template("old", [
		property("a", "INPUT"),
		property("c", "HEADER"),
	]);
	const targetProperties = [
		property("b", ""),
		{
			type: "String",
			label: "Header",
			value: "",
			binding: { type: "zeebe:taskHeader", key: "b" },
		},
	];
	const paths = [
		{ from: "input:a", to: "input:b" },
		{ from: "input:c", to: "header:b" },
	];
	seedTemplateCache(dir, [old]);
	const oldPath = join(dir, "old.json");
	const targetPath = join(dir, "new.json");
	const bpmn = join(dir, "process.bpmn");
	writeFileSync(oldPath, JSON.stringify(old));
	const run = (...args: string[]) =>
		c8WithOptions(
			{ env: { C8CTL_DATA_DIR: dir } },
			"element-template",
			...args,
		);
	const seeded = await run(
		"apply",
		oldPath,
		TASK,
		resolve("tests/fixtures/simple.bpmn"),
	);
	assert.equal(seeded.status, 0, seeded.stderr);
	const vendor = loadVendorBundle();
	for (const ordered of [paths, [...paths].reverse()]) {
		const target: MigrationTemplate = template(
			"new",
			targetProperties,
			ordered,
		);
		writeFileSync(targetPath, JSON.stringify(target));
		writeFileSync(bpmn, seeded.stdout);
		const result = await run(
			"update",
			old.id,
			TASK,
			bpmn,
			"--to",
			targetPath,
			"--in-place",
			"--json",
		);
		assert.equal(result.status, 0, result.stderr);
		const envelope = JSON.parse(result.stdout).results[0];
		assert.equal(envelope.lossless, true);
		assert.deepEqual(envelope.report.dropped, []);
		assert.deepEqual(
			envelope.report.moved
				.map((move: { to: { bindingType: string; key: string } }) => [
					move.to.bindingType,
					move.to.key,
				])
				.sort(),
			[
				["zeebe:input", "b"],
				["zeebe:taskHeader", "b"],
			],
		);
		const modeler = await createTestModeler(
			vendor,
			readFileSync(bpmn, "utf-8"),
		);
		const element = modeler.get("elementRegistry").get(TASK);
		assert.ok(element);
		assert.deepEqual(
			enumerateElementValues(getExtensionElements(element.businessObject))
				.filter((value) => value.key === "b")
				.map((value) => [value.bindingType, value.value])
				.sort(),
			[
				["zeebe:input", "INPUT"],
				["zeebe:taskHeader", "HEADER"],
			],
		);
	}
});
