/**
 * CLI behavioural tests for deploy command.
 *
 * These tests exercise the full dispatch path by spawning the CLI
 * as a subprocess with --dry-run. They verify that CLI flags flow
 * correctly through index.ts dispatch → validation → handler → JSON output.
 */

import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { c8, parseJson } from "../utils/cli.ts";
import { asRecord, asRecordArray } from "../utils/guards.ts";
import { asyncSpawn } from "../utils/spawn.ts";

const CLI = resolve(import.meta.dirname, "..", "..", "src", "index.ts");

/**
 * Spawn the CLI with a custom cwd. The standard `c8()` helper does not
 * support cwd; tests that must exercise the "default to current directory"
 * path or path-relative resolution use this thin wrapper directly.
 */
async function c8In(
	cwd: string,
	...args: string[]
): Promise<{ stdout: string; stderr: string; status: number | null }> {
	return asyncSpawn("node", ["--experimental-strip-types", CLI, ...args], {
		cwd,
		env: {
			...process.env,
			CAMUNDA_BASE_URL: "http://test-cluster/v2",
			HOME: "/tmp/c8ctl-test-nonexistent-home",
		},
	});
}

const MINIMAL_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
                  xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
                  id="Definitions_1" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="test-process" isExecutable="true">
    <bpmn:startEvent id="start"/>
  </bpmn:process>
  <bpmndi:BPMNDiagram id="BPMNDiagram_1">
    <bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="test-process">
      <bpmndi:BPMNShape id="start_di" bpmnElement="start">
        <dc:Bounds x="173" y="102" width="36" height="36"/>
      </bpmndi:BPMNShape>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>`;

let tempDir: string;

describe("CLI behavioural: deploy", () => {
	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "c8ctl-deploy-behaviour-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test("--dry-run emits POST to /deployments with resource list", async () => {
		const bpmnFile = join(tempDir, "test.bpmn");
		writeFileSync(bpmnFile, MINIMAL_BPMN);

		const result = await c8("deploy", bpmnFile, "--dry-run");

		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);

		assert.strictEqual(out.dryRun, true);
		assert.strictEqual(out.method, "POST");
		assert.ok(typeof out.url === "string" && out.url.endsWith("/deployments"));

		const body = asRecord(out.body, "dry-run body");
		const resources = asRecordArray(body.resources, "body.resources");
		assert.ok(resources.length > 0, "should include at least one resource");
		assert.ok(resources[0].name, "resource should have a name");
	});

	test("--dry-run rejects directory with no deployable files", async () => {
		// Create an empty subdirectory
		const emptyDir = join(tempDir, "empty");
		rmSync(emptyDir, { recursive: true, force: true });
		const { mkdirSync } = await import("node:fs");
		mkdirSync(emptyDir, { recursive: true });

		const result = await c8("deploy", emptyDir, "--dry-run");

		assert.strictEqual(result.status, 1);
		assert.ok(
			result.stderr.includes("No BPMN/DMN/Form files found") ||
				result.stderr.includes("No deployable"),
			`stderr: ${result.stderr}`,
		);
	});

	// ── Pre-#288 coverage guards ────────────────────────────────────────────
	// These pin the public observable behaviour of the dispatch wrapper so
	// the planned move of the deploy body into the defineCommand handler
	// (issue #288) cannot silently regress argument forwarding.

	test("no positional args defaults to current working directory", async () => {
		// Write a BPMN file at the root of a temp dir, invoke `c8 deploy --dry-run`
		// from that dir with no path argument, and assert the file is picked up.
		writeFileSync(join(tempDir, "root.bpmn"), MINIMAL_BPMN);

		const result = await c8In(tempDir, "deploy", "--dry-run");

		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = JSON.parse(result.stdout);
		const body = asRecord(out.body, "dry-run body");
		const resources = asRecordArray(body.resources, "body.resources");
		const names = resources.map((r) => r.name);
		assert.ok(
			names.includes("root.bpmn"),
			`expected root.bpmn in resources, got: ${JSON.stringify(names)}`,
		);
	});

	test("multiple positional path args are all collected", async () => {
		// Two BPMN files in separate dirs to prove both positionals are forwarded
		// (regression guard for `[ctx.resource, ...ctx.positionals]` shape).
		const dirA = join(tempDir, "a");
		const dirB = join(tempDir, "b");
		const { mkdirSync } = await import("node:fs");
		mkdirSync(dirA, { recursive: true });
		mkdirSync(dirB, { recursive: true });
		const fileA = join(dirA, "alpha.bpmn");
		const fileB = join(dirB, "beta.bpmn");
		writeFileSync(fileA, MINIMAL_BPMN.replace("test-process", "alpha-process"));
		writeFileSync(fileB, MINIMAL_BPMN.replace("test-process", "beta-process"));

		const result = await c8("deploy", fileA, fileB, "--dry-run");

		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);
		const body = asRecord(out.body, "dry-run body");
		const resources = asRecordArray(body.resources, "body.resources");
		const names = resources.map((r) => r.name);
		assert.ok(
			names.includes("alpha.bpmn"),
			`expected alpha.bpmn in resources, got: ${JSON.stringify(names)}`,
		);
		assert.ok(
			names.includes("beta.bpmn"),
			`expected beta.bpmn in resources, got: ${JSON.stringify(names)}`,
		);
	});
});
