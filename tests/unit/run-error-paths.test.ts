/**
 * Class-of-defect regression guard for `c8 run` error paths.
 *
 * This file is the green/green prep work for issue #288: before the
 * refactor that inlines `run()`'s body into the `defineCommand`
 * handler, lock in the structural invariant the refactor must
 * preserve.
 *
 * Existing prep coverage (already on main):
 *
 *   - `tests/unit/round-1-error-paths.test.ts` covers the
 *     "BPMN file with no <process id>" path and asserts the
 *     "Failed to run process" framework prefix appears (proving the
 *     throw replaced what used to be `process.exit(1)`).
 *   - `tests/unit/form-topology-run-behaviour.test.ts` covers the
 *     dry-run JSON shape (POST, both endpoints, path/variables in
 *     body), missing-path usage error, unsupported-extension
 *     rejection, and `--force` bypass.
 *
 * Gap this file fills:
 *
 *   STRUCTURAL guard — AST scan over `src/commands/run.ts` for
 *   zero `process.exit(...)` calls. Mirrors the structural part of
 *   `tests/unit/deploy-error-paths.test.ts`. Any future regression
 *   that adds a `process.exit(...)` call into `run.ts` fails here
 *   immediately, without needing to construct a CLI scenario for
 *   the new code path. AST-based (not regex) so string literals
 *   containing `process.exit(` and stripped-comment edge cases
 *   cannot produce false positives or false negatives.
 *
 * Note on `--variables` invalid-JSON path: a behavioural guard for
 * this path was attempted but cannot be unit-tested against the
 * current shape of `run.ts` — the legacy code parses `--variables`
 * AFTER the deploy network call, so the bad-JSON path is unreachable
 * without a live Camunda server. The `--dry-run` early-return at
 * the top of `run()` also bypasses variable parsing. This is itself
 * a class of defect #288's refactor should address (validate up
 * front, before any I/O); pinning a behavioural guard for that path
 * belongs in the post-refactor PR alongside the move that makes it
 * reachable.
 */

import assert from "node:assert";
import { join, resolve } from "node:path";
import { describe, test } from "node:test";
import { findProcessExitCalls } from "../utils/no-process-exit.ts";

const PROJECT_ROOT = resolve(import.meta.dirname, "..", "..");
const RUN_TS = join(PROJECT_ROOT, "src", "commands", "run.ts");

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
