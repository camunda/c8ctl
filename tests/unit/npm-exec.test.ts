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

	test("keeps URLs with multiple percent-encoded sequences, which are not variable references", () => {
		// A URL like a%20b%2Fc has two %-sequences; the old regex /%[^%]+%/ would
		// match the span "%20b%" between them, treating it as a cmd.exe variable.
		const invocation = buildNpmInvocation({
			args: ["install", "https://example.com/a%20b%2Fc/pkg.tgz"],
			platform: "win32",
		});
		assert.deepStrictEqual(invocation.args, [
			'"install"',
			'"https://example.com/a%20b%2Fc/pkg.tgz"',
		]);
	});
});

/**
 * npm applies a CLI `--prefix` to the global prefix as well as the local one,
 * and on Windows the global install root sits directly under the prefix
 * (`<prefix>\node_modules`, versus `<prefix>/lib/node_modules` on POSIX). For a
 * plain `npm install --prefix <dir>` that makes npm's local and global install
 * targets identical, so npm rewrites the empty argument list to `["."]` and
 * installs the *process cwd* instead — the ENOENT reported in #526.
 */
describe("buildNpmInvocation: Windows --prefix rescope (#526)", () => {
	const hasPackageJson = () => true;

	test("runs a bare install in the prefix directory instead of passing --prefix", () => {
		const invocation = buildNpmInvocation({
			args: [
				"install",
				"--prefix",
				"C:\\projects\\app\\.camunda",
				"--package-lock-only",
				"--ignore-scripts",
			],
			platform: "win32",
			hasPackageJson,
		});
		assert.strictEqual(invocation.cwd, "C:\\projects\\app\\.camunda");
		assert.deepStrictEqual(invocation.args, [
			'"install"',
			'"--package-lock-only"',
			'"--ignore-scripts"',
		]);
	});

	test("rescopes the atomic --prefix=<path> form as well", () => {
		const invocation = buildNpmInvocation({
			args: ["install", "--prefix=C:\\projects\\app\\.camunda"],
			platform: "win32",
			hasPackageJson,
		});
		assert.strictEqual(invocation.cwd, "C:\\projects\\app\\.camunda");
		assert.deepStrictEqual(invocation.args, ['"install"']);
	});

	test("rescopes install aliases and the -C short form", () => {
		for (const alias of ["i", "add", "isntall"]) {
			const invocation = buildNpmInvocation({
				args: [alias, "-C", "C:\\projects\\app\\.camunda"],
				platform: "win32",
				hasPackageJson,
			});
			assert.strictEqual(invocation.cwd, "C:\\projects\\app\\.camunda");
			assert.deepStrictEqual(invocation.args, [`"${alias}"`]);
		}
	});

	test("keeps a prefix containing spaces intact as the cwd", () => {
		const invocation = buildNpmInvocation({
			args: ["install", "--prefix", "C:\\Users\\First Last\\my app\\.camunda"],
			platform: "win32",
			hasPackageJson,
		});
		assert.strictEqual(
			invocation.cwd,
			"C:\\Users\\First Last\\my app\\.camunda",
		);
		assert.deepStrictEqual(invocation.args, ['"install"']);
	});

	test("leaves an install with a package spec alone — npm resolves --prefix correctly there", () => {
		const invocation = buildNpmInvocation({
			args: [
				"install",
				"c8ctl-plugin-os",
				"--prefix",
				"C:\\Users\\user\\AppData\\Roaming\\c8ctl\\plugins",
			],
			platform: "win32",
			hasPackageJson,
		});
		assert.strictEqual(invocation.cwd, undefined);
		assert.deepStrictEqual(invocation.args, [
			'"install"',
			'"c8ctl-plugin-os"',
			'"--prefix"',
			'"C:\\Users\\user\\AppData\\Roaming\\c8ctl\\plugins"',
		]);
	});

	test("leaves a global install alone — there --prefix means the global root", () => {
		for (const globalFlag of ["-g", "--global", "--location=global"]) {
			const invocation = buildNpmInvocation({
				args: ["install", globalFlag, "--prefix", "C:\\tools\\npm"],
				platform: "win32",
				hasPackageJson,
			});
			assert.strictEqual(invocation.cwd, undefined);
			assert.ok(invocation.args.includes('"--prefix"'));
		}
	});

	test("leaves other npm commands alone", () => {
		for (const command of ["list", "uninstall", "rebuild", "ci", "view"]) {
			const invocation = buildNpmInvocation({
				args: [command, "--prefix", "C:\\projects\\app\\.camunda"],
				platform: "win32",
				hasPackageJson,
			});
			assert.strictEqual(invocation.cwd, undefined);
			assert.ok(invocation.args.includes('"--prefix"'));
		}
	});

	test("leaves the invocation alone when the prefix has no package.json", () => {
		// Rescoping would let npm walk up out of the prefix and install some
		// parent directory's dependencies instead.
		const invocation = buildNpmInvocation({
			args: ["install", "--prefix", "C:\\projects\\app\\.camunda"],
			platform: "win32",
			hasPackageJson: () => false,
		});
		assert.strictEqual(invocation.cwd, undefined);
		assert.ok(invocation.args.includes('"--prefix"'));
	});

	test("leaves an ambiguous bare token alone rather than guessing", () => {
		// "warn" is the value of --loglevel, but that is npm's schema, not ours:
		// treating it as a possible package spec only skips the rescope.
		const invocation = buildNpmInvocation({
			args: [
				"install",
				"--loglevel",
				"warn",
				"--prefix",
				"C:\\projects\\app\\.camunda",
			],
			platform: "win32",
			hasPackageJson,
		});
		assert.strictEqual(invocation.cwd, undefined);
		assert.ok(invocation.args.includes('"--prefix"'));
	});

	test("still rejects a hostile prefix value instead of turning it into a cwd", () => {
		assert.throws(
			() =>
				buildNpmInvocation({
					args: ["install", "--prefix", "%APPDATA%\\evil"],
					platform: "win32",
					hasPackageJson,
				}),
			/environment variable reference/,
		);
	});

	test("does not rescope on POSIX, where --prefix resolves correctly", () => {
		const invocation = buildNpmInvocation({
			args: ["install", "--prefix", "/home/user/app/.camunda"],
			platform: "linux",
			hasPackageJson,
		});
		assert.strictEqual(invocation.cwd, undefined);
		assert.deepStrictEqual(invocation.args, [
			"install",
			"--prefix",
			"/home/user/app/.camunda",
		]);
	});
});

describe("no bare npm spawns remain in src/ (#484)", () => {
	test("npm is only spawned through the npm-exec helper", async () => {
		const offenders: string[] = [];
		for await (const relative of glob("**/*.ts", { cwd: SRC_DIR })) {
			if (relative === join("utils", "shared", "npm-exec.ts")) {
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
			`These files spawn npm directly instead of using npm(): ${offenders.join(", ")}`,
		);
	});
});
