/**
 * The migration engine (default-plugins/element-template/migration/) must stay
 * liftable into a library: it may import only its own files and must not use
 * the c8ctl runtime.
 */

import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { describe, test } from "node:test";
import ts from "typescript";

const ENGINE_ROOT = resolve(
	import.meta.dirname,
	"../../default-plugins/element-template/migration",
);

function sourceFilesOf(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return sourceFilesOf(path);
		return entry.name.endsWith(".ts") ? [path] : [];
	});
}

/** Every import, export-from, dynamic import and require, as specifier nodes. */
function specifiersOf(source: ts.SourceFile): ts.Expression[] {
	const found: ts.Expression[] = [];
	function visit(node: ts.Node) {
		if (
			(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
			node.moduleSpecifier
		)
			found.push(node.moduleSpecifier);
		else if (
			ts.isCallExpression(node) &&
			(node.expression.kind === ts.SyntaxKind.ImportKeyword ||
				(ts.isIdentifier(node.expression) &&
					node.expression.text === "require")) &&
			node.arguments[0]
		)
			found.push(node.arguments[0]);
		else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
			found.push(node.argument.literal);
		ts.forEachChild(node, visit);
	}
	visit(source);
	return found;
}

/** Violations of the isolation rule under `root`, as readable messages. */
function isolationViolations(root: string): string[] {
	const violations: string[] = [];
	for (const file of sourceFilesOf(root)) {
		const name = relative(root, file);
		const source = ts.createSourceFile(
			name,
			readFileSync(file, "utf8"),
			ts.ScriptTarget.Latest,
			true,
		);
		for (const specifier of specifiersOf(source)) {
			if (!ts.isStringLiteralLike(specifier)) {
				violations.push(`${name}: imports must be statically inspectable`);
				continue;
			}
			const target = resolve(dirname(file), specifier.text);
			if (
				!specifier.text.startsWith(".") ||
				relative(root, target).startsWith("..")
			)
				violations.push(
					`${name}: import escapes the engine: ${specifier.text}`,
				);
		}
		function visit(node: ts.Node) {
			if (ts.isIdentifier(node) && node.text === "c8ctl")
				violations.push(`${name}: engine must not use the CLI runtime`);
			ts.forEachChild(node, visit);
		}
		visit(source);
	}
	return violations;
}

describe("migration engine isolation", () => {
	test("the engine imports only its own files", () => {
		assert.deepEqual(isolationViolations(ENGINE_ROOT), []);
	});

	test("the guard catches escapes from a subfolder, bare and dynamic imports", (t) => {
		const root = mkdtempSync(join(tmpdir(), "c8-isolation-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		mkdirSync(join(root, "sub"));
		writeFileSync(join(root, "ok.ts"), 'import "./sub/x.ts";\n');
		writeFileSync(
			join(root, "sub", "x.ts"),
			[
				'import { a } from "../../helpers.ts";',
				'import { b } from "node:fs";',
				'const c = await import("../../../outside.ts");',
				"const d = globalThis.c8ctl;",
				"",
			].join("\n"),
		);
		assert.deepEqual(isolationViolations(root).sort(), [
			`${join("sub", "x.ts")}: engine must not use the CLI runtime`,
			`${join("sub", "x.ts")}: import escapes the engine: ../../../outside.ts`,
			`${join("sub", "x.ts")}: import escapes the engine: ../../helpers.ts`,
			`${join("sub", "x.ts")}: import escapes the engine: node:fs`,
		]);
	});
});
