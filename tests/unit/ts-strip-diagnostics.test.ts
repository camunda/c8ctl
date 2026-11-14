import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, test } from "node:test";

const PRELOAD = resolve(
	import.meta.dirname,
	"../utils/ts-strip-diagnostics.ts",
);

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
});
