/**
 * Guard: never bind `matchesGlob` from `node:path` with a named import or
 * re-export.
 *
 * Node.js releases below c8ctl's supported range (before 20.17, and
 * 22.0-22.4) lack `path.matchesGlob`. A named binding makes ESM linking fail
 * on them before `main()` runs, so the CLI exits with a `SyntaxError` instead
 * of printing the unsupported Node.js warning. Call the `matchesGlob` wrapper
 * from `src/utils/shared/ignore.ts`, which looks the function up at call time.
 */

import assert from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, test } from "node:test";

const PROJECT_ROOT = resolve(import.meta.dirname, "..", "..");
const SCAN_ROOTS = ["src", "default-plugins"];

const NAMED_BINDING =
	/\b(?:import|export)\s+(?:type\s+)?(?:[\w$]+\s*,\s*)?\{[^}]*\bmatchesGlob\b[^}]*\}\s*from\s*["'](?:node:)?path["']/;

function sourceFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			return entry.name === "node_modules" ? [] : sourceFiles(full);
		}
		return /\.(?:[cm]?[jt]s)$/.test(entry.name) ? [full] : [];
	});
}

describe("no named matchesGlob import", () => {
	test("the pattern catches the named forms it must reject", () => {
		for (const source of [
			'import { join, matchesGlob } from "node:path";',
			'import nodePath, {\n\tmatchesGlob,\n} from "node:path";',
			"import { matchesGlob as glob } from 'path';",
			'export { matchesGlob } from "node:path";',
		]) {
			assert.match(source, NAMED_BINDING, source);
		}
		assert.doesNotMatch(
			'import nodePath, { join } from "node:path";',
			NAMED_BINDING,
		);
	});

	test("src and default-plugins never bind matchesGlob by name", () => {
		const offenders = SCAN_ROOTS.flatMap((root) =>
			sourceFiles(join(PROJECT_ROOT, root)),
		)
			.filter((file) => NAMED_BINDING.test(readFileSync(file, "utf-8")))
			.map((file) => relative(PROJECT_ROOT, file));

		assert.deepStrictEqual(
			offenders,
			[],
			"Use the matchesGlob wrapper from src/utils/shared/ignore.ts; a named import crashes unsupported Node.js before the version warning",
		);
	});
});
