/**
 * UPD-002: the target id resolves like every other subcommand's, local
 * templates first (default-plugins/element-template/commands/migrate.ts)
 */

import assert from "node:assert/strict";
import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { c8WithOptions } from "../utils/cli.ts";
import {
	createUpdateWorkspace,
	updateFixtures,
	versionOf,
} from "../utils/update-workspace.ts";

const { TASK, V1, V2, V3 } = updateFixtures;
const SCHEMA =
	"https://unpkg.com/@camunda/zeebe-element-templates-json-schema/resources/schema.json";
/** Local templates go through the Modeler's validator, which needs `$schema`. */
const local = (template: object) => ({ $schema: SCHEMA, ...template });

const workspace = createUpdateWorkspace();
const { ws } = workspace;

/** A project dir with the applied-V1 diagram in `processes/`. */
function project(): { root: string; processes: string; bpmn: string } {
	const root = mkdtempSync(join(ws.workDir, "project-"));
	const processes = join(root, "processes");
	mkdirSync(processes);
	const bpmn = join(processes, "v1.bpmn");
	writeFileSync(bpmn, readFileSync(ws.versionedBpmn, "utf-8"));
	return { root, processes, bpmn };
}

function writeLocal(dir: string, templates: object[]): void {
	const localDir = join(dir, ".camunda", "element-templates");
	mkdirSync(localDir, { recursive: true });
	writeFileSync(join(localDir, "custom.json"), JSON.stringify(templates));
}

function run(dataDir: string, bpmn: string, ...extra: string[]) {
	const modelerDir = mkdtempSync(join(ws.workDir, "modeler-"));
	return c8WithOptions(
		{
			env: {
				C8CTL_DATA_DIR: dataDir,
				C8CTL_MODELER_DIR: modelerDir,
				C8CTL_OUTPUT_MODE: "text",
			},
		},
		"element-template",
		"update",
		V1.id,
		bpmn,
		...extra,
	);
}

/** A data dir whose `templates.json` is not valid JSON. */
function corruptCache(): string {
	const dataDir = workspace.dataDirWithCache([]);
	writeFileSync(join(dataDir, "element-templates", "templates.json"), "{");
	return dataDir;
}

