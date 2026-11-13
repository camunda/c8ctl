/**
 * Two installed packages provide a `tsc` command: `typescript` (TypeScript 7,
 * the compiler) and `typescript-compiler-api` (a TypeScript 6 alias kept for
 * the AST guard tests). npm links only one of them into node_modules/.bin, and
 * which one depends on install order. A bare `tsc` can therefore silently run
 * TypeScript 6. Build, typecheck and the pre-commit hook must call TypeScript
 * 7's binary by path.
 */

import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { isRecord } from "../../src/core/index.ts";

const TSC_PATH = "node_modules/typescript/bin/tsc";
const BARE_TSC = /(^|&&|;|\||\bnpx\s+(--no-install\s+)?)\s*tsc\b/;

const scripts = (): Record<string, unknown> => {
	const pkg: unknown = JSON.parse(readFileSync("package.json", "utf8"));
	assert.ok(isRecord(pkg) && isRecord(pkg.scripts));
	return pkg.scripts;
};

describe("TypeScript compiler binary", () => {
	test("npm scripts never invoke a bare tsc", () => {
		for (const [name, command] of Object.entries(scripts())) {
			assert.ok(
				typeof command !== "string" || !BARE_TSC.test(command),
				`script "${name}" runs a bare tsc: ${command}`,
			);
		}
	});

	test("build and typecheck call TypeScript 7 by path", () => {
		const s = scripts();
		for (const name of ["build:dist", "typecheck"]) {
			const command = s[name];
			assert.ok(
				typeof command === "string" && command.includes(TSC_PATH),
				`script "${name}" should call ${TSC_PATH}`,
			);
		}
	});

	test("the pre-commit hook never invokes a bare tsc", () => {
		const commands = readFileSync(".githooks/pre-commit", "utf8")
			.split("\n")
			.filter((line) => !line.trimStart().startsWith("#"));
		for (const line of commands) {
			assert.ok(!BARE_TSC.test(line), `pre-commit runs a bare tsc: ${line}`);
		}
	});

	test("the compiler at that path is TypeScript 7", () => {
		const version = execFileSync(process.execPath, [TSC_PATH, "--version"], {
			encoding: "utf8",
		});
		assert.match(version, /^Version 7\./);
	});
});
