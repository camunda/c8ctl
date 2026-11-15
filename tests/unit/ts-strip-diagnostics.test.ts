import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, test } from "node:test";
import { pathToFileURL } from "node:url";

// A file URL, because `--import` rejects absolute Windows paths (`C:\…`).
const PRELOAD = pathToFileURL(
	resolve(import.meta.dirname, "../utils/ts-strip-diagnostics.ts"),
).href;

const run = (files: Record<string, string>) => {
	const dir = mkdtempSync(join(tmpdir(), "c8-ts-strip-diag-"));
	try {
		for (const [name, content] of Object.entries(files)) {
			writeFileSync(join(dir, name), content);
		}
		return spawnSync(
			process.execPath,
			["--experimental-strip-types", "--import", PRELOAD, join(dir, "main.ts")],
			{ encoding: "utf8" },
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
};

describe("type-stripping diagnostics preload", () => {
	test("prints nothing when every module strips cleanly", () => {
		const result = run({
			"main.ts": 'import { n } from "./dep.ts";\nconsole.log(n);\n',
			"dep.ts": "export const n: number = 1;\n",
		});
		assert.strictEqual(result.status, 0, result.stderr);
		assert.strictEqual(result.stdout, "1\n");
		assert.strictEqual(result.stderr, "");
	});

	test("names the module that fails to strip and whether it fails again", () => {
		const result = run({
			"main.ts": 'import "./bad.ts";\n',
			"bad.ts": "class A {\n  (x) {}\n}\n",
		});
		assert.notStrictEqual(result.status, 0);
		assert.match(result.stderr, /\[ts-strip-diagnostics\]/);
		assert.match(
			result.stderr,
			/failing module: file:\/\/\S*bad\.ts: now \d+ chars, [0-9a-f]{12} on disk; fails again: /,
		);
	});

	test("reports the latest stripping failure, not an earlier caught one", () => {
		const result = run({
			"main.ts":
				'try {\n  await import("./recovered.ts");\n} catch {}\nawait import("./bad.ts");\n',
			"recovered.ts": "class A {\n  (x) {}\n}\n",
			"bad.ts": "class B {\n  (y) {}\n}\n",
		});
		assert.notStrictEqual(result.status, 0);
		assert.match(result.stderr, /failing module: file:\/\/\S*bad\.ts: /);
		assert.doesNotMatch(result.stderr, /failing module: \S*recovered\.ts/);
	});

	test("reports hash, disk state and re-strip result of recent modules", () => {
		const dep = "export const n: number = 1;\n";
		const changed = "export const m: number = 2;\n";
		const hash = (text: string) =>
			createHash("sha256").update(text).digest("hex").slice(0, 12);
		const result = run({
			"main.ts": `import { writeFileSync } from "node:fs";\nimport "./dep.ts";\nimport "./changing.ts";\nwriteFileSync(new URL("./changing.ts", import.meta.url), ${JSON.stringify(changed)});\nawait import("./bad.ts");\n`,
			"dep.ts": dep,
			"changing.ts": dep,
			"bad.ts": "class A {\n  (x) {}\n}\n",
		});
		assert.notStrictEqual(result.status, 0);
		assert.match(
			result.stderr,
			new RegExp(
				`dep\\.ts \\(${dep.length} chars, ${hash(dep)}\\): unchanged on disk; strips cleanly now`,
			),
		);
		assert.match(
			result.stderr,
			new RegExp(
				`changing\\.ts \\(${dep.length} chars, ${hash(dep)}\\): CHANGED on disk \\(now ${changed.length} chars, ${hash(changed)}\\); strips cleanly now`,
			),
		);
	});
});
