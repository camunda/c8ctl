/**
 * Architectural import-boundary guard for issue #291 (follow-up to
 * #288 — normalise command handler architecture).
 *
 * Invariant
 * ---------
 *
 * No file under `tests/**` imports a runtime value from
 * `src/commands/**`. Tests must drive commands via the `c8()`
 * subprocess helper. Type-only imports (`import type { ... }`) are
 * permitted because they have no runtime coupling.
 *
 * Why
 * ---
 *
 * Direct value imports of handlers (or handler-shaped helpers like
 * `handleAssign`) couple tests to internal call shapes, hide bugs
 * that only manifest end-to-end through the dispatch chain (flag
 * parsing, validation, dry-run helper, error rendering), and made
 * the #288 migrations harder than they needed to be. AGENTS.md
 * codifies this rule:
 *
 *   > In any test, only use the implemented CLI commands to interact
 *   > with the system. Avoid using internal functions or direct API
 *   > calls in tests, as this can lead to brittle tests that are
 *   > tightly coupled to the implementation.
 *
 * Staged rollout
 * --------------
 *
 * The `PENDING_MIGRATION` allow-list below names every test file that
 * currently violates the boundary. The list is **closed** — it cannot
 * grow. Adding a new test that imports from `src/commands/**` will
 * fail this guard. Each entry is removed as the file is migrated to
 * the `c8()` subprocess pattern; once empty, the rule becomes
 * unconditional and this comment block can be retired (mirroring the
 * pattern that `tests/unit/no-process-exit-in-handlers.test.ts` used
 * during the #288 rollout).
 *
 * Detection
 * ---------
 *
 * AST-based via the TypeScript compiler API so:
 *   - `import type { X } from "..."` is correctly excluded.
 *   - `import { type X } from "..."` is correctly excluded
 *     (type-only specifier).
 *   - String literals containing `from "../../src/commands/..."`
 *     and commented-out imports do not produce false positives.
 *   - Both `../../src/commands/...` and `../../../src/commands/...`
 *     forms (any depth of `..`) are caught.
 */

import assert from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, test } from "node:test";
import ts from "typescript";

const PROJECT_ROOT = resolve(import.meta.dirname, "..", "..");
const TESTS_DIR = join(PROJECT_ROOT, "tests");

/**
 * Closed allow-list of test files that currently import runtime
 * values from `src/commands/**`. New violations are rejected. This
 * list shrinks as files are migrated to the `c8()` subprocess
 * pattern; when it reaches zero, delete the allow-list entirely
 * and let the rule be unconditional.
 *
 * Paths are workspace-relative POSIX paths under `tests/`.
 */
const PENDING_MIGRATION: ReadonlySet<string> = new Set([
	"integration/deploy.test.ts",
	"integration/mcp-proxy-mock.test.ts",
	"integration/process-instances.test.ts",
	"integration/watch.test.ts",
	"unit/completion-install.test.ts",
	"unit/completion.test.ts",
	"unit/help.test.ts",
	"unit/identity.test.ts",
	"unit/mcp-proxy-auth.test.ts",
	"unit/mcp-proxy.test.ts",
	"unit/open.test.ts",
	"unit/plugins-version.test.ts",
	"unit/search-feedback.test.ts",
	"unit/search-wildcard.test.ts",
]);

function listTestFiles(): string[] {
	const out: string[] = [];
	function walk(dir: string): void {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const abs = join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(abs);
			} else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
				out.push(abs);
			}
		}
	}
	walk(TESTS_DIR);
	return out;
}

/** Workspace-relative POSIX path under `tests/`. */
function toTestsRelative(absPath: string): string {
	return relative(TESTS_DIR, absPath).split(/[\\/]/).join("/");
}

/**
 * Returns true iff the import declaration imports any runtime value
 * from a `src/commands/**` module. `import type { ... } from ...`
 * is excluded; an inline `import { type X } from ...` is excluded
 * only if EVERY specifier is `type`.
 */
function isRuntimeCommandsImport(node: ts.ImportDeclaration): boolean {
	if (node.importClause?.isTypeOnly) return false;

	const moduleSpec = node.moduleSpecifier;
	if (!ts.isStringLiteral(moduleSpec)) return false;
	const spec = moduleSpec.text;
	// Match relative paths into src/commands/, regardless of `..` depth.
	if (!/^(?:\.\.\/)+src\/commands\//.test(spec)) return false;

	const clause = node.importClause;
	if (!clause) {
		// Side-effect import `import "../../src/commands/x"` — runtime.
		return true;
	}

	const namedBindings = clause.namedBindings;
	if (
		namedBindings !== undefined &&
		ts.isNamedImports(namedBindings) &&
		namedBindings.elements.length > 0 &&
		namedBindings.elements.every((el) => el.isTypeOnly) &&
		clause.name === undefined
	) {
		// All specifiers individually marked `type` and no default
		// import alongside → no runtime import.
		return false;
	}

	return true;
}

interface Violation {
	file: string;
	line: number;
	specifier: string;
}

function findViolations(absPath: string): Violation[] {
	const source = readFileSync(absPath, "utf8");
	const sf = ts.createSourceFile(
		absPath,
		source,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
	const out: Violation[] = [];
	for (const stmt of sf.statements) {
		if (!ts.isImportDeclaration(stmt)) continue;
		if (!isRuntimeCommandsImport(stmt)) continue;
		const moduleSpec = stmt.moduleSpecifier;
		const { line } = sf.getLineAndCharacterOfPosition(moduleSpec.getStart(sf));
		out.push({
			file: toTestsRelative(absPath),
			line: line + 1,
			specifier: ts.isStringLiteral(moduleSpec) ? moduleSpec.text : "",
		});
	}
	return out;
}

describe("architectural guard: tests must not import handlers from src/commands/** (#291)", () => {
	const files = listTestFiles();

	test("no test file imports runtime values from src/commands/** (except those on the closed PENDING_MIGRATION allow-list)", () => {
		const newViolations: Violation[] = [];
		const seenAllowlisted = new Set<string>();

		for (const abs of files) {
			const rel = toTestsRelative(abs);
			const v = findViolations(abs);
			if (v.length === 0) continue;
			if (PENDING_MIGRATION.has(rel)) {
				seenAllowlisted.add(rel);
				continue;
			}
			newViolations.push(...v);
		}

		assert.strictEqual(
			newViolations.length,
			0,
			`Test files must not import runtime values from src/commands/**. ` +
				`Drive commands via the \`c8()\` subprocess helper instead. ` +
				`Found ${newViolations.length} new violation(s):\n` +
				newViolations
					.map((v) => `  - tests/${v.file}:${v.line} — from "${v.specifier}"`)
					.join("\n") +
				`\n\nIf you have intentionally migrated a file off the allow-list, ` +
				`remove it from PENDING_MIGRATION in this file. ` +
				`See AGENTS.md → "Command handler shape" for the canonical pattern.`,
		);

		// Pin the allow-list shape: every entry must currently violate.
		// If an entry no longer violates, the maintainer should remove
		// it from PENDING_MIGRATION (this is how the list shrinks to
		// zero).
		const stale = [...PENDING_MIGRATION].filter((f) => !seenAllowlisted.has(f));
		assert.strictEqual(
			stale.length,
			0,
			`PENDING_MIGRATION contains entries that no longer violate the ` +
				`import boundary. Remove them so the allow-list keeps shrinking:\n` +
				stale.map((f) => `  - ${f}`).join("\n"),
		);
	});
});
