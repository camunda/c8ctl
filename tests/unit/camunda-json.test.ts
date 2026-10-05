/**
 * Tests for the camunda.json project descriptor parser.
 *
 * A `camunda.json` file marks a folder as a Camunda project. It must contain
 * a single JSON object; all fields are optional. Invalid JSON is a hard
 * error — the file must not silently count as a project marker.
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

	test("extracts hub.projectId", () => {
		const project = parseCamundaJson(
			JSON.stringify({ hub: { projectId: "abc-123" } }),
		);
		assert.strictEqual(project.hubProjectId, "abc-123");
	});

	test("hub without projectId is valid", () => {
		assert.deepStrictEqual(parseCamundaJson('{ "hub": {} }'), {});
	});

	test("unknown fields are ignored", () => {
		const project = parseCamundaJson(
			'{ "futureField": [1, 2], "hub": { "projectId": "x" } }',
		);
		assert.strictEqual(project.hubProjectId, "x");
	});

	test("throws on invalid JSON", () => {
		assert.throws(() => parseCamundaJson("{ not json"), /invalid JSON/i);
	});

	test("throws on non-object top level", () => {
		assert.throws(() => parseCamundaJson('"just a string"'), /object/i);
		assert.throws(() => parseCamundaJson("[1, 2]"), /object/i);
		assert.throws(() => parseCamundaJson("null"), /object/i);
	});

	test("throws when hub is not an object", () => {
		assert.throws(() => parseCamundaJson('{ "hub": "nope" }'), /"hub"/i);
	});

	test("throws when hub.projectId is not a string", () => {
		assert.throws(
			() => parseCamundaJson('{ "hub": { "projectId": 42 } }'),
			/projectId/i,
		);
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
		assert.strictEqual(project.hubProjectId, "p1");
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
