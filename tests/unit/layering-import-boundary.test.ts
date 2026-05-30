/**
 * Architectural import-boundary guard: the `src/` layered architecture.
 *
 * Invariant
 * ---------
 *
 * `src/` is organised into layers with a strict, acyclic dependency
 * hierarchy (issue #414):
 *
 *   composition root (src/*.ts)  →  commands  →  framework  →  core
 *                                       ↘──────────↓──────────↗
 *                                              utils (leaf)
 *
 * Concretely, a file in each layer may only import (runtime or
 * type-only) from the layers below it:
 *
 *   - core/      → core only
 *   - utils/     → core, utils            (leaf: never framework/commands)
 *   - framework/ → core, utils, framework (never commands)
 *   - commands/  → core, utils, framework, commands
 *   - src/*.ts   → anything               (composition root: index.ts,
 *                                          command-dispatch.ts)
 *
 * This keeps the dependency graph acyclic and prevents the layering
 * from silently rotting back into a flat structure. If you hit a
 * violation, the fix is almost always to move the shared code *down*
 * to the lowest layer that needs it — not to widen the rule.
 *
 * Detection
 * ---------
 *
 * AST-based via the TypeScript compiler API. Static `import` /
 * `export ... from`, and dynamic `import()` / `require()` are all
 * caught. Only relative specifiers are inspected (bare package
 * specifiers are external and irrelevant). Comments and unrelated
 * string literals cannot produce false positives.
 */

import assert from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { describe, test } from "node:test";
import ts from "typescript";

const PROJECT_ROOT = resolve(import.meta.dirname, "..", "..");
const SRC_DIR = resolve(PROJECT_ROOT, "src");

type Layer = "core" | "utils" | "framework" | "commands" | "root";

/** Each layer maps to the set of layers it is allowed to import from. */
const ALLOWED: Record<Layer, ReadonlySet<Layer>> = {
	core: new Set<Layer>(["core"]),
	utils: new Set<Layer>(["core", "utils"]),
	framework: new Set<Layer>(["core", "utils", "framework"]),
	commands: new Set<Layer>(["core", "utils", "framework", "commands"]),
	// The composition root (index.ts, command-dispatch.ts) wires every
	// layer together and is intentionally unconstrained.
	root: new Set<Layer>(["core", "utils", "framework", "commands", "root"]),
};

/** Determine which layer an absolute path under src/ belongs to. */
function layerOf(absPath: string): Layer {
	const rel = relative(SRC_DIR, absPath).split(/[\\/]/).join("/");
	if (rel.startsWith("core/")) return "core";
	if (rel.startsWith("utils/")) return "utils";
	if (rel.startsWith("framework/")) return "framework";
	if (rel.startsWith("commands/")) return "commands";
	return "root";
}

/** Recursively list all `.ts` files under `dir`, sorted. */
function listTsFiles(dir: string): string[] {
	const out: string[] = [];
	function walk(d: string): void {
		const entries = readdirSync(d, { withFileTypes: true }).sort((a, b) =>
			a.name.localeCompare(b.name),
		);
		for (const entry of entries) {
			const abs = resolve(d, entry.name);
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

/** Workspace-relative POSIX path. */
function toRelative(absPath: string): string {
	return relative(PROJECT_ROOT, absPath).split(/[\\/]/).join("/");
}

interface Violation {
	file: string;
	fromLayer: Layer;
	line: number;
	specifier: string;
	toLayer: Layer;
}

function findViolations(absPath: string): Violation[] {
	const fromLayer = layerOf(absPath);
	const allowed = ALLOWED[fromLayer];
	const source = readFileSync(absPath, "utf8");
	const sf = ts.createSourceFile(
		absPath,
		source,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
	const out: Violation[] = [];

	const check = (specNode: ts.Node, spec: string): void => {
		// Only relative specifiers point inside src/.
		if (!spec.startsWith(".")) return;
		const target = resolve(dirname(absPath), spec);
		// Ignore imports that resolve outside src/ (e.g. into tests/ — none
		// today — or sibling roots). Those are not layer edges.
		const rel = relative(SRC_DIR, target);
		if (rel.startsWith("..")) return;
		const toLayer = layerOf(target);
		if (!allowed.has(toLayer)) {
			const { line } = sf.getLineAndCharacterOfPosition(specNode.getStart(sf));
			out.push({
				file: toRelative(absPath),
				fromLayer,
				line: line + 1,
				specifier: spec,
				toLayer,
			});
		}
	};

	const visit = (node: ts.Node): void => {
		if (
			ts.isImportDeclaration(node) &&
			ts.isStringLiteral(node.moduleSpecifier)
		) {
			check(node.moduleSpecifier, node.moduleSpecifier.text);
		} else if (
			ts.isExportDeclaration(node) &&
			node.moduleSpecifier &&
			ts.isStringLiteral(node.moduleSpecifier)
		) {
			check(node.moduleSpecifier, node.moduleSpecifier.text);
		} else if (ts.isCallExpression(node)) {
			const arg0 = node.arguments[0];
			if (arg0 && ts.isStringLiteral(arg0)) {
				const isDynamic = node.expression.kind === ts.SyntaxKind.ImportKeyword;
				const isRequire =
					ts.isIdentifier(node.expression) &&
					node.expression.text === "require";
				if (isDynamic || isRequire) check(arg0, arg0.text);
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sf);

	return out;
}

describe("architectural guard: src/ layered architecture (#414)", () => {
	const files = listTsFiles(SRC_DIR);

	test("each layer only imports from layers at or below it", () => {
		const violations: Violation[] = [];
		for (const abs of files) {
			violations.push(...findViolations(abs));
		}

		assert.strictEqual(
			violations.length,
			0,
			`Found ${violations.length} cross-layer import violation(s):\n${violations
				.map(
					(v) =>
						`  ${v.file}:${v.line}  (${v.fromLayer} → ${v.toLayer})  →  ${v.specifier}`,
				)
				.join(
					"\n",
				)}\n\nFix by moving the shared code down to the lowest layer that needs it, not by widening the rule.`,
		);
	});
});
