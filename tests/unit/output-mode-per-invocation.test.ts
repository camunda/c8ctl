/**
 * Per-invocation output mode override tests (#356).
 *
 * Covers the `--json` global flag and the `C8CTL_OUTPUT_MODE` env var.
 * Both are per-invocation overrides and MUST NOT mutate the persisted
 * `session.json` outputMode — that file is owned by the `c8 output` command.
 *
 * Precedence (highest first):
 *   1. `--json` flag
 *   2. `C8CTL_OUTPUT_MODE` env var
 *   3. persisted session state
 */

import assert from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { makeTestEnv } from "../utils/mocks.ts";
import { asyncSpawn } from "../utils/spawn.ts";

const PROJECT_ROOT = resolve(import.meta.dirname, "..", "..");
const CLI = join(PROJECT_ROOT, "src", "index.ts");

let dataDir = "";

function cli(
	args: string[],
	extraEnv: Record<string, string> = {},
): Promise<ReturnType<typeof asyncSpawn> extends Promise<infer R> ? R : never> {
	return asyncSpawn("node", ["--experimental-strip-types", CLI, ...args], {
		cwd: PROJECT_ROOT,
		env: makeTestEnv({ C8CTL_DATA_DIR: dataDir, ...extraEnv }),
	});
}

function writeSession(outputMode: "text" | "json"): void {
	writeFileSync(join(dataDir, "session.json"), JSON.stringify({ outputMode }));
}

function readSession(): Record<string, unknown> {
	const raw = readFileSync(join(dataDir, "session.json"), "utf-8");
	return JSON.parse(raw);
}

describe("Per-invocation output mode (#356)", () => {
	beforeEach(() => {
		dataDir = mkdtempSync(join(tmpdir(), "c8ctl-per-inv-output-"));
	});
	afterEach(() => {
		rmSync(dataDir, { recursive: true, force: true });
	});

	describe("--json global flag", () => {
		test("forces JSON output for the invocation when session is text", async () => {
			writeSession("text");
			// `list profile` prints a human-readable table in text mode and
			// JSON in json mode — the contrast is unambiguous.
			const result = await cli(["--json", "list", "profile"]);
			assert.strictEqual(
				result.status,
				0,
				`exit ${result.status}; stderr=${result.stderr}`,
			);
			assert.doesNotThrow(
				() => JSON.parse(result.stdout),
				`stdout must be valid JSON under --json, got: ${result.stdout}`,
			);
		});

		test("does NOT mutate persisted session.json", async () => {
			writeSession("text");
			const before = readSession();
			await cli(["--json", "list", "profile"]);
			const after = readSession();
			assert.deepStrictEqual(
				after,
				before,
				"session.json must be unchanged after --json invocation",
			);
		});
	});

	describe("C8CTL_OUTPUT_MODE env var", () => {
		test("forces JSON output when set to 'json'", async () => {
			writeSession("text");
			const result = await cli(["list", "profile"], {
				C8CTL_OUTPUT_MODE: "json",
			});
			assert.strictEqual(
				result.status,
				0,
				`exit ${result.status}; stderr=${result.stderr}`,
			);
			assert.doesNotThrow(
				() => JSON.parse(result.stdout),
				`stdout must be valid JSON under env override, got: ${result.stdout}`,
			);
		});

		test("does NOT mutate persisted session.json", async () => {
			writeSession("text");
			const before = readSession();
			await cli(["list", "profile"], { C8CTL_OUTPUT_MODE: "json" });
			const after = readSession();
			assert.deepStrictEqual(after, before);
		});

		test("invalid value falls back to persisted mode (no error)", async () => {
			writeSession("text");
			const result = await cli(["list", "profile"], {
				C8CTL_OUTPUT_MODE: "yaml",
			});
			assert.strictEqual(
				result.status,
				0,
				`exit ${result.status}; stderr=${result.stderr}`,
			);
			assert.throws(
				() => JSON.parse(result.stdout),
				`invalid env var should fall back to text (table); got JSON: ${result.stdout}`,
			);
		});
	});

	describe("Precedence", () => {
		test("--json flag overrides C8CTL_OUTPUT_MODE=text", async () => {
			writeSession("text");
			const result = await cli(["--json", "list", "profile"], {
				C8CTL_OUTPUT_MODE: "text",
			});
			assert.doesNotThrow(
				() => JSON.parse(result.stdout),
				`--json must beat env=text, got: ${result.stdout}`,
			);
		});

		test("C8CTL_OUTPUT_MODE=json overrides persisted text", async () => {
			writeSession("text");
			const result = await cli(["list", "profile"], {
				C8CTL_OUTPUT_MODE: "json",
			});
			assert.doesNotThrow(
				() => JSON.parse(result.stdout),
				`env=json must beat persisted=text, got: ${result.stdout}`,
			);
		});
	});

	describe("Persistent setter still works", () => {
		test("`c8 output json` persists JSON to session.json (regression guard)", async () => {
			writeSession("text");
			await cli(["output", "json"]);
			const after = readSession();
			assert.strictEqual(after.outputMode, "json");
		});

		test("`c8 --json use profile foo` does not pollute persisted outputMode", async () => {
			writeSession("text");
			// Use a profile-mutating command WITH --json — the per-invocation
			// override must not leak into the saved session.
			const result = await cli(["--json", "use", "profile", "local"]);
			// Either succeeds (profile exists) or fails — we only care about
			// the persisted state.
			assert.ok(
				result.status === 0 || result.status === 1,
				`unexpected exit ${result.status}`,
			);
			const after = readSession();
			assert.strictEqual(
				after.outputMode,
				"text",
				`persisted outputMode must remain 'text'; got ${JSON.stringify(after)}`,
			);
		});
	});
});
