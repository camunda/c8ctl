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
 *   - **Dynamic imports** (`await import("../../src/commands/...")`)
 *     and CommonJS `require("../../src/commands/...")` calls are
 *     also caught — the AST is walked recursively, not just the
 *     top-level statement list.
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
	"integration/profile-switching.test.ts",
	"unit/identity.test.ts",
]);

function listTestFiles(): string[] {
	const out: string[] = [];
	function walk(dir: string): void {
		// Sort entries so diagnostics order is stable across OS/filesystems
		// (CI runs on both Ubuntu and macOS, which differ in readdir order).
		const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
			a.name.localeCompare(b.name),
		);
		for (const entry of entries) {
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
	if (!isCommandsSpecifier(spec)) return false;

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

/** True iff `spec` is a relative path into `src/commands` or a descendant. */
function isCommandsSpecifier(spec: string): boolean {
	// Match relative paths into src/commands, regardless of `..` depth,
	// allowing an optional leading `./` and either the directory itself
	// (`../../src/commands`) or any child path beneath it
	// (`../../src/commands/foo.ts`).
	return /^(?:\.\/)?(?:\.\.\/)+src\/commands(?:\/|$)/.test(spec);
}

/**
 * True iff `node` is a dynamic `import("...")` or CommonJS
 * `require("...")` call whose argument is a string literal pointing
 * into `src/commands/**`. Both are runtime couplings — no equivalent
 * of `import type` exists for either form.
 */
function isRuntimeCommandsCall(node: ts.CallExpression): boolean {
	const arg0 = node.arguments[0];
	if (!arg0 || !ts.isStringLiteral(arg0)) return false;
	if (!isCommandsSpecifier(arg0.text)) return false;

	// Dynamic import: `import(...)` parses to a CallExpression whose
	// expression has SyntaxKind.ImportKeyword.
	if (node.expression.kind === ts.SyntaxKind.ImportKeyword) return true;

	// CommonJS `require(...)`.
	if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
		return true;
	}

	return false;
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

	const record = (specNode: ts.Node, specText: string): void => {
		const { line } = sf.getLineAndCharacterOfPosition(specNode.getStart(sf));
		out.push({
			file: toTestsRelative(absPath),
			line: line + 1,
			specifier: specText,
		});
	};

	const visit = (node: ts.Node): void => {
		// Static `import` declarations only appear at the top level of a
		// source file, but visit them via the same walk for symmetry.
		if (ts.isImportDeclaration(node) && isRuntimeCommandsImport(node)) {
			const moduleSpec = node.moduleSpecifier;
			record(moduleSpec, ts.isStringLiteral(moduleSpec) ? moduleSpec.text : "");
		} else if (ts.isCallExpression(node) && isRuntimeCommandsCall(node)) {
			const arg0 = node.arguments[0];
			if (ts.isStringLiteral(arg0)) record(arg0, arg0.text);
		}
		ts.forEachChild(node, visit);
	};
	visit(sf);

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
