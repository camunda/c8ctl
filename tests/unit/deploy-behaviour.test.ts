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
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { c8, parseJson } from "../utils/cli.ts";
import { asRecord, asRecordArray } from "../utils/guards.ts";

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

	test("rejects file with unsupported extension", async () => {
		const unsupportedFile = join(tempDir, "process.unsupported");
		writeFileSync(unsupportedFile, "dummy content");

		const result = await c8("deploy", unsupportedFile, "--dry-run");
		assert.strictEqual(result.status, 1);
		assert.ok(
			result.stderr.includes("No deployable files found") ||
				result.stderr.includes("No deployable"),
			`Expected rejection for unsupported extension.\nstderr: ${result.stderr}`,
		);
	});

	test("--force deploys file with unsupported extension (dry-run)", async () => {
		const unsupportedFile = join(tempDir, "process.unsupported");
		writeFileSync(unsupportedFile, "dummy content");

		const result = await c8("deploy", unsupportedFile, "--force", "--dry-run");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);

		assert.strictEqual(out.dryRun, true);
		assert.strictEqual(out.method, "POST");
		assert.ok(typeof out.url === "string" && out.url.endsWith("/deployments"));

		const body = asRecord(out.body);
		const resources = asRecordArray(body.resources);
		assert.ok(resources.length > 0, "should include at least one resource");
		assert.strictEqual(resources[0].name, "process.unsupported");
	});
});
