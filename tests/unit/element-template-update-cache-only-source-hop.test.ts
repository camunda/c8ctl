/**
 * UPD-002: a cross-id hop whose source floor exceeds the local lineage climbs
 * through the cache (default-plugins/element-template/commands/migrate.ts)
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { c8WithOptions } from "../utils/cli.ts";
import {
	DIAGRAM,
	input,
	seedTemplateCache,
	template,
} from "../utils/element-template.ts";

const SCHEMA =
	"https://unpkg.com/@camunda/zeebe-element-templates-json-schema/resources/schema.json";
const TASK_DIAGRAM = DIAGRAM.replace(
	'<bpmn:serviceTask id="Task_1" />',
	'<bpmn:task id="Task_1" />',
);

const SOURCE = "io.example.cache-hop.source";
const V1 = template(SOURCE, 1, [input("a", "kept")]);
const V2 = template(
	SOURCE,
	2,
	[input("a", "kept")],
	[{ kind: "upgrade", sourceTemplateId: SOURCE, toVersion: 2, paths: [] }],
);
const NEXT = template(
	"io.example.cache-hop.next",
	1,
	[input("a", "kept")],
	[
		{
			kind: "change",
			sourceTemplateId: SOURCE,
			minSourceVersion: 2,
			paths: [{ from: "a", to: "a" }],
		},
	],
);

test("a newer cached source version is climbed although a local one exists", async () => {
	const root = mkdtempSync(join(tmpdir(), "c8ctl-cache-hop-"));
	try {
		const dataDir = join(root, "data");
		seedTemplateCache(dataDir, [V1, V2]);
		const localDir = join(root, ".camunda", "element-templates");
		mkdirSync(localDir, { recursive: true });
		writeFileSync(
			join(localDir, "local.json"),
			JSON.stringify([{ $schema: SCHEMA, ...V1 }]),
		);
		const nextPath = join(root, "next.json");
		writeFileSync(nextPath, JSON.stringify(NEXT));
		const v1Path = join(root, "v1.json");
		writeFileSync(v1Path, JSON.stringify(V1));
		const diagram = join(root, "task.bpmn");
		writeFileSync(diagram, TASK_DIAGRAM);
		const env = { C8CTL_DATA_DIR: dataDir };
		const applied = await c8WithOptions(
			{ env },
			"element-template",
			"apply",
			v1Path,
			"Task_1",
			diagram,
		);
		assert.equal(applied.status, 0, applied.stderr);
		writeFileSync(diagram, applied.stdout);

		const result = await c8WithOptions(
			{ env },
			"element-template",
			"update",
			SOURCE,
			"Task_1",
			diagram,
			"--to",
			nextPath,
			"--dry-run",
			"--json",
		);
		assert.equal(result.status, 0, result.stderr);
		assert.doesNotMatch(result.stderr, /unmet source floor/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
