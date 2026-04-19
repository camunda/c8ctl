/**
 * Architectural class-of-defect guard for issue #288.
 *
 * Goal: every command handler in `src/commands/**.ts` routes
 * termination through the framework's `handleCommandError` pipeline
 * (i.e. via `throw`), never through a direct `process.exit(...)`
 * call. This preserves two invariants for the whole CLI:
 *
 *   1. `--verbose` can rethrow any error to surface a stack trace.
 *   2. The framework consistently formats failures with command
 *      context (`Failed to <verb> <resource>: <message>`).
 *
 * Because issue #288 is a multi-PR migration, we lock in the
 * direction of travel with a SHRINKING ALLOW-LIST:
 *
 *   - Files in `PENDING_MIGRATION` may still contain
 *     `process.exit(...)` calls (this is what the migration is
 *     fixing).
 *   - Every other file in `src/commands/**.ts` must contain ZERO
 *     `process.exit(...)` calls.
 *   - When a handler is migrated, its entry is REMOVED from the
 *     allow-list in the same PR.
 *   - When the allow-list is empty, issue #288 is complete and the
 *     architectural rule is fully locked in. At that point the
 *     allow-list and its plumbing should be deleted in favour of an
 *     unconditional ban.
 *
 * The test fails in TWO directions:
 *
 *   a) A file outside the allow-list contains `process.exit(...)` —
 *      a regression. (E.g. someone reintroduced `process.exit(1)`
 *      into deployments.ts.)
 *   b) A file inside the allow-list contains ZERO
 *      `process.exit(...)` calls — the file has already been
 *      migrated and the allow-list is stale. Remove the entry.
 *
 * Direction (b) is what makes the allow-list a checklist instead of
 * a graveyard: stale entries cannot accumulate.
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

/**
 * Files that have NOT yet been migrated off `process.exit(...)`.
 *
 * Remove an entry in the same PR that migrates its handler. When
 * this set is empty, delete it and turn the test into an
 * unconditional rule across all of `src/commands/**.ts`.
 *
 * Each path is workspace-relative for stable grep/diff readability.
 */
const PENDING_MIGRATION: ReadonlySet<string> = new Set([
	"src/commands/completion.ts",
	"src/commands/identity-mapping-rules.ts",
	"src/commands/identity.ts",
	"src/commands/jobs.ts",
	"src/commands/plugins.ts",
	"src/commands/process-instances.ts",
	"src/commands/profiles.ts",
	"src/commands/search.ts",
	"src/commands/session.ts",
]);

function listCommandFiles(): string[] {
	return readdirSync(COMMANDS_DIR)
		.filter((name) => name.endsWith(".ts"))
		.map((name) => join(COMMANDS_DIR, name));
}

/** Convert an absolute path under PROJECT_ROOT to a workspace-relative
 * POSIX path (the form used in `PENDING_MIGRATION`). */
function toRelative(absPath: string): string {
	const rel = absPath.slice(PROJECT_ROOT.length + 1);
	return rel.split(/[\\/]/).join("/");
}

describe("architectural guard: command handlers must throw, not process.exit (#288)", () => {
	const files = listCommandFiles();

	test("PENDING_MIGRATION lists only files that exist", () => {
		const onDisk = new Set(files.map(toRelative));
		const stale = [...PENDING_MIGRATION].filter((p) => !onDisk.has(p));
		assert.deepStrictEqual(
			stale,
			[],
			`PENDING_MIGRATION references files that no longer exist: ${stale.join(", ")}. ` +
				`Remove these entries.`,
		);
	});

	test("no migrated handler reintroduces `process.exit(...)`", () => {
		const violations: { file: string; line: number; text: string }[] = [];
		for (const abs of files) {
			const rel = toRelative(abs);
			if (PENDING_MIGRATION.has(rel)) continue;
			for (const call of findProcessExitCalls(abs)) {
				violations.push({ file: rel, line: call.line, text: call.text });
			}
		}
		assert.strictEqual(
			violations.length,
			0,
			`Migrated handler files must not contain \`process.exit(...)\` calls. ` +
				`Found ${violations.length}:\n` +
				violations
					.map((v) => `  - ${v.file}:${v.line} — ${v.text}`)
					.join("\n") +
				`\n\nEvery error path must throw so the framework's handleCommandError ` +
				`pipeline owns process termination. If this is genuinely a new ` +
				`pre-migration handler, add it to PENDING_MIGRATION in this file.`,
		);
	});

	test("PENDING_MIGRATION entries actually still contain `process.exit(...)`", () => {
		// Direction (b) above: a stale allow-list entry is its own kind
		// of regression. If a file has been migrated but its entry was
		// not removed, the allow-list silently keeps protecting a file
		// that no longer needs protection — and the next reviewer might
		// keep relying on it. Catch that here so the allow-list shrinks
		// monotonically and never accumulates dead entries.
		const stale: string[] = [];
		for (const rel of PENDING_MIGRATION) {
			const abs = join(PROJECT_ROOT, rel);
			if (findProcessExitCalls(abs).length === 0) {
				stale.push(rel);
			}
		}
		assert.deepStrictEqual(
			stale,
			[],
			`PENDING_MIGRATION contains entries that have already been migrated ` +
				`(no \`process.exit(...)\` remains): ${stale.join(", ")}. ` +
				`Remove these entries from PENDING_MIGRATION in the same PR ` +
				`that migrated them.`,
		);
	});
});
