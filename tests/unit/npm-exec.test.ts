/**
 * Unit tests for the cross-platform npm invocation helper (#484).
 *
 * The Windows branch cannot be exercised on a POSIX CI runner, so
 * `buildNpmInvocation()` takes an explicit `platform` argument.
 */

import assert from "node:assert";
import { readFileSync } from "node:fs";
import { glob } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildNpmInvocation } from "../../src/utils/shared/npm-exec.ts";

const SRC_DIR = fileURLToPath(new URL("../../src", import.meta.url));

describe("buildNpmInvocation", () => {
	test("spawns bare npm without a shell on POSIX", () => {
		const invocation = buildNpmInvocation({
			args: ["install", "c8ctl-plugin-os", "--prefix", "/home/user/plugins"],
			platform: "linux",
		});
		assert.strictEqual(invocation.command, "npm");
		assert.strictEqual(invocation.shell, false);
		assert.deepStrictEqual(invocation.args, [
			"install",
			"c8ctl-plugin-os",
			"--prefix",
			"/home/user/plugins",
		]);
	});

	test("leaves POSIX arguments containing spaces unquoted", () => {
		const invocation = buildNpmInvocation({
			args: ["install", "--prefix", "/home/First Last/plugins"],
			platform: "darwin",
		});
		assert.deepStrictEqual(invocation.args, [
			"install",
			"--prefix",
			"/home/First Last/plugins",
		]);
	});

	test("uses the npm.cmd shim through a shell on Windows", () => {
		const invocation = buildNpmInvocation({
			args: [
				"install",
				"https://github.com/camunda/c8ctl-plugin-process-os",
				"--prefix",
				"C:\\Users\\user\\AppData\\Roaming\\c8ctl\\plugins",
			],
			platform: "win32",
		});
		// Bare "npm" ENOENTs and a bare "npm.cmd" EINVALs (CVE-2024-27980),
		// so the shim must go through cmd.exe.
		assert.strictEqual(invocation.command, "npm.cmd");
		assert.strictEqual(invocation.shell, true);
	});

	test("quotes Windows arguments so a plugins dir with spaces survives", () => {
		const invocation = buildNpmInvocation({
			args: [
				"install",
				"c8ctl-plugin-os",
				"--prefix",
				"C:\\Users\\First Last\\AppData\\Roaming\\c8ctl\\plugins",
			],
			platform: "win32",
		});
		assert.deepStrictEqual(invocation.args, [
			'"install"',
			'"c8ctl-plugin-os"',
			'"--prefix"',
			'"C:\\Users\\First Last\\AppData\\Roaming\\c8ctl\\plugins"',
		]);
	});

	test("doubles trailing backslashes so the closing quote is not escaped", () => {
		const invocation = buildNpmInvocation({
			args: ["--prefix", "C:\\Users\\First Last\\plugins\\"],
			platform: "win32",
		});
		assert.deepStrictEqual(invocation.args, [
			'"--prefix"',
			'"C:\\Users\\First Last\\plugins\\\\"',
		]);
	});

	test("rejects Windows arguments containing a quote or line break", () => {
		for (const hostile of ['foo" & calc.exe & "bar', "foo\nbar", "foo\rbar"]) {
			assert.throws(
				() =>
					buildNpmInvocation({ args: ["install", hostile], platform: "win32" }),
				/cannot be passed safely to cmd\.exe/,
			);
		}
	});

	test("rejects Windows arguments containing a cmd.exe variable reference", () => {
		for (const hostile of ["%APPDATA%\\evil", "%ProgramFiles(x86)%\\evil"]) {
			assert.throws(
				() =>
					buildNpmInvocation({ args: ["install", hostile], platform: "win32" }),
				/environment variable reference/,
			);
		}
	});

	test("keeps percent-encoded URLs, which are not variable references", () => {
		const invocation = buildNpmInvocation({
			args: ["install", "https://example.com/a%20b/pkg.tgz"],
			platform: "win32",
		});
		assert.deepStrictEqual(invocation.args, [
			'"install"',
			'"https://example.com/a%20b/pkg.tgz"',
		]);
	});
});

describe("no bare npm spawns remain in src/ (#484)", () => {
	test("npm is only spawned through the npm-exec helper", async () => {
		const offenders: string[] = [];
		for await (const relative of glob("**/*.ts", { cwd: SRC_DIR })) {
			if (relative.replaceAll("\\", "/") === "utils/shared/npm-exec.ts") {
				continue;
			}
			const source = readFileSync(join(SRC_DIR, relative), "utf-8");
			if (/(?:exec|execFile|spawn)(?:Sync)?\(\s*["'`]npm/.test(source)) {
				offenders.push(relative);
			}
		}
		assert.deepStrictEqual(
			offenders,
			[],
			`These files spawn npm directly instead of using runNpm()/runNpmCapture(): ${offenders.join(", ")}`,
		);
	});
});
