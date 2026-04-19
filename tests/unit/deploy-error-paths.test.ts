/**
 * Class-of-defect regression guards for `c8 deploy` error paths.
 *
 * Issue #288: every error path in `src/commands/deployments.ts` must
 * `throw`, never `process.exit()`. Bypassing the framework's
 * `handleCommandError` pipeline breaks two invariants:
 *   1. `--verbose` cannot rethrow the error to surface a stack trace.
 *   2. The framework cannot consistently format the failure with
 *      command context.
 *
 * This file pairs a STRUCTURAL guard with BEHAVIOURAL guards:
 *
 *   - Structural: parse `src/commands/deployments.ts` with the
 *     TypeScript compiler and walk the AST for any
 *     `process.exit(...)` CallExpression. Any future regression that
 *     adds a `process.exit(...)` call into the deploy logic fails
 *     here immediately, without needing to construct a CLI scenario
 *     for the new code path. AST-based (not regex) so string
 *     literals containing `process.exit(` and stripped-comment
 *     edge cases cannot produce false positives or false negatives.
 *     This is the durable class-of-defect guard.
 *
 *   - Behavioural: drive the CLI as a subprocess to confirm the
 *     migration actually wires up — when a deploy fails, the
 *     framework's `Failed to ${verb} ${resource}` prefix must appear
 *     in stderr. That prefix is added by `handleCommandError` and
 *     can ONLY appear if the helper threw rather than calling
 *     `process.exit(1)` directly.
 */

import assert from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { c8 } from "../utils/cli.ts";
import { findProcessExitCalls } from "../utils/no-process-exit.ts";

const PROJECT_ROOT = resolve(import.meta.dirname, "..", "..");
const DEPLOYMENTS_TS = join(PROJECT_ROOT, "src", "commands", "deployments.ts");

const DUP_BPMN_TEMPLATE = (
	id: string,
) => `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  id="Definitions_1" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="${id}" isExecutable="true">
    <bpmn:startEvent id="start"/>
  </bpmn:process>
</bpmn:definitions>`;

// `Failed to deploy` — the framework's handleCommandError prefix for
// the deploy verb. This prefix is added BY the framework, so its
// presence in stderr proves the error flowed through
// `handleCommandError` rather than `process.exit(1)`.
const FRAMEWORK_PREFIX = "Failed to deploy";

describe("deploy: structural guard — no process.exit in deployments.ts", () => {
	test("src/commands/deployments.ts contains no `process.exit(...)` calls", () => {
		const calls = findProcessExitCalls(DEPLOYMENTS_TS);
		assert.strictEqual(
			calls.length,
			0,
			`Expected zero \`process.exit(...)\` calls in deployments.ts, found ${calls.length}:\n` +
				calls
					.map((c) => `  - line ${c.line}:${c.column} — ${c.text}`)
					.join("\n") +
				`\n\nEvery error path must throw so the framework's handleCommandError pipeline owns process termination.`,
		);
	});
});

describe("deploy: behavioural — error paths flow through the framework", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "c8ctl-deploy-errors-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test("no deployable files: framework prefix appears (proves throw, not exit)", async () => {
		const emptyDir = join(tempDir, "empty");
		mkdirSync(emptyDir, { recursive: true });

		const result = await c8("deploy", emptyDir);

		assert.strictEqual(
			result.status,
			1,
			`expected exit 1, got ${result.status}. stderr:\n${result.stderr}`,
		);
		assert.ok(
			result.stderr.includes("No BPMN/DMN/Form files found"),
			`expected original error message in stderr. stderr:\n${result.stderr}`,
		);
		assert.ok(
			result.stderr.includes(FRAMEWORK_PREFIX),
			`expected framework prefix '${FRAMEWORK_PREFIX}' in stderr, proving the error flowed through handleCommandError instead of process.exit(1). stderr:\n${result.stderr}`,
		);
	});

	test("duplicate definition IDs: rich pre-rendered error, exit 1, no double-summary", async () => {
		// This path uses `SilentError` by design — the helper pre-renders
		// rich actionable content (per-id file list + guidance), and the
		// framework's `handleCommandError` exits non-zero WITHOUT adding a
		// "Failed to deploy: ..." summary line on top.
		//
		// The structural guard above (zero `process.exit` in deployments.ts)
		// is the durable class-of-defect catch for this path. The behavioural
		// assertions below confirm the SilentError pipeline works:
		//   - exit code 1 (the only signal that *something* terminated us)
		//   - rich pre-rendered detail still emitted
		//   - NO duplicated "Failed to deploy: ..." summary (the framework
		//     prefix is correctly suppressed by SilentError)
		writeFileSync(join(tempDir, "a.bpmn"), DUP_BPMN_TEMPLATE("dup-process"));
		writeFileSync(join(tempDir, "b.bpmn"), DUP_BPMN_TEMPLATE("dup-process"));

		const result = await c8("deploy", tempDir);

		assert.strictEqual(
			result.status,
			1,
			`expected exit 1, got ${result.status}. stderr:\n${result.stderr}`,
		);
		assert.ok(
			result.stderr.includes("Multiple files with the same process") ||
				result.stderr.includes("dup-process"),
			`expected duplicate-id error in stderr. stderr:\n${result.stderr}`,
		);
		assert.ok(
			!result.stderr.includes(FRAMEWORK_PREFIX),
			`SilentError must suppress the framework's '${FRAMEWORK_PREFIX}' summary on top of the pre-rendered rich error. stderr:\n${result.stderr}`,
		);
	});
});