describe("element-template update resolves local templates first", () => {
	before(() => workspace.setup());
	after(() => workspace.teardown());

	test("cold cache: updates to a template from .camunda/element-templates/", async () => {
		const { root, bpmn } = project();
		writeLocal(root, [local(V1), local(V2)]);
		const coldDataDir = mkdtempSync(join(ws.workDir, "cold-"));
		const result = await run(coldDataDir, bpmn);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(versionOf(result.stdout, TASK), "2");
		assert.match(result.stdout, /source="https:\/\/v1" target="url"/);
	});

	test("picks the newest compatible version over all ancestors", async () => {
		const { root, processes, bpmn } = project();
		// The nearer dir holds only v2; the project root holds v3.
		writeLocal(processes, [local(V1), local(V2)]);
		writeLocal(root, [local(V3)]);
		const cacheUpToV2 = workspace.dataDirWithCache([V1, V2]);
		const result = await run(cacheUpToV2, bpmn);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(versionOf(result.stdout, TASK), "3");
	});

	test("a symlinked BPMN looks up local templates from the link's directory", {
		skip: process.platform === "win32",
	}, async () => {
		const { root, processes } = project();
		writeLocal(root, [local(V1), local(V2)]);
		const elsewhere = mkdtempSync(join(ws.workDir, "elsewhere-"));
		const target = join(elsewhere, "v1.bpmn");
		writeFileSync(target, readFileSync(ws.versionedBpmn, "utf-8"));
		const link = join(processes, "linked.bpmn");
		symlinkSync(target, link);
		const coldDataDir = mkdtempSync(join(ws.workDir, "cold-"));
		const result = await run(coldDataDir, link, "--in-place");
		assert.equal(result.status, 0, result.stderr);
		assert.ok(lstatSync(link).isSymbolicLink(), "link must survive");
		assert.match(readFileSync(target, "utf-8"), /modelerTemplateVersion="2"/);
	});

	test("a local miss falls back to the OOTB cache", async () => {
		const { root, bpmn } = project();
		// The only local version needs a newer engine than the diagram's 8.8.
		writeLocal(root, [local({ ...V3, engines: { camunda: "^8.9" } })]);
		const result = await run(workspace.dataDirWithCache([V1, V2]), bpmn);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(versionOf(result.stdout, TASK), "2");
	});

	test("a local miss with a cold cache asks for sync", async () => {
		const { bpmn } = project();
		const coldDataDir = mkdtempSync(join(ws.workDir, "cold-"));
		const result = await run(coldDataDir, bpmn);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /element-template sync/);
	});

	test("a corrupt cache does not stop a run on local templates", async () => {
		const { root, bpmn } = project();
		writeLocal(root, [local(V1), local(V2)]);
		const result = await run(corruptCache(), bpmn);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(versionOf(result.stdout, TASK), "2");
	});

	test("a corrupt cache does not stop a run with a target file and a recipe file", async () => {
		const { root, bpmn } = project();
		writeLocal(root, [local(V1)]);
		const target = join(root, "v2.json");
		writeFileSync(
			target,
			JSON.stringify(local({ ...V2, metadata: undefined })),
		);
		const recipe = join(root, "recipe.json");
		writeFileSync(recipe, JSON.stringify(V2.metadata.migratesFrom));
		const result = await run(
			corruptCache(),
			bpmn,
			"--to",
			target,
			"--recipe",
			recipe,
		);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(versionOf(result.stdout, TASK), "2");
		assert.match(result.stdout, /source="https:\/\/v1" target="url"/);
	});

	test("a corrupt cache does not stop a run to a target file of another id", async () => {
		const { root, bpmn } = project();
		writeLocal(root, [local(V1)]);
		const target = join(root, "other.json");
		writeFileSync(
			target,
			JSON.stringify(
				local({
					...V2,
					id: "io.example.other",
					version: 1,
					metadata: {
						migratesFrom: {
							schemaVersion: 1,
							sources: [
								{
									kind: "change",
									sourceTemplateId: V1.id,
									paths: [{ from: "endpoint", to: "url" }],
								},
							],
						},
					},
				}),
			),
		);
		const result = await run(corruptCache(), bpmn, "--to", target);
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /modelerTemplate="io.example.other"/);
		assert.match(result.stdout, /source="https:\/\/v1" target="url"/);
	});

	test("a recipe climbs through a version only the cache holds", async () => {
		const { root, bpmn } = project();
		const climbing = {
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
		writeLocal(root, [local(V1), local(climbing)]);
		const result = await run(workspace.dataDirWithCache([V1, V2]), bpmn);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(versionOf(result.stdout, TASK), "3");
		assert.match(result.stdout, /source="https:\/\/v1" target="url"/);
	});

	test("a pinned target only the cache holds is checked for conflicts", async () => {
		const { root, bpmn } = project();
		writeLocal(root, [local(V1)]);
		const shadow = { ...V2, name: "Conflicting cached target" };
		for (const duplicates of [
			[V2, shadow],
			[shadow, V2],
		]) {
			const result = await run(
				workspace.dataDirWithCache([V1, ...duplicates]),
				bpmn,
				"--to",
				`${V2.id}@2`,
			);
			assert.equal(result.status, 1, result.stdout);
			assert.match(result.stderr, /Conflicting definitions for template/);
		}
	});

	/** A V3-shaped version whose recipe climbs to version 2, then to itself. */
	const climbingTo = (version: number) => ({
		...V3,
		version,
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
						toVersion: version,
						paths: [],
					},
				],
			},
		},
	});
	const otherTarget = {
		...V3,
		id: "io.example.other",
		version: 1,
		metadata: {
			migratesFrom: {
				schemaVersion: 1,
				sources: [
					{
						kind: "change",
						sourceTemplateId: V1.id,
						paths: [{ from: "url", to: "url" }],
					},
				],
			},
		},
	};

	test("a template change climbs the compatible source lineage through a cache-only version", async () => {
		const { root, bpmn } = project();
		writeLocal(root, [
			local(V1),
			local(climbingTo(4)),
			local({ ...V3, version: 5, engines: { camunda: "^9.0" } }),
		]);
		const target = join(root, "other.json");
		writeFileSync(target, JSON.stringify(local(otherTarget)));
		const result = await run(
			workspace.dataDirWithCache([V1, V2]),
			bpmn,
			"--to",
			target,
		);
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /modelerTemplate="io.example.other"/);
		assert.match(result.stdout, /source="https:\/\/v1" target="url"/);
	});

	test("conflicting definitions of an unrelated cached id do not stop a template change", async () => {
		const { root, bpmn } = project();
		const unrelated = { ...V1, id: "io.example.unrelated", name: "Unrelated" };
		const target = join(root, "other.json");
		writeFileSync(target, JSON.stringify(local(otherTarget)));
		const result = await run(
			workspace.dataDirWithCache([
				V1,
				V2,
				climbingTo(3),
				unrelated,
				{ ...unrelated, name: "Conflicting unrelated" },
			]),
			bpmn,
			"--to",
			target,
		);
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /modelerTemplate="io.example.other"/);
	});

	test("a local version above a change floor satisfies it without reading the cache", async () => {
		const { root, bpmn } = project();
		writeLocal(root, [local(V1), local(V3)]);
		const target = join(root, "other.json");
		writeFileSync(
			target,
			JSON.stringify(
				local({
					...V2,
					id: "io.example.other",
					version: 1,
					metadata: {
						migratesFrom: {
							schemaVersion: 1,
							sources: [
								{
									kind: "change",
									sourceTemplateId: V1.id,
									paths: [{ from: "endpoint", to: "url" }],
								},
								{
									kind: "change",
									sourceTemplateId: V1.id,
									minSourceVersion: 2,
									paths: [{ from: "endpoint", to: "url" }],
								},
							],
						},
					},
				}),
			),
		);
		const result = await run(
			corruptCache(),
			bpmn,
			"--to",
			target,
			"--allow-lossy",
		);
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /modelerTemplate="io.example.other"/);
		assert.match(result.stderr, /which reached version 3 does not define/);
	});

	test("a corrupt cache does not stop a run whose recipe lists a version below the applied one", async () => {
		const { root, processes } = project();
		const applied = await workspace.seedBpmn(
			V3,
			["provider=azure", "url=https://v3"],
			"v3",
		);
		const bpmn = join(processes, "v3.bpmn");
		writeFileSync(bpmn, readFileSync(applied, "utf-8"));
		writeLocal(root, [local(V3), local(climbingTo(4))]);
		const result = await run(corruptCache(), bpmn);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(versionOf(result.stdout, TASK), "4");
	});

	test("a local miss still reports a corrupt cache", async () => {
		const { bpmn } = project();
		const result = await run(corruptCache(), bpmn);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /cache is corrupt/);
	});
});
