/**
 * Tests for process-application auto-detection in `deploy`.
 *
 * When a `.process-application` marker file is found in a parent directory,
 * `c8 deploy` should expand directory paths to the PA root and deploy all
 * resources under it — matching Desktop Modeler's "Deploy process
 * application" behavior.
 *
 * File paths are NOT expanded (preserves watch single-file behavior).
 *
 * @see https://github.com/camunda/c8ctl/issues/227
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

const MINIMAL_FORM = `{ "components": [], "type": "default", "id": "test-form" }`;

let tempDir: string;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "c8ctl-pa-detect-"));
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

/**
 * Spawn `c8 deploy --dry-run` in the given cwd with the given args.
 * Returns parsed JSON output (the dry-run body).
 */
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

// ── Helpers to build PA fixture trees ─────────────────────────────────

function createPA(root: string, resources: Record<string, string> = {}): void {
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, ".process-application"), "");
	for (const [relPath, content] of Object.entries(resources)) {
		const full = join(root, relPath);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, content);
	}
}

// ── AC1: Deploy from any subdirectory inside a PA ─────────────────────

describe("Process application auto-detection (#227)", () => {
	test("deploys all PA resources when run from subdirectory", async () => {
		const paRoot = join(tempDir, "my-app");
		createPA(paRoot, {
			"root.bpmn": MINIMAL_BPMN,
			"sub/nested.bpmn": MINIMAL_BPMN,
			"sub/deep/deep.bpmn": MINIMAL_BPMN,
			"forms/my.form": MINIMAL_FORM,
		});

		// Run from a nested subdirectory
		const result = await deployDryRun(join(paRoot, "sub", "deep"));
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);

		const names = parseResourceNames(result);
		assert.deepStrictEqual(names, [
			"deep.bpmn",
			"my.form",
			"nested.bpmn",
			"root.bpmn",
		]);
	});

	test("deploys all PA resources when run from PA root", async () => {
		const paRoot = join(tempDir, "my-app");
		createPA(paRoot, {
			"main.bpmn": MINIMAL_BPMN,
			"sub/other.bpmn": MINIMAL_BPMN,
		});

		const result = await deployDryRun(paRoot);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);

		const names = parseResourceNames(result);
		assert.deepStrictEqual(names, ["main.bpmn", "other.bpmn"]);
	});

	test("deploys all PA resources when subdir is given as explicit path", async () => {
		const paRoot = join(tempDir, "my-app");
		createPA(paRoot, {
			"root.bpmn": MINIMAL_BPMN,
			"src/flow.bpmn": MINIMAL_BPMN,
		});

		// Run from tempDir, passing the subdirectory as argument
		const result = await deployDryRun(tempDir, [join(paRoot, "src")]);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);

		const names = parseResourceNames(result);
		assert.deepStrictEqual(names, ["flow.bpmn", "root.bpmn"]);
	});

	// ── AC2: No breaking changes outside a PA ───────────────────────────

	test("no PA marker: only deploys from the specified directory", async () => {
		// No .process-application file — plain directory
		const dir = join(tempDir, "plain");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "local.bpmn"), MINIMAL_BPMN);

		// Sibling directory should NOT be included
		const sibling = join(tempDir, "sibling");
		mkdirSync(sibling, { recursive: true });
		writeFileSync(join(sibling, "other.bpmn"), MINIMAL_BPMN);

		const result = await deployDryRun(dir);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);

		const names = parseResourceNames(result);
		assert.deepStrictEqual(names, ["local.bpmn"]);
	});

	// ── AC3: Explicit path to PA root ───────────────────────────────────

	test("explicit path to PA root deploys all PA resources", async () => {
		const paRoot = join(tempDir, "my-app");
		createPA(paRoot, {
			"a.bpmn": MINIMAL_BPMN,
			"sub/b.bpmn": MINIMAL_BPMN,
		});

		const result = await deployDryRun(tempDir, [paRoot]);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);

		const names = parseResourceNames(result);
		assert.deepStrictEqual(names, ["a.bpmn", "b.bpmn"]);
	});

	// ── File paths are NOT expanded ─────────────────────────────────────

	test("explicit file path inside PA deploys only that file", async () => {
		const paRoot = join(tempDir, "my-app");
		createPA(paRoot, {
			"root.bpmn": MINIMAL_BPMN,
			"sub/target.bpmn": MINIMAL_BPMN,
		});

		// Pass a specific file — should NOT expand to PA root
		const result = await deployDryRun(tempDir, [
			join(paRoot, "sub", "target.bpmn"),
		]);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);

		const names = parseResourceNames(result);
		assert.deepStrictEqual(names, ["target.bpmn"]);
	});

	// ── AC5: Mono-repo — each subdir finds its own PA ───────────────────

	test("mono-repo: multiple PAs resolve independently", async () => {
		const paA = join(tempDir, "app-a");
		createPA(paA, { "a.bpmn": MINIMAL_BPMN });
		mkdirSync(join(paA, "sub-of-a"), { recursive: true });

		const paB = join(tempDir, "app-b");
		createPA(paB, { "b.bpmn": MINIMAL_BPMN });
		mkdirSync(join(paB, "sub-of-b"), { recursive: true });

		// Deploy both subdirectories — each should expand to its own PA root
		const result = await deployDryRun(tempDir, [
			join(paA, "sub-of-a"),
			join(paB, "sub-of-b"),
		]);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);

		const names = parseResourceNames(result);
		assert.deepStrictEqual(names, ["a.bpmn", "b.bpmn"]);
	});

	// ── Nested PAs: nearest ancestor wins ───────────────────────────────

	test("nested PAs: nearest .process-application ancestor wins", async () => {
		const outer = join(tempDir, "outer");
		createPA(outer, { "outer.bpmn": MINIMAL_BPMN });

		const inner = join(outer, "inner");
		createPA(inner, { "inner.bpmn": MINIMAL_BPMN });

		// Deploy from inside inner — should find inner PA, not outer
		const result = await deployDryRun(inner);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);

		const names = parseResourceNames(result);
		assert.deepStrictEqual(names, ["inner.bpmn"]);
	});

	// ── .c8ignore at PA root is respected ───────────────────────────────

	test(".c8ignore at PA root filters resources during PA deploy", async () => {
		const paRoot = join(tempDir, "my-app");
		createPA(paRoot, {
			"keep.bpmn": MINIMAL_BPMN,
			"skip.bpmn": MINIMAL_BPMN,
			"sub/also-keep.bpmn": MINIMAL_BPMN,
		});
		writeFileSync(join(paRoot, ".c8ignore"), "skip.bpmn\n");

		// Deploy from subdirectory — PA root detected, .c8ignore at PA root applies
		const result = await deployDryRun(join(paRoot, "sub"));
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);

		const names = parseResourceNames(result);
		assert.deepStrictEqual(names, ["also-keep.bpmn", "keep.bpmn"]);
	});
});
