/**
 * AST-based scanner that finds reads of per-invocation request flags off
 * the global `c8ctl` runtime singleton (e.g. `c8ctl.dryRun`, `c8ctl.verbose`).
 *
 * Why this guard exists (issue #424, finding #3): per-invocation request
 * state — whether `--dry-run` / `--verbose` were passed — is resolved once
 * at the composition root (`src/index.ts`) and threaded into command
 * handlers through the typed `CommandContext` (`ctx.dryRun()`, `ctx.isDryRun`,
 * `ctx.verbose`). Reaching back into the mutable global from the command or
 * framework layers re-introduces hidden coupling to the singleton and
 * bypasses the DI channel, so it is forbidden there.
 *
 * Why AST and not regex: a regex over file text would flag the same field
 * names inside comments, doc strings, and string literals (false positives)
 * and can miss real reads when naive comment-stripping interacts with
 * strings/templates (false negatives). The TypeScript parser distinguishes
 * code from comments and literals, so a PropertyAccessExpression walk is the
 * only durable shape. See `tests/utils/no-process-exit.ts` for the same
 * rationale.
 *
 * Matches the plain form `c8ctl.<field>` only (object identifier `c8ctl`,
 * property name in the configured set). It intentionally does NOT match
 * `globalThis.c8ctl.<field>`, element access (`c8ctl["dryRun"]`), or aliased
 * destructures — those idioms do not appear in this codebase and flagging
 * them would cost more in false positives than they catch.
 */

import { readFileSync } from "node:fs";
import ts from "typescript";

export interface RuntimeGlobalRead {
	/** 1-based line number of the read. */
	line: number;
	/** 1-based column number of the read. */
	column: number;
	/** The field that was read, e.g. `dryRun`. */
	field: string;
	/** The full property-access text, e.g. `c8ctl.dryRun`. */
	text: string;
}

/**
 * Parse a TypeScript file and return every `c8ctl.<field>` property access
 * whose field is in `forbiddenFields`. Comments and string/template literals
 * are ignored (the parser correctly distinguishes them from real code).
 */
export function findRuntimeGlobalReads(
	filePath: string,
	forbiddenFields: readonly string[],
): RuntimeGlobalRead[] {
	const source = readFileSync(filePath, "utf8");
	const sf = ts.createSourceFile(
		filePath,
		source,
		ts.ScriptTarget.Latest,
		/* setParentNodes */ true,
		ts.ScriptKind.TS,
	);

	const forbidden = new Set(forbiddenFields);
	const hits: RuntimeGlobalRead[] = [];

	const visit = (node: ts.Node): void => {
		if (
			ts.isPropertyAccessExpression(node) &&
			ts.isIdentifier(node.expression) &&
			node.expression.text === "c8ctl" &&
			forbidden.has(node.name.text)
		) {
			const { line, character } = sf.getLineAndCharacterOfPosition(
				node.getStart(sf),
			);
			hits.push({
				line: line + 1,
				column: character + 1,
				field: node.name.text,
				text: node.getText(sf),
			});
		}
		ts.forEachChild(node, visit);
	};
	visit(sf);

	return hits;
}
