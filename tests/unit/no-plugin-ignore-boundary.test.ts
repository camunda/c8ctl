/**
 * Architectural ratchet guard: `biome-ignore lint/plugin` suppressions are
 * banned outside an explicit, shrink-only allow-list.
 *
 * The `no-unsafe-type-assertion` Biome plugin (`plugins/*.grit`) forbids `as`
 * type assertions repo-wide. A `// biome-ignore lint/plugin:` comment silences
 * it locally — a necessary escape hatch at genuine type-system boundaries, but
 * an anti-pattern when it spreads: each suppression is an unchecked `as` cast
 * that the plugin can no longer protect.
 *
 * This guard freezes the current, reviewed set of suppressions and prevents
 * new ones. Two rules:
 *   1. A file not on `ALLOWED` must contain zero suppressions.
 *   2. A file on `ALLOWED` must contain *exactly* its listed count — no more
 *      (no new suppressions) and no fewer (when you remove one, decrement the
 *      entry so the ratchet only ever tightens; drop the entry at zero).
 *
 * The moddle object graph was the largest offender (9 suppressions across
 * `binding.ts`/`apply.ts`/`edit.ts`, each an `as` on an untyped
 * `moddleElement.get()`). It is deliberately absent from the list: those reads
 * now funnel through the guard-based accessors in
 * `default-plugins/element-template/moddle.ts`, which narrow with runtime type
 * guards instead of `as`. The remaining allow-listed boundaries (framework
 * `InferFlags` structural assertions, logger widening, CLI trust-boundary
 * indexing) are tracked for the same treatment in camunda/c8ctl#472.
 *
 * Matching is on the suppression *comment* form (`// biome-ignore lint/plugin`)
 * — exactly what Biome recognises — so JSDoc prose mentioning the directive
 * (as this file and `moddle.ts` do) is not counted.
 */

import assert from "node:assert";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, test } from "node:test";

const PROJECT_ROOT = resolve(import.meta.dirname, "..", "..");
const SCAN_ROOTS = ["src", "default-plugins"];

/**
 * Frozen set of files permitted to suppress the `no-unsafe-type-assertion`
 * plugin, with the exact number of suppressions each may contain. This list
 * can only shrink: never raise a count or add an entry to make a new `as`
 * pass. Retire boundaries by routing them through a typed helper (see
 * `moddle.ts`) and decrementing here.
 */
const ALLOWED: Record<string, number> = {
	"src/core/logger.ts": 3,
	"src/framework/command-framework.ts": 5,
	"src/framework/command-registry.ts": 4,
	"src/framework/ui/help.ts": 1,
	"src/index.ts": 1,
	"src/utils/command-local/open-helpers.ts": 1,
	"default-plugins/element-template/template-ref.ts": 1,
};

/** Matches the Biome suppression comment, not JSDoc/string mentions. */
const SUPPRESSION = /\/\/\s*biome-ignore\s+lint\/plugin\b/;

function listTsFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const abs = join(dir, entry);
		if (statSync(abs).isDirectory()) {
			out.push(...listTsFiles(abs));
		} else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
			out.push(abs);
		}
	}
	return out;
}

function toRelative(absPath: string): string {
	return absPath
		.slice(PROJECT_ROOT.length + 1)
		.split(/[\\/]/)
		.join("/");
}

function countSuppressions(absPath: string): number {
	return readFileSync(absPath, "utf-8")
		.split("\n")
		.filter((line) => SUPPRESSION.test(line)).length;
}

describe("architectural guard: no new `biome-ignore lint/plugin` suppressions", () => {
	const counts = new Map<string, number>();
	for (const root of SCAN_ROOTS) {
		for (const abs of listTsFiles(join(PROJECT_ROOT, root))) {
			const n = countSuppressions(abs);
			if (n > 0) counts.set(toRelative(abs), n);
		}
	}

	test("every suppression sits in an allow-listed file (no new offenders)", () => {
		const offenders = [...counts.keys()]
			.filter((file) => !(file in ALLOWED))
			.sort();
		assert.deepStrictEqual(
			offenders,
			[],
			"These files introduced a `// biome-ignore lint/plugin` suppression but are not " +
				"allow-listed. Remove the `as` cast (prefer a guard-based typed accessor, as " +
				`moddle.ts does) instead of suppressing the plugin:\n  ${offenders.join("\n  ")}`,
		);
	});

	test("no allow-listed file exceeds its frozen suppression count", () => {
		const overspill = [...counts.entries()]
			.filter(([file, n]) => file in ALLOWED && n > ALLOWED[file])
			.map(([file, n]) => `${file}: ${n} > allowed ${ALLOWED[file]}`)
			.sort();
		assert.deepStrictEqual(
			overspill,
			[],
			`These files added suppressions beyond their frozen count:\n  ${overspill.join("\n  ")}`,
		);
	});

	test("the allow-list has no stale entries (ratchet only tightens)", () => {
		const stale = Object.keys(ALLOWED)
			.filter((file) => (counts.get(file) ?? 0) < ALLOWED[file])
			.map(
				(file) =>
					`${file}: listed ${ALLOWED[file]}, found ${counts.get(file) ?? 0}`,
			)
			.sort();
		assert.deepStrictEqual(
			stale,
			[],
			"Suppressions were removed — decrement (or drop) these allow-list entries so the " +
				`ratchet reflects reality:\n  ${stale.join("\n  ")}`,
		);
	});
});
