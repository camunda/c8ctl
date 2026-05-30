/**
 * Architectural class-of-defect guard for issue #424, finding #3.
 *
 * Per-invocation request flags (`--dry-run`, `--verbose`) are resolved once
 * at the composition root (`src/index.ts`) and threaded into command handlers
 * through the typed `CommandContext`:
 *
 *   - `ctx.dryRun({ ... })` — the bound dry-run helper (returns a
 *     `DryRunResult` when active, else null).
 *   - `ctx.isDryRun` — the boolean, for handlers that emit a custom dry-run
 *     payload (deploy, identity).
 *   - `ctx.verbose` — whether `--verbose` was passed.
 *
 * The command (`src/commands/**`) and framework (`src/framework/**`) layers
 * must obtain these from `ctx` (or, for non-handler framework entry points,
 * an explicit parameter) and must NOT read them back off the mutable global
 * `c8ctl` runtime singleton. Doing so re-introduces hidden coupling to the
 * singleton and bypasses the DI channel.
 *
 * The global itself stays — it is the irreducible plugin SDK exposed on
 * `globalThis.c8ctl`, and `src/core/**` legitimately owns/wraps it (the
 * core error handler and SDK client read it directly, and the composition
 * root writes it). This guard is scoped to the two layers that receive a
 * `CommandContext` instead.
 *
 * AST-based (not regex) so field names in comments, doc strings, and string
 * literals cannot produce false positives or false negatives. See
 * `tests/utils/no-runtime-global-reads.ts`.
 */

import assert from "node:assert";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, test } from "node:test";
import { findRuntimeGlobalReads } from "../utils/no-runtime-global-reads.ts";

const PROJECT_ROOT = resolve(import.meta.dirname, "..", "..");

/** Per-invocation request flags that must come from `ctx`, not the global. */
const FORBIDDEN_FIELDS = ["dryRun", "verbose"] as const;

/** Layers that receive a CommandContext and must not read the mutable global. */
const GUARDED_DIRS = [
	join(PROJECT_ROOT, "src", "commands"),
	join(PROJECT_ROOT, "src", "framework"),
];

function listTsFilesRecursive(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const abs = join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...listTsFilesRecursive(abs));
		} else if (entry.name.endsWith(".ts")) {
			out.push(abs);
		}
	}
	return out;
}

/** Convert an absolute path under PROJECT_ROOT to a workspace-relative
 * POSIX path for stable diagnostic output. */
function toRelative(absPath: string): string {
	const rel = absPath.slice(PROJECT_ROOT.length + 1);
	return rel.split(/[\\/]/).join("/");
}

describe("architectural guard: ctx, not the global runtime, carries per-invocation flags (#424)", () => {
	const files = GUARDED_DIRS.flatMap(listTsFilesRecursive);

	test("no command/framework file reads `c8ctl.dryRun` or `c8ctl.verbose`", () => {
		const violations: { file: string; line: number; text: string }[] = [];
		for (const abs of files) {
			for (const read of findRuntimeGlobalReads(abs, FORBIDDEN_FIELDS)) {
				violations.push({
					file: toRelative(abs),
					line: read.line,
					text: read.text,
				});
			}
		}
		assert.strictEqual(
			violations.length,
			0,
			`Command and framework files must read per-invocation flags from the ` +
				`CommandContext (\`ctx.dryRun()\`, \`ctx.isDryRun\`, \`ctx.verbose\`), ` +
				`not from the global \`c8ctl\` runtime. Found ${violations.length}:\n` +
				violations
					.map((v) => `  - ${v.file}:${v.line} — ${v.text}`)
					.join("\n") +
				`\n\nThread the flag through \`ctx\` (handlers) or an explicit ` +
				`parameter (non-handler framework entry points) instead.`,
		);
	});
});
