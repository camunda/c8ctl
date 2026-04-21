/**
 * AST-based scanner that finds every `<server>.listen(<port>, ...)`
 * call in a TypeScript source file whose first argument is not the
 * literal numeric `0`.
 *
 * Why this matters
 * ----------------
 * A mock HTTP server in an integration test that picks its own port
 * (hardcoded constant, environment variable, or `Math.random()` over
 * a numeric range) has two failure modes:
 *
 *   1. **Port collision.** If the chosen port is already in use, the
 *      `listen()` call emits an `EADDRINUSE` error. Tests typically
 *      pass `() => resolve()` as the callback with no error handler,
 *      so the resolve never fires and the test hangs until the suite
 *      timeout — a slow, opaque failure mode.
 *   2. **Restricted ports.** Node's built-in `fetch` (undici) refuses
 *      to connect to a hardcoded list of ports inherited from
 *      Chromium's "bad ports" list (e.g. 10080, 6666–6669). A range
 *      that overlaps any of those will lottery-fail with
 *      `TypeError: fetch failed` / `cause: Error: bad port`. See
 *      issue #316 for the historical incident that motivated this
 *      guard.
 *
 * The deterministic fix is to call `.listen(0, ...)` and read the
 * kernel-assigned port off `server.address()`. `tests/integration/
 * watch-cancellation.test.ts` is the canonical example of the
 * pattern.
 *
 * AST-based (not regex) for the same reasons documented in
 * `no-process-exit.ts`: string literals, comments, and template
 * literals can produce false positives or false negatives with a
 * regex over file text.
 */

import { readFileSync } from "node:fs";
import ts from "typescript";

export interface HardcodedListenCall {
	/** 1-based line number of the call. */
	line: number;
	/** 1-based column number of the call. */
	column: number;
	/** The full call text, e.g. `mockServer.listen(mockServerPort, () => resolve())`. */
	text: string;
	/** The text of the first argument as it appeared in source. */
	firstArgText: string;
}

/**
 * Parse a TypeScript file and return every `.listen(<arg>, ...)`
 * call whose first argument is not the literal numeric `0`.
 *
 * Calls with no arguments, or whose first argument is a string
 * literal (e.g. a Unix socket path), are ignored — those are not
 * the defect class this guard targets.
 */
export function findHardcodedListenPortCalls(
	filePath: string,
): HardcodedListenCall[] {
	const source = readFileSync(filePath, "utf8");
	const sf = ts.createSourceFile(
		filePath,
		source,
		ts.ScriptTarget.Latest,
		/* setParentNodes */ true,
		ts.ScriptKind.TS,
	);

	const hits: HardcodedListenCall[] = [];

	const visit = (node: ts.Node): void => {
		if (ts.isCallExpression(node) && isListenCall(node.expression)) {
			const firstArg = node.arguments[0];
			if (
				firstArg &&
				!isPortZeroLiteral(firstArg) &&
				!isStringLikeArg(firstArg)
			) {
				const { line, character } = sf.getLineAndCharacterOfPosition(
					node.getStart(sf),
				);
				hits.push({
					line: line + 1,
					column: character + 1,
					text: node.getText(sf),
					firstArgText: firstArg.getText(sf),
				});
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sf);

	return hits;
}

/**
 * True iff the given expression is a member access ending in
 * `.listen` (e.g. `server.listen`, `mockServer.listen`,
 * `this.server.listen`). We deliberately do NOT match a bare
 * `listen(...)` identifier — that would catch unrelated functions
 * named `listen` (event listeners, etc.).
 */
function isListenCall(expr: ts.Expression): boolean {
	if (!ts.isPropertyAccessExpression(expr)) return false;
	return expr.name.text === "listen";
}

/**
 * True iff the argument is the literal numeric `0` — the only
 * value that asks the kernel to assign a free port.
 */
function isPortZeroLiteral(arg: ts.Expression): boolean {
	return ts.isNumericLiteral(arg) && arg.text === "0";
}

/**
 * True iff the argument is a string literal or template literal —
 * i.e. a Unix-socket path or pipe name. These are not the port-lottery
 * defect class.
 */
function isStringLikeArg(arg: ts.Expression): boolean {
	return (
		ts.isStringLiteral(arg) ||
		ts.isNoSubstitutionTemplateLiteral(arg) ||
		ts.isTemplateExpression(arg)
	);
}
