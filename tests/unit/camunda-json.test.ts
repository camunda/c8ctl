/**
 * Tests for the camunda.json project descriptor parser.
 *
 * A `camunda.json` file marks a folder as a Camunda project. It must
 * contain a single JSON object; all fields are optional. Malformed JSON
 * is a hard error — the file must not silently count as a project
 * marker. A whitespace-only file is an empty descriptor (migration path
 * from an empty legacy marker), and UTF-8 / UTF-16LE BOMs are tolerated.
 * Known fields are extracted when well-typed and ignored otherwise —
 * marker detection must not break on fields no command consumes.
 */

import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
	CAMUNDA_PROJECT_FILE,
	parseCamundaJson,
	readCamundaProject,
} from "../../src/utils/index.ts";

let tempDir: string;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "c8ctl-camunda-json-"));
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

describe("parseCamundaJson", () => {
	test("empty object is a valid descriptor", () => {
		assert.deepStrictEqual(parseCamundaJson("{}"), {});
	});

	test("whitespace-only content is an empty descriptor", () => {
		assert.deepStrictEqual(parseCamundaJson(""), {});
		assert.deepStrictEqual(parseCamundaJson("  \n\t "), {});
	});

	test("mirrors the descriptor structure (hub.projectId)", () => {
		const project = parseCamundaJson(
			JSON.stringify({ hub: { projectId: "abc-123" } }),
		);
		assert.deepStrictEqual(project, { hub: { projectId: "abc-123" } });
	});

	test("hub without projectId is valid", () => {
		assert.deepStrictEqual(parseCamundaJson('{ "hub": {} }'), { hub: {} });
	});

	test("unknown fields are ignored", () => {
		const project = parseCamundaJson(
			'{ "futureField": [1, 2], "hub": { "projectId": "x" } }',
		);
		assert.deepStrictEqual(project, { hub: { projectId: "x" } });
	});

	test("wrong-typed known fields are ignored, not fatal", () => {
		// No command consumes these fields yet — a wrong type must not
		// break marker detection for deploy/watch.
		assert.deepStrictEqual(parseCamundaJson('{ "hub": "nope" }'), {});
		assert.deepStrictEqual(parseCamundaJson('{ "hub": { "projectId": 42 } }'), {
			hub: {},
		});
	});

	test("throws on invalid JSON with an actionable hint", () => {
		assert.throws(
			() => parseCamundaJson("{ not json"),
			/invalid JSON.*use \{\} for an empty descriptor/is,
		);
	});

	test("throws on non-object top level", () => {
		assert.throws(() => parseCamundaJson('"just a string"'), /object/i);
		assert.throws(() => parseCamundaJson("[1, 2]"), /object/i);
		assert.throws(() => parseCamundaJson("null"), /object/i);
	});
});

describe("readCamundaProject", () => {
	test("returns null when no camunda.json exists", () => {
		assert.strictEqual(readCamundaProject(tempDir), null);
	});

	test("reads and parses camunda.json from the directory", () => {
		writeFileSync(
			join(tempDir, CAMUNDA_PROJECT_FILE),
			'{ "hub": { "projectId": "p1" } }',
		);
		const project = readCamundaProject(tempDir);
		assert.ok(project);
		assert.strictEqual(project.hub?.projectId, "p1");
	});

	test("tolerates a UTF-8 BOM", () => {
		writeFileSync(join(tempDir, CAMUNDA_PROJECT_FILE), "\uFEFF{}");
		assert.deepStrictEqual(readCamundaProject(tempDir), {});
	});

	test("tolerates UTF-16LE with BOM (Windows PowerShell 5.1)", () => {
		const buffer = Buffer.concat([
			Buffer.from([0xff, 0xfe]),
			Buffer.from('{ "hub": { "projectId": "p1" } }', "utf16le"),
		]);
		writeFileSync(join(tempDir, CAMUNDA_PROJECT_FILE), buffer);
		const project = readCamundaProject(tempDir);
		assert.ok(project);
		assert.strictEqual(project.hub?.projectId, "p1");
	});

	test("accepts an empty file as an empty descriptor", () => {
		writeFileSync(join(tempDir, CAMUNDA_PROJECT_FILE), "");
		assert.deepStrictEqual(readCamundaProject(tempDir), {});
	});

	test("throws a clear error on invalid JSON (file must not silently count as marker)", () => {
		const file = join(tempDir, CAMUNDA_PROJECT_FILE);
		writeFileSync(file, "{ broken");
		assert.throws(
			() => readCamundaProject(tempDir),
			/invalid JSON.*camunda\.json/is,
		);
	});
});
