/**
 * AST-based scanner that finds every `<server>.listen(<port>, ...)` call
 * in a TypeScript test file where `<port>` is a hardcoded numeric literal
 * other than `0`, OR is derived from a numeric literal via `Math.random()`
 * (e.g. `9876 + Math.floor(Math.random() * 1000)`).
 *
 * Why this guard exists (issue #316): integration tests that bind their
 * mock servers to either a hardcoded numeric port or a random number drawn
 * from a numeric range are vulnerable to two latent failure modes that
 * have already cost us at least one CI failure:
 *
 *   1. Bad-port lottery — undici (Node's native fetch) rejects requests
 *      to ports on Chromium's "bad ports" list with `Error: bad port`
 *      before any network I/O happens. Port 10080 (Sun RPC) lives inside
 *      the historical 9876 + 1000 range used by `mcp-proxy-mock.test.ts`
 *      and triggered an intermittent CI failure on PR #313.
 *   2. EADDRINUSE collisions — two integration suites running in parallel
 *      may draw the same port. The legacy random-port code path had no
 *      `error` listener on `listen()`, so a collision silently hung the
 *      test instead of failing fast.
 *
 * The deterministic fix is `server.listen(0, ...)` plus reading the
 * kernel-assigned port back from `server.address()`. The kernel never
 * returns a "bad port" and never collides.
 *
 * AST (not regex) so that string literals containing `.listen(8080`,
 * comments mentioning the pattern, and commented-out code cannot
 * produce false positives or false negatives.
 *
 * Allowlist: `listen(0, ...)` is fine. `listen(somePortVariable, ...)`
 * is fine — the assumption is that the variable was assigned from
 * `address().port` after a kernel-assigned bind, and a reviewer caught
 * that. The check is deliberately scoped to the most common copy-paste
 * footgun: a numeric literal sitting inline at the call site, or a
 * `Math.random()`-derived range.
 */

import { readFileSync } from "node:fs";
import ts from "typescript";

export interface BadListenCall {
	/** 1-based line number of the call. */
	line: number;
	/** 1-based column number of the call. */
	column: number;
	/** The full call text, e.g. `server.listen(8080, cb)`. */
	text: string;
	/** Why it was flagged. */
	reason:
		| "numeric-literal-port"
		| "math-random-derived-port"
		| "variable-derived-from-math-random";
}

/**
 * Parse a TypeScript file and return every offending `.listen(...)`
 * call site found in it.
 */
export function findHardcodedListenPorts(filePath: string): BadListenCall[] {
	const source = readFileSync(filePath, "utf8");
	const sf = ts.createSourceFile(
		filePath,
		source,
		ts.ScriptTarget.Latest,
		/* setParentNodes */ true,
		ts.ScriptKind.TS,
	);

	// First pass: identify any local variable whose initializer or
	// assignment uses Math.random(). These are "tainted" — using them as a
	// port argument is the same defect class as inlining the expression.
	const taintedNames = collectMathRandomTaintedIdentifiers(sf);

	const hits: BadListenCall[] = [];

	const visit = (node: ts.Node): void => {
		if (
			ts.isCallExpression(node) &&
			ts.isPropertyAccessExpression(node.expression) &&
			node.expression.name.text === "listen" &&
			node.arguments.length >= 1
		) {
			const portArg = node.arguments[0];
			const reason = classifyPortArg(portArg, taintedNames);
			if (reason) {
				const { line, character } = sf.getLineAndCharacterOfPosition(
					node.getStart(sf),
				);
				hits.push({
					line: line + 1,
					column: character + 1,
					text: node.getText(sf),
					reason,
				});
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sf);

	return hits;
}

function classifyPortArg(
	arg: ts.Expression,
	tainted: ReadonlySet<string>,
): BadListenCall["reason"] | null {
	// `listen(0, ...)` — the kernel-assigned-port idiom we want.
	if (ts.isNumericLiteral(arg) && arg.text === "0") {
		return null;
	}
	// `listen(<numeric-literal>, ...)` where literal !== 0.
	if (ts.isNumericLiteral(arg)) {
		return "numeric-literal-port";
	}
	// Inline expression containing Math.random() — the original
	// `9876 + Math.floor(Math.random() * 1000)` shape.
	if (containsMathRandom(arg)) {
		return "math-random-derived-port";
	}
	// Identifier that was tainted by a Math.random() initializer.
	if (ts.isIdentifier(arg) && tainted.has(arg.text)) {
		return "variable-derived-from-math-random";
	}
	return null;
}

function containsMathRandom(node: ts.Node): boolean {
	let found = false;
	const walk = (n: ts.Node): void => {
		if (found) return;
		if (
			ts.isCallExpression(n) &&
			ts.isPropertyAccessExpression(n.expression) &&
			ts.isIdentifier(n.expression.expression) &&
			n.expression.expression.text === "Math" &&
			n.expression.name.text === "random"
		) {
			found = true;
			return;
		}
		ts.forEachChild(n, walk);
	};
	walk(node);
	return found;
}

function collectMathRandomTaintedIdentifiers(
	sf: ts.SourceFile,
): ReadonlySet<string> {
	const tainted = new Set<string>();
	const visit = (node: ts.Node): void => {
		// `const port = 9876 + Math.random() * 1000;`
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
			if (node.initializer && containsMathRandom(node.initializer)) {
				tainted.add(node.name.text);
			}
		}
		// `port = 9876 + Math.random() * 1000;`
		if (
			ts.isBinaryExpression(node) &&
			node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
			ts.isIdentifier(node.left) &&
			containsMathRandom(node.right)
		) {
			tainted.add(node.left.text);
		}
		ts.forEachChild(node, visit);
	};
	visit(sf);
	return tainted;
}
