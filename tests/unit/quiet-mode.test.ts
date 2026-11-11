/**
 * Behaviour tests for the global --quiet / -q flag.
 *
 * Quiet hides status chatter (informational and success messages) but
 * never a command's answer, its data, warnings or errors.
 */

import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { c8WithEnv } from "../utils/cli.ts";

let dataDir: string;

beforeEach(() => {
	dataDir = mkdtempSync(join(tmpdir(), "c8ctl-quiet-"));
});

afterEach(() => {
	rmSync(dataDir, { recursive: true, force: true });
});

const run = (mode: "text" | "json", ...args: string[]) =>
	c8WithEnv({ C8CTL_DATA_DIR: dataDir, C8CTL_OUTPUT_MODE: mode }, ...args);

const addProfile = (mode: "text" | "json", ...flags: string[]) =>
	run(
		mode,
		...flags,
		"add",
		"profile",
		"quiet-test",
		"--baseUrl",
		"http://localhost:8080",
	);

describe("--quiet", () => {
	test("without it, a mutating command reports success", async () => {
		const result = await addProfile("text");
		assert.strictEqual(result.status, 0, result.stderr);
		assert.match(result.stdout, /Profile 'quiet-test' added/);
	});

	for (const flag of ["--quiet", "-q"]) {
		test(`${flag} hides the success message`, async () => {
			const result = await addProfile("text", flag);
			assert.strictEqual(result.status, 0, result.stderr);
			assert.strictEqual(result.stdout, "");
			assert.strictEqual(result.stderr, "");
		});
	}

	test("works after the verb too", async () => {
		const result = await run(
			"text",
			"add",
			"profile",
			"quiet-test",
			"--baseUrl",
			"http://localhost:8080",
			"--quiet",
		);
		assert.strictEqual(result.status, 0, result.stderr);
		assert.strictEqual(result.stdout, "");
	});

	test("the command still takes effect", async () => {
		await addProfile("text", "--quiet");
		const result = await run("json", "list", "profiles");
		assert.match(result.stdout, /quiet-test/);
	});

	test("in JSON mode, hides the success status record", async () => {
		const result = await addProfile("json", "--quiet");
		assert.strictEqual(result.status, 0, result.stderr);
		assert.strictEqual(result.stdout, "");
		assert.strictEqual(result.stderr, "");
	});

	test("keeps a command's answer", async () => {
		const result = await run("text", "which", "profile", "--quiet");
		assert.strictEqual(result.status, 0, result.stderr);
		assert.notStrictEqual(result.stdout.trim(), "");
	});

	test("keeps the version", async () => {
		const result = await run("text", "--version", "--quiet");
		assert.strictEqual(result.status, 0, result.stderr);
		assert.match(result.stdout, /^c8ctl v/);
	});

	test("keeps data output", async () => {
		await addProfile("text");
		const result = await run("json", "list", "profiles", "--quiet");
		assert.strictEqual(result.status, 0, result.stderr);
		assert.match(result.stdout, /quiet-test/);
	});

	test("keeps warnings", async () => {
		const result = await run(
			"text",
			"which",
			"profile",
			"--no-such-flag",
			"--quiet",
		);
		assert.match(result.stderr, /no-such-flag/);
	});

	test("keeps errors", async () => {
		const result = await run("text", "use", "profile", "missing", "--quiet");
		assert.notStrictEqual(result.status, 0);
		assert.match(result.stderr, /missing/);
	});
});

describe("--quiet in help", () => {
	test("is listed as a global flag", async () => {
		const result = await run("text", "help");
		assert.match(result.stdout, /^\s+--quiet, -q\s+\S/m);
	});
});
