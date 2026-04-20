/**
 * Architectural class-of-defect guard for issue #288.
 *
 * Every command handler in `src/commands/**.ts` routes termination
 * through the framework's `handleCommandError` pipeline (i.e. via
 * `throw`), never through a direct `process.exit(...)` call. This
 * preserves two invariants for the whole CLI:
 *
 *   1. `--verbose` can rethrow any error to surface a stack trace.
 *   2. The framework consistently formats failures with command
 *      context (`Failed to <verb> <resource>: <message>`).
 *
 * The #288 migration completed in PR #306 — the `PENDING_MIGRATION`
 * allow-list that staged the rollout has been retired. The rule is
 * now unconditional: zero `process.exit(...)` calls in
 * `src/commands/**.ts`. If you find yourself reintroducing one,
 * throw an `Error` instead and let the framework wrapper handle
 * termination.
 *
 * AST-based (not regex) so string literals containing
 * `process.exit(`, comments mentioning the pattern, and
 * commented-out code cannot produce false positives or false
 * negatives. See `tests/utils/no-process-exit.ts`.
 */

import assert from "node:assert";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, test } from "node:test";
import { findProcessExitCalls } from "../utils/no-process-exit.ts";

const PROJECT_ROOT = resolve(import.meta.dirname, "..", "..");
const COMMANDS_DIR = join(PROJECT_ROOT, "src", "commands");

function listCommandFiles(): string[] {
	return readdirSync(COMMANDS_DIR)
		.filter((name) => name.endsWith(".ts"))
		.map((name) => join(COMMANDS_DIR, name));
}

/** Convert an absolute path under PROJECT_ROOT to a workspace-relative
 * POSIX path for stable diagnostic output. */
function toRelative(absPath: string): string {
	const rel = absPath.slice(PROJECT_ROOT.length + 1);
	return rel.split(/[\\/]/).join("/");
}

describe("architectural guard: command handlers must throw, not process.exit (#288)", () => {
	const files = listCommandFiles();

	test("no command handler contains `process.exit(...)`", () => {
		const violations: { file: string; line: number; text: string }[] = [];
		for (const abs of files) {
			for (const call of findProcessExitCalls(abs)) {
				violations.push({
					file: toRelative(abs),
					line: call.line,
					text: call.text,
				});
			}
		}
		assert.strictEqual(
			violations.length,
			0,
			`Command handler files must not contain \`process.exit(...)\` calls. ` +
				`Found ${violations.length}:\n` +
				violations
					.map((v) => `  - ${v.file}:${v.line} — ${v.text}`)
					.join("\n") +
				`\n\nEvery error path must throw so the framework's handleCommandError ` +
				`pipeline owns process termination.`,
		);
	});
});
