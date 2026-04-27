/**
 * Class-of-defect regression guards for `c8 run` error paths.
 *
 * Existing coverage on main (don't duplicate here):
 *
 *   - `tests/unit/round-1-error-paths.test.ts` covers the
 *     "BPMN file with no <process id>" path and asserts the
 *     "Failed to run" framework prefix appears (proving the throw
 *     flowed through the framework wrapper rather than terminating
 *     the process directly via `process.exit(1)`).
 *   - `tests/unit/form-topology-run-behaviour.test.ts` covers the
 *     dry-run JSON shape (POST, both endpoints, path/variables in
 *     body), missing-path usage error, unsupported-extension
 *     rejection, and `--force` bypass.
 *
 * Guards in this file:
 *
 *   1. STRUCTURAL — AST scan over `src/commands/run.ts` for zero
 *      `process.exit(...)` calls. Mirrors the structural part of
 *      `tests/unit/deploy-error-paths.test.ts`. Any future
 *      regression that adds a `process.exit(...)` call into
 *      `run.ts` fails here immediately. AST-based (not regex) so
 *      string literals containing `process.exit(` and
 *      stripped-comment edge cases cannot produce false positives
 *      or false negatives.
 *
 *   2. BEHAVIOURAL — `c8 run <bpmn> --variables <bad-json>`. After
 *      #329 inlined the handler body, `--variables` JSON parsing
 *      runs up-front (before any I/O), which made this path
 *      reachable in unit tests for the first time. Pinning the
 *      observable contract — exit 1 + the "Invalid JSON for
 *      variables" message in stderr — means a future change to the
 *      validation order or wrapper text cannot silently regress the
 *      user-fixable error case.
 */

import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { c8 } from "../utils/cli.ts";
import { findProcessExitCalls } from "../utils/no-process-exit.ts";

const PROJECT_ROOT = resolve(import.meta.dirname, "..", "..");
const RUN_TS = join(PROJECT_ROOT, "src", "commands", "run.ts");

const MINIMAL_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  id="Definitions_1" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="test-process" isExecutable="true">
    <bpmn:startEvent id="start"/>
  </bpmn:process>
</bpmn:definitions>`;

describe("run: structural guard — no process.exit in run.ts", () => {
	test("src/commands/run.ts contains no `process.exit(...)` calls", () => {
		const calls = findProcessExitCalls(RUN_TS);
		assert.strictEqual(
			calls.length,
			0,
			`Expected zero \`process.exit(...)\` calls in run.ts, found ${calls.length}:\n` +
				calls
					.map((c) => `  - line ${c.line}:${c.column} — ${c.text}`)
					.join("\n") +
				`\n\nEvery error path must throw so the framework's handleCommandError pipeline owns process termination.`,
		);
	});
});

describe("run: behavioural — invalid --variables JSON is rejected up-front", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "c8ctl-run-bad-variables-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test("c8 run <bpmn> --variables <bad-json>: exit 1 + 'Invalid JSON for variables' in stderr", async () => {
		// Use a real BPMN file so argument validation passes. The
		// `--variables` value is intentionally malformed JSON. Post-#329
		// the handler parses `--variables` BEFORE any network I/O, so
		// this path is reachable from a unit test without a live Camunda
		// server. The observable contract pinned here:
		//   - exit code 1
		//   - stderr contains "Invalid JSON for variables"
		// (The framework prepends its own "Failed to run: " prefix; we
		// don't assert on the prefix here because that's separately
		// pinned by `round-1-error-paths.test.ts`.)
		const bpmnPath = join(tempDir, "process.bpmn");
		writeFileSync(bpmnPath, MINIMAL_BPMN);

		const result = await c8("run", bpmnPath, "--variables", "{not-json");

		assert.strictEqual(
			result.status,
			1,
			`expected exit 1, got ${result.status}. stderr:\n${result.stderr}`,
		);
		assert.ok(
			result.stderr.includes("Invalid JSON for variables"),
			`expected 'Invalid JSON for variables' in stderr. stderr:\n${result.stderr}`,
		);
	});
});
