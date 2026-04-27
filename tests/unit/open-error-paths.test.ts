/**
 * Class-of-defect regression guard for `c8 open` error paths.
 *
 * Status of `open` for issue #288:
 *
 *   `src/commands/open.ts` is **already #288-compliant at the file
 *   level**: the handler body lives directly inside
 *   `defineCommand("open", "", ...)`, uses `ctx.dryRun` /
 *   `ctx.logger` / `ctx.profile` / `ctx.resource` from the framework
 *   context, and throws on its only handler-internal error path
 *   (the derive-URL failure for non-self-managed clusters). It does
 *   not call `process.exit(...)` itself.
 *
 *   The migration that #288 prescribes for `open` is therefore the
 *   no-op shape it already has. This file pins that shape so it
 *   cannot drift back.
 *
 * Existing behavioural coverage on main (don't duplicate here):
 *
 *   - `tests/unit/open.test.ts` covers:
 *       * `c8 open` (no app)            → exit 1 + usage hint
 *       * `c8 open <invalid>`           → non-zero exit + "Unknown application"
 *       * `c8 open <app> --dry-run`     → derived URL printed, exit 0
 *       * `c8 open operate --dry-run` against a Cloud-style base URL
 *                                       → "Cannot derive ... self-managed" + non-zero
 *       * Per-`OPEN_APPS` member dry-run URL derivation
 *
 * Guard in this file:
 *
 *   STRUCTURAL — AST scan over `src/commands/open.ts` for zero
 *   `process.exit(...)` calls. Mirrors the structural part of
 *   `tests/unit/deploy-error-paths.test.ts` and
 *   `tests/unit/run-error-paths.test.ts`. Any future regression that
 *   reintroduces a `process.exit(...)` call into `open.ts` fails
 *   here immediately. AST-based (not regex) so string literals
 *   containing `process.exit(` and stripped-comment edge cases
 *   cannot produce false positives or false negatives.
 *
 * Out of scope (separate, wider work — not blocking #288 for `open`):
 *
 *   `src/command-validation.ts` exposes `requirePositional`,
 *   `requireOneOf`, etc., which the `open` handler calls (via
 *   `validateOpenAppOptions`). Those helpers still call
 *   `process.exit(1)` directly on bad input, bypassing the
 *   framework's `handleCommandError` wrapper. That defect is
 *   shared-helper-shaped (it affects every command using those
 *   helpers, not just `open`), so the fix belongs in a dedicated
 *   PR scoped to `command-validation.ts` and its callers, not
 *   bundled into the `open` migration. The structural guard here
 *   only asserts that the `open` handler file itself stays clean.
 */

import assert from "node:assert";
import { join, resolve } from "node:path";
import { describe, test } from "node:test";
import { findProcessExitCalls } from "../utils/no-process-exit.ts";

const PROJECT_ROOT = resolve(import.meta.dirname, "..", "..");
const OPEN_TS = join(PROJECT_ROOT, "src", "commands", "open.ts");

describe("open: structural guard — no process.exit in open.ts", () => {
	test("src/commands/open.ts contains no `process.exit(...)` calls", () => {
		const calls = findProcessExitCalls(OPEN_TS);
		assert.strictEqual(
			calls.length,
			0,
			`Expected zero \`process.exit(...)\` calls in open.ts, found ${calls.length}:\n` +
				calls
					.map((c) => `  - line ${c.line}:${c.column} — ${c.text}`)
					.join("\n") +
				`\n\nEvery error path must throw so the framework's handleCommandError pipeline owns process termination.`,
		);
	});
});
