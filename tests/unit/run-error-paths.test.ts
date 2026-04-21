/**
 * Structural and behavioural guards for `src/commands/run.ts`, ahead of the
 * #288 refactor that inlines the legacy `run()` body into the
 * `defineCommand` handler.
 *
 * Two layers:
 *
 *  1. Structural — the AST-level guard that pins zero `process.exit(...)`
 *     in `run.ts`. Mirrors `deploy-error-paths.test.ts` so the same
 *     class-of-defect rule applies to both side-effectful commands.
 *     If the refactor (or a future contributor) reintroduces
 *     `process.exit(...)` instead of throwing, this fails immediately.
 *
 *  2. Behavioural — the existing class-scoped guard for the
 *     unextractable-process-id error path lives in
 *     `round-1-error-paths.test.ts`. We do NOT duplicate it here.
 *     Argument-forwarding (`ctx.resource` → `path`) is implicitly
 *     pinned by that test, since the path has to flow through the
 *     handler for the BPMN-parsing error to fire.
 *
 * Pre-#288 baseline: the `run.ts` source already contains zero
 * `process.exit(...)` calls (its error paths route through
 * `handleCommandError`), so this structural guard is currently green.
 * It exists to *stay* green across the refactor.
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
