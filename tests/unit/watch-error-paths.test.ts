/**
 * Class-of-defect regression guard for `c8 watch` error paths.
 *
 * Status of `watch` for issue #288:
 *
 *   `src/commands/watch.ts` is **already #288-compliant at the file
 *   level**: the handler body lives directly inside
 *   `defineCommand("watch", "", ...)`, uses `ctx.logger`,
 *   `ctx.profile`, and `ctx.resource`/`ctx.positionals` from the
 *   framework context, returns `{ kind: "never" }` for the
 *   long-running case, throws on validation errors instead of
 *   calling `process.exit(...)`, and lets the framework own the
 *   process exit code.
 *
 *   The migration that #288 prescribes for `watch` is therefore the
 *   no-op shape it already has. This file pins that shape so it
 *   cannot drift back. The handler additionally carries an
 *   in-source comment block at the SIGINT site explaining why it
 *   deliberately does NOT call `process.exit(...)` — this guard
 *   exists so any future edit that contradicts that comment fails
 *   loudly in CI.
 *
 * Strong existing behavioural coverage on main (don't duplicate here):
 *
 *   - `tests/integration/watch.test.ts` — file detection, debounce,
 *     cooldown, ignore rules, extension filtering, banner ordering.
 *   - `tests/integration/watch-lifecycle.test.ts` — readiness banner
 *     ordering vs SIGINT handler / fs.watch registration (the #325
 *     race fix: banner is emitted ONLY AFTER both watchers and the
 *     SIGINT handler are registered, so test polling on the banner
 *     is a valid readiness signal).
 *   - `tests/integration/watch-cancellation.test.ts` — SIGINT cancels
 *     pending debounce timers, aborts in-flight deploys via
 *     AbortController, and the framework returns naturally with exit
 *     code 0.
 *   - `tests/unit/watch-force.test.ts` — `--force` flag unit coverage,
 *     plus the force-mode case in `tests/integration/watch.test.ts`
 *     for end-to-end "continue watching after deployment errors".
 *
 * Guard in this file:
 *
 *   STRUCTURAL — AST scan over `src/commands/watch.ts` for zero
 *   `process.exit(...)` call expressions. Mirrors the structural part
 *   of `tests/unit/deploy-error-paths.test.ts`,
 *   `tests/unit/run-error-paths.test.ts`,
 *   `tests/unit/open-error-paths.test.ts`, and
 *   `tests/unit/mcp-proxy-error-paths.test.ts`. AST-based (not regex)
 *   so the existing in-source comment "We deliberately do NOT call
 *   `process.exit()` here" is correctly distinguished from a real
 *   call and does not cause a false positive.
 */

import assert from "node:assert";
import { join, resolve } from "node:path";
import { describe, test } from "node:test";
import { findProcessExitCalls } from "../utils/no-process-exit.ts";

const PROJECT_ROOT = resolve(import.meta.dirname, "..", "..");
const WATCH_TS = join(PROJECT_ROOT, "src", "commands", "watch.ts");

describe("watch: structural guard — no process.exit in watch.ts", () => {
	test("src/commands/watch.ts contains no `process.exit(...)` calls", () => {
		const calls = findProcessExitCalls(WATCH_TS);
		assert.strictEqual(
			calls.length,
			0,
			`Expected zero \`process.exit(...)\` calls in watch.ts, found ${calls.length}:\n` +
				calls
					.map((c) => `  - line ${c.line}:${c.column} — ${c.text}`)
					.join("\n") +
				`\n\nThe SIGINT handler in watch.ts deliberately drains the event loop\n` +
				`(closes watchers, clears debounce timers, aborts in-flight deploys)\n` +
				`and resolves the lifecycle promise so the framework returns naturally\n` +
				`with \`{ kind: "never" }\` and owns the exit code. See the comment\n` +
				`block above the \`await new Promise<void>((resolveSignal) => ...)\`\n` +
				`call in src/commands/watch.ts for the full rationale.`,
		);
	});
});
