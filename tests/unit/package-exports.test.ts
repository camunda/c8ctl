/**
 * Guard: every published entry point in package.json points at a file that
 * the build actually emits.
 *
 * `tsc` mirrors `src/` into `dist/` (rootDir: ./src, outDir: ./dist), so a
 * `dist/**` target is emitted if and only if the corresponding `src/**.ts`
 * file exists. Checking the source side keeps the guard build-independent:
 * it fails in a clean checkout instead of only after `npm run build`.
 *
 * Defect class this pins (#414 fallout): moving a source file without
 * updating `exports`/`bin` leaves a dangling subpath that resolves to
 * nothing. `@camunda8/cli/runtime` — the type entry point every TypeScript
 * plugin imports `C8ctlPluginRuntime` from — silently pointed at
 * `dist/runtime.js` after `src/runtime.ts` moved to `src/core/runtime.ts`.
 * Nothing failed at build time because a missing export target is only
 * observable from a consuming package.
 */

import assert from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, test } from "node:test";
import { isRecord } from "../../src/core/logger.ts";

const PROJECT_ROOT = resolve(import.meta.dirname, "..", "..");
const packageJson: unknown = JSON.parse(
	readFileSync(join(PROJECT_ROOT, "package.json"), "utf-8"),
);

/** Map a published `./dist/**` path back to the `src/**.ts` file tsc emits it from. */
function sourceFileFor(distPath: string): string {
	const relative = distPath.replace(/^\.\//, "").replace(/^dist\//, "");
	const source = relative.replace(/\.d\.ts$/, ".ts").replace(/\.js$/, ".ts");
	return join(PROJECT_ROOT, "src", source);
}

/** Collect every string leaf of an `exports` entry (conditions nest arbitrarily deep). */
function collectTargets(value: unknown, path: string): [string, string][] {
	if (typeof value === "string") return [[path, value]];
	if (!isRecord(value)) return [];
	return Object.entries(value).flatMap(([key, nested]) =>
		collectTargets(nested, `${path}.${key}`),
	);
}

describe("package.json entry points resolve to emitted files", () => {
	test("every exports condition maps to a source file", () => {
		assert.ok(isRecord(packageJson), "package.json parses to an object");
		const targets = collectTargets(packageJson.exports, "exports");
		assert.ok(targets.length > 0, "package.json declares subpath exports");

		const dangling = targets.filter(
			([, target]) => !existsSync(sourceFileFor(target)),
		);
		assert.deepStrictEqual(
			dangling,
			[],
			`These exports point at files the build does not emit: ${dangling
				.map(([path, target]) => `${path} -> ${target}`)
				.join(", ")}`,
		);
	});

	test("every bin entry maps to a source file", () => {
		assert.ok(isRecord(packageJson), "package.json parses to an object");
		const targets = collectTargets(packageJson.bin, "bin");
		assert.ok(targets.length > 0, "package.json declares bin entries");

		const dangling = targets.filter(
			([, target]) => !existsSync(sourceFileFor(target)),
		);
		assert.deepStrictEqual(
			dangling,
			[],
			`These bin entries point at files the build does not emit: ${dangling
				.map(([path, target]) => `${path} -> ${target}`)
				.join(", ")}`,
		);
	});
});
