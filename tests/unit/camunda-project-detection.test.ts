/**
 * Tests for Camunda project (`camunda.json`) detection in `deploy`.
 *
 * During the transition from process applications to Camunda projects,
 * `camunda.json` and `.process-application` are equivalent markers: both
 * define the project boundary that `c8 deploy` expands directories to.
 * The nearest ancestor marker wins; projects do not nest.
 */

import assert from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { asyncSpawn, type SpawnResult } from "../utils/spawn.ts";

const CLI = resolve(import.meta.dirname, "..", "..", "src", "index.ts");

const MINIMAL_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
  targetNamespace="http://test" id="defs">
  <process id="test-process" isExecutable="true">
    <startEvent id="start"/>
  </process>
</definitions>`;

let tempDir: string;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "c8ctl-camunda-project-"));
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

async function deployDryRun(
	cwd: string,
	args: string[] = [],
): Promise<SpawnResult> {
	const dataDir = mkdtempSync(join(cwd, ".c8ctl-data-"));
	writeFileSync(
		join(dataDir, "session.json"),
		JSON.stringify({ outputMode: "json" }),
	);
	return asyncSpawn(
		"node",
		["--experimental-strip-types", CLI, "deploy", ...args, "--dry-run"],
		{
			cwd,
			env: {
				PATH: process.env.PATH,
				CAMUNDA_BASE_URL: "http://test-cluster/v2",
				HOME: "/tmp/c8ctl-test-nonexistent-home",
				C8CTL_DATA_DIR: dataDir,
			},
		},
	);
}

function parseResourceNames(result: SpawnResult): string[] {
	const out = JSON.parse(result.stdout);
	assert.ok(
		out.body && Array.isArray(out.body.resources),
		"Expected body.resources array in dry-run output",
	);
	const resources: unknown[] = out.body.resources;
	return resources
		.map((r) => {
			assert.ok(
				r && typeof r === "object" && "name" in r && typeof r.name === "string",
				"Expected resource with string name",
			);
			return r.name;
		})
		.sort();
}

function createProject(
	root: string,
	resources: Record<string, string> = {},
): void {
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, "camunda.json"), "{}");
	for (const [relPath, content] of Object.entries(resources)) {
		const full = join(root, relPath);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, content);
	}
}

describe("Camunda project detection (camunda.json)", () => {
	test("deploys all project resources when run from subdirectory", async () => {
		const projectRoot = join(tempDir, "my-project");
		createProject(projectRoot, {
			"root.bpmn": MINIMAL_BPMN,
			"sub/nested.bpmn": MINIMAL_BPMN,
		});

		const result = await deployDryRun(join(projectRoot, "sub"));
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);

		assert.deepStrictEqual(parseResourceNames(result), [
			"nested.bpmn",
			"root.bpmn",
		]);
	});

	test("camunda.json itself is never deployed as a resource", async () => {
		const projectRoot = join(tempDir, "my-project");
		createProject(projectRoot, { "main.bpmn": MINIMAL_BPMN });

		// --force disables extension filtering, so this guards the
		// explicit camunda.json skip and not the .json extension default.
		// Run from the parent so the test's data dir (created under cwd)
		// is outside the walked tree.
		const result = await deployDryRun(tempDir, [projectRoot, "--force"]);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);

		assert.deepStrictEqual(parseResourceNames(result), ["main.bpmn"]);
	});

	test("explicit camunda.json path is rejected as a deployment resource", async () => {
		const projectRoot = join(tempDir, "my-project");
		createProject(projectRoot, { "main.bpmn": MINIMAL_BPMN });

		// Only camunda.json named — nothing deployable remains
		const only = await deployDryRun(tempDir, [
			join(projectRoot, "camunda.json"),
		]);
		assert.notStrictEqual(
			only.status,
			0,
			"Explicit camunda.json must not deploy the descriptor",
		);

		// Named alongside a real resource — only the resource is deployed
		const alongside = await deployDryRun(tempDir, [
			join(projectRoot, "camunda.json"),
			join(projectRoot, "main.bpmn"),
		]);
		assert.strictEqual(alongside.status, 0, `stderr: ${alongside.stderr}`);
		assert.deepStrictEqual(parseResourceNames(alongside), ["main.bpmn"]);
	});

	test("both markers in the same folder: project root deploys normally", async () => {
		const projectRoot = join(tempDir, "my-project");
		createProject(projectRoot, { "main.bpmn": MINIMAL_BPMN });
		writeFileSync(join(projectRoot, ".process-application"), "");

		const result = await deployDryRun(projectRoot);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);

		assert.deepStrictEqual(parseResourceNames(result), ["main.bpmn"]);
	});

	test("nearest marker wins: camunda.json inside a process application", async () => {
		const outer = join(tempDir, "outer-pa");
		mkdirSync(outer, { recursive: true });
		writeFileSync(join(outer, ".process-application"), "");
		writeFileSync(join(outer, "outer.bpmn"), MINIMAL_BPMN);

		const inner = join(outer, "inner-project");
		createProject(inner, { "inner.bpmn": MINIMAL_BPMN });

		const result = await deployDryRun(inner);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);

		assert.deepStrictEqual(parseResourceNames(result), ["inner.bpmn"]);
	});

	test("nearest marker wins: process application inside a camunda.json project", async () => {
		const outer = join(tempDir, "outer-project");
		createProject(outer, { "outer.bpmn": MINIMAL_BPMN });

		const inner = join(outer, "inner-pa");
		mkdirSync(inner, { recursive: true });
		writeFileSync(join(inner, ".process-application"), "");
		writeFileSync(join(inner, "inner.bpmn"), MINIMAL_BPMN);

		const result = await deployDryRun(inner);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);

		assert.deepStrictEqual(parseResourceNames(result), ["inner.bpmn"]);
	});

	test("nested project is a boundary: deploying the outer root skips the inner project", async () => {
		const outer = join(tempDir, "outer-project");
		createProject(outer, { "outer.bpmn": MINIMAL_BPMN });

		const inner = join(outer, "inner-project");
		createProject(inner, { "inner.bpmn": MINIMAL_BPMN });

		// Camunda projects do not nest — the inner subtree is a separate
		// project and is excluded from the outer deploy.
		const result = await deployDryRun(outer);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);

		assert.deepStrictEqual(parseResourceNames(result), ["outer.bpmn"]);
	});

	test("invalid camunda.json fails with a clear error", async () => {
		const projectRoot = join(tempDir, "broken-project");
		mkdirSync(projectRoot, { recursive: true });
		writeFileSync(join(projectRoot, "camunda.json"), "{ broken");
		writeFileSync(join(projectRoot, "main.bpmn"), MINIMAL_BPMN);

		const result = await deployDryRun(projectRoot);
		assert.notStrictEqual(
			result.status,
			0,
			"Invalid camunda.json must not silently count as a marker",
		);
		const output = result.stderr + result.stdout;
		assert.ok(
			/invalid JSON/i.test(output) && output.includes("camunda.json"),
			`Error should mention invalid JSON in camunda.json, got:\n${output}`,
		);
	});
});
