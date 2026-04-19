/**
 * AST-based scanner that finds every `process.exit(...)` call in a
 * TypeScript source file.
 *
 * Why AST and not regex: a regex on the file text has two failure
 * modes that are real risks for a class-of-defect guard.
 *
 *   1. False positive: a string literal that happens to contain
 *      `process.exit(` (e.g. an error message that quotes the
 *      violation it warns about, a help string, or a generated
 *      example) would be flagged as a real call site even though it
 *      is just text.
 *   2. False negative: stripping comments with naive regexes can
 *      remove real code if a `//` or `/*` sequence appears inside a
 *      string or template literal — at which point a genuine
 *      `process.exit(...)` next to it can be silently elided.
 *
 * Both failure modes silently break the guarantee the test is
 * trying to provide. The TypeScript parser knows about strings,
 * templates, regex literals, comments, and JSX, so a CallExpression
 * walker over its AST is the only durable shape for this check.
 *
 * The check is for the call form `process.exit(...)` only.
 * `process.exitCode = N` is intentionally NOT flagged — that idiom
 * sets the eventual exit code and lets the event loop drain
 * naturally, which is the correct pattern for handlers that have
 * already done their work.
 */

import { readFileSync } from "node:fs";
import ts from "typescript";

export interface ProcessExitCall {
	/** 1-based line number of the call. */
	line: number;
	/** 1-based column number of the call. */
	column: number;
	/** The full call text, e.g. `process.exit(1)`. */
	text: string;
}

/**
 * Parse a TypeScript file and return every `process.exit(...)` call
 * found in it. Comments and string/template literals are ignored
 * (the parser correctly distinguishes them from real expressions).
 */
export function findProcessExitCalls(filePath: string): ProcessExitCall[] {
	const source = readFileSync(filePath, "utf8");
	const sf = ts.createSourceFile(
		filePath,
		source,
		ts.ScriptTarget.Latest,
		/* setParentNodes */ true,
		ts.ScriptKind.TS,
	);

	const hits: ProcessExitCall[] = [];

	const visit = (node: ts.Node): void => {
		if (ts.isCallExpression(node) && isProcessExit(node.expression)) {
			const { line, character } = sf.getLineAndCharacterOfPosition(
				node.getStart(sf),
			);
			hits.push({
				line: line + 1,
				column: character + 1,
				text: node.getText(sf),
			});
		}
		ts.forEachChild(node, visit);
	};
	visit(sf);

	return hits;
}

/**
 * True iff the given expression is the property access `process.exit`.
 * We intentionally do NOT match `process["exit"]`, `(process).exit`,
 * or aliased forms (`const { exit } = process; exit(1);`). Those
 * idioms are exotic enough that flagging them would cost more
 * (false positives in unrelated code that happens to write
 * `process["exit"]` in a string) than they catch. The plain form
 * `process.exit(...)` is the only one we have ever observed in
 * this codebase, and it's the form lint and reviewers will see
 * first.
 */
function isProcessExit(expr: ts.Expression): boolean {
	if (!ts.isPropertyAccessExpression(expr)) return false;
	if (expr.name.text !== "exit") return false;
	const obj = expr.expression;
	return ts.isIdentifier(obj) && obj.text === "process";
}
