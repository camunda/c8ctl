/**
 * CLI behavioural tests for the `run` command.
 *
 * These tests exercise the full dispatch path by spawning the CLI as a
 * subprocess with `--dry-run`. They verify that CLI flags flow correctly
 * through `index.ts` dispatch → validation → handler → JSON output, and
 * pin the observable shape of the dry-run preview so the planned
 * #288 refactor (move the body into the `defineCommand` handler, drop
 * the legacy `emitDryRun()` call in favour of the framework helper)
 * cannot silently regress argument forwarding.
 */

import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { c8, parseJson } from "../utils/cli.ts";
import { asRecord } from "../utils/guards.ts";

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

describe("CLI behavioural: run", () => {
	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "c8ctl-run-behaviour-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test("--dry-run emits POST shape with path in body", async () => {
		// Pin the dry-run JSON contract: method=POST, an endpoint string
		// that names both underlying API calls (deployment + process
		// instance), and a body that includes the resolved path positional.
		// Argument forwarding (`ctx.resource` → `path`) is implicitly
		// pinned here — the dry-run body could only contain the path if
		// the handler received it.
		const bpmnFile = join(tempDir, "test.bpmn");
		writeFileSync(bpmnFile, MINIMAL_BPMN);

		const result = await c8("run", bpmnFile, "--dry-run");

		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);

		assert.strictEqual(out.dryRun, true);
		assert.strictEqual(out.method, "POST");
		assert.ok(
			typeof out.url === "string" &&
				out.url.includes("/deployments") &&
				out.url.includes("/process-instances"),
			`expected url to mention both /deployments and /process-instances, got: ${out.url}`,
		);

		const body = asRecord(out.body, "dry-run body");
		assert.strictEqual(
			body.path,
			bpmnFile,
			`expected body.path === ${bpmnFile}, got: ${body.path}`,
		);
	});

	test("--variables flag is forwarded into the dry-run body", async () => {
		// Pin that `--variables` flows through the handler into the
		// preview body as the original raw string. The legacy `run()`
		// emits `body: { path, variables: options.variables }` — the
		// refactor must preserve this shape (parsing happens later, in
		// the execute path).
		const bpmnFile = join(tempDir, "vars.bpmn");
		writeFileSync(bpmnFile, MINIMAL_BPMN);

		const variablesJson = '{"orderId":42,"customer":"acme"}';
		const result = await c8(
			"run",
			bpmnFile,
			"--variables",
			variablesJson,
			"--dry-run",
		);

		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);
		const body = asRecord(out.body, "dry-run body");
		assert.strictEqual(
			body.variables,
			variablesJson,
			`expected body.variables to be the raw flag value, got: ${JSON.stringify(body.variables)}`,
		);
	});
});
