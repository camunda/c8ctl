/**
 * Behavioural guards for Round 1 of the `process.exit` migration (issue #300,
 * follow-on to issue #288). These four commands each had exactly one
 * `process.exit(1)` site in a validation guard:
 *
 *   - `src/commands/forms.ts`       — mutex flag check (`--userTask` vs `--processDefinition`)
 *   - `src/commands/incidents.ts`   — invalid `--between` value
 *   - `src/commands/run.ts`         — BPMN file with no extractable process id
 *   - `src/commands/user-tasks.ts`  — invalid `--between` value
 *
 * After migration each path must `throw` so the framework's `handleCommandError`
 * pipeline owns process termination. The cross-handler architectural guard
 * (`tests/unit/no-process-exit-in-handlers.test.ts`) is the durable
 * class-of-defect catch — these behavioural tests prove each individual
 * migration is actually wired through the framework by asserting the
 * framework's `Failed to ${verb} ${resource}` prefix appears in stderr.
 * That prefix is added by `handleCommandError` and CANNOT appear if the
 * helper called `process.exit(1)` directly.
 */

import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { c8 } from "../utils/cli.ts";

describe("forms: behavioural — mutex flag error flows through the framework", () => {
	test("--userTask + --processDefinition: framework prefix appears (proves throw, not exit)", async () => {
		const result = await c8(
			"get",
			"form",
			"some-key",
			"--userTask",
			"--processDefinition",
		);

		assert.strictEqual(
			result.status,
			1,
			`expected exit 1, got ${result.status}. stderr:\n${result.stderr}`,
		);
		assert.ok(
			result.stderr.includes("Cannot specify both"),
			`expected original error message in stderr. stderr:\n${result.stderr}`,
		);
		assert.ok(
			result.stderr.includes("Failed to get form"),
			`expected framework prefix 'Failed to get form' in stderr, proving the error flowed through handleCommandError instead of process.exit(1). stderr:\n${result.stderr}`,
		);
	});
});

describe("incidents: behavioural — invalid --between flows through the framework", () => {
	test("invalid --between: framework prefix appears (proves throw, not exit)", async () => {
		const result = await c8(
			"list",
			"incidents",
			"--between",
			"not-a-valid-range",
		);

		assert.strictEqual(
			result.status,
			1,
			`expected exit 1, got ${result.status}. stderr:\n${result.stderr}`,
		);
		assert.ok(
			result.stderr.includes("Invalid --between"),
			`expected original error message in stderr. stderr:\n${result.stderr}`,
		);
		assert.ok(
			result.stderr.includes("Failed to list incident"),
			`expected framework prefix 'Failed to list incident' in stderr, proving the error flowed through handleCommandError instead of process.exit(1). stderr:\n${result.stderr}`,
		);
	});
});

describe("user-tasks: behavioural — invalid --between flows through the framework", () => {
	test("invalid --between: framework prefix appears (proves throw, not exit)", async () => {
		const result = await c8(
			"list",
			"user-tasks",
			"--between",
			"not-a-valid-range",
		);

		assert.strictEqual(
			result.status,
			1,
			`expected exit 1, got ${result.status}. stderr:\n${result.stderr}`,
		);
		assert.ok(
			result.stderr.includes("Invalid --between"),
			`expected original error message in stderr. stderr:\n${result.stderr}`,
		);
		assert.ok(
			result.stderr.includes("Failed to list user task"),
			`expected framework prefix 'Failed to list user task' in stderr, proving the error flowed through handleCommandError instead of process.exit(1). stderr:\n${result.stderr}`,
		);
	});
});

describe("run: behavioural — unextractable process id flows through the framework", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "c8ctl-run-errors-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test("BPMN file with no <process id=…>: 'Failed to run' framework prefix appears", async () => {
		// BPMN with definitions but no <process> — extractProcessId returns null.
		const bpmnPath = join(tempDir, "no-process-id.bpmn");
		writeFileSync(
			bpmnPath,
			`<?xml version="1.0" encoding="UTF-8"?>\n<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Definitions_1" targetNamespace="http://bpmn.io/schema/bpmn"/>\n`,
		);

		const result = await c8("run", bpmnPath);

		assert.strictEqual(
			result.status,
			1,
			`expected exit 1, got ${result.status}. stderr:\n${result.stderr}`,
		);
		assert.ok(
			result.stderr.includes("Could not extract process ID from BPMN file"),
			`expected original error message in stderr. stderr:\n${result.stderr}`,
		);
		// Post-#288: the run handler throws plain `Error` and the
		// framework's `handleCommandError` wrapper renders the prefix
		// using the verb (resource is empty for the resourceless `run`
		// command), so the prefix is "Failed to run". This proves the
		// error flowed through the centralised framework wrapper rather
		// than terminating the process directly via `process.exit(1)`.
		assert.ok(
			result.stderr.includes("Failed to run"),
			`expected framework prefix 'Failed to run' in stderr, proving the error flowed through handleCommandError instead of process.exit(1). stderr:\n${result.stderr}`,
		);
	});
});
