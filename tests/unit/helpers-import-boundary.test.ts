/**
 * Architectural import-boundary guard: `src/commands/helpers/` is
 * internal to `src/commands/`.
 *
 * Invariant
 * ---------
 *
 * No file outside `src/commands/` imports (runtime or type-only)
 * from `src/commands/helpers/**`. The helpers directory is a private
 * implementation detail of the command handlers — shared logic that
 * multiple handlers need but that has no business leaking into the
 * framework, config, or CLI entry point.
 *
 * If you need something from helpers outside commands/, either:
 *   1. Promote it to a top-level `src/` module, or
 *   2. Re-export it through a command module's public surface.
 *
 * Detection
 * ---------
 *
 * AST-based via the TypeScript compiler API. Both static `import`
 * declarations and dynamic `import()` / `require()` calls are
 * caught. Comments and string literals cannot produce false
 * positives.
 */

import assert from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, test } from "node:test";
import ts from "typescript";

const PROJECT_ROOT = resolve(import.meta.dirname, "..", "..");
const SRC_DIR = join(PROJECT_ROOT, "src");
const COMMANDS_DIR = join(SRC_DIR, "commands");

/** Recursively list all `.ts` files under `dir`. */
function listTsFiles(dir: string): string[] {
	const out: string[] = [];
	function walk(d: string): void {
		const entries = readdirSync(d, { withFileTypes: true }).sort((a, b) =>
			a.name.localeCompare(b.name),
		);
		for (const entry of entries) {
			const abs = join(d, entry.name);
			if (entry.isDirectory()) {
				walk(abs);
			} else if (entry.isFile() && entry.name.endsWith(".ts")) {
				out.push(abs);
			}
		}
	}
	walk(dir);
	return out;
}

/** True iff `absPath` is under `src/commands/` (at any depth). */
function isUnderCommands(absPath: string): boolean {
	const norm = absPath.split(/[\\/]/).join("/");
	const commandsNorm = COMMANDS_DIR.split(/[\\/]/).join("/");
	return norm.startsWith(`${commandsNorm}/`);
}

/** Workspace-relative POSIX path. */
function toRelative(absPath: string): string {
	return relative(PROJECT_ROOT, absPath).split(/[\\/]/).join("/");
}

/**
 * True iff `spec` is a relative import path that resolves into
 * `commands/helpers/`. Only matches specifiers starting with `.`
 * (relative paths), not bare package specifiers. Patterns:
 *   - `./helpers/deploy-helpers.ts` (from within commands/)
 *   - `../commands/helpers/deploy-helpers.ts` (from src/)
 *   - `../../src/commands/helpers/deploy-helpers.ts` (from tests/)
 */
function isHelpersSpecifier(spec: string): boolean {
	return (
		spec.startsWith(".") && /(?:^|\/|\\)commands\/helpers(?:\/|$)/.test(spec)
	);
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
			file: toRelative(absPath),
			line: line + 1,
			specifier: specText,
		});
	};

	const visit = (node: ts.Node): void => {
		if (ts.isImportDeclaration(node)) {
			const moduleSpec = node.moduleSpecifier;
			if (
				ts.isStringLiteral(moduleSpec) &&
				isHelpersSpecifier(moduleSpec.text)
			) {
				record(moduleSpec, moduleSpec.text);
			}
		} else if (ts.isCallExpression(node)) {
			const arg0 = node.arguments[0];
			if (arg0 && ts.isStringLiteral(arg0) && isHelpersSpecifier(arg0.text)) {
				const isDynamic = node.expression.kind === ts.SyntaxKind.ImportKeyword;
				const isRequire =
					ts.isIdentifier(node.expression) &&
					node.expression.text === "require";
				if (isDynamic || isRequire) {
					record(arg0, arg0.text);
				}
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sf);

	return out;
}

describe("architectural guard: src/commands/helpers/ is internal to src/commands/", () => {
	// Only scan src/ files outside commands/. Test files are already
	// guarded by test-import-boundary.test.ts (no runtime imports
	// from src/commands/** at all).
	const files = listTsFiles(SRC_DIR).filter((f) => !isUnderCommands(f));

	test("no file outside src/commands/ imports from src/commands/helpers/", () => {
		const violations: Violation[] = [];
		for (const abs of files) {
			violations.push(...findViolations(abs));
		}

		assert.strictEqual(
			violations.length,
			0,
			`Found ${violations.length} import(s) from src/commands/helpers/ outside src/commands/:\n${violations
				.map((v) => `  ${v.file}:${v.line}  →  ${v.specifier}`)
				.join(
					"\n",
				)}\n\nEither promote the helper to src/ or consume it only from src/commands/.`,
		);
	});
});
