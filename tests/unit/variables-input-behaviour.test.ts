/**
 * CLI behavioural tests for `--variables` input handling (#528).
 *
 * Inline JSON is quoting-hostile: PowerShell strips or re-splits the quotes
 * of a native command argument, so `{"a":"b"}` reaches the CLI as `{a:b}`.
 * These tests pin the quoting-proof escape hatches (`@file`, `@-`) and the
 * actionable hint emitted when inline JSON arrives mangled.
 */

import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { c8, parseJson } from "../utils/cli.ts";
import { asRecord } from "../utils/guards.ts";
import { asyncSpawnWithStdin } from "../utils/spawn.ts";

const CLI = "src/index.ts";

const TMP_DIR = mkdtempSync(join(tmpdir(), "c8ctl-variables-input-"));
after(() => rmSync(TMP_DIR, { recursive: true, force: true }));

function writeVars(name: string, contents: string): string {
	const path = join(TMP_DIR, name);
	writeFileSync(path, contents);
	return path;
}

/**
 * Spawn the CLI with JSON on stdin so `--variables @-` can be exercised.
 */
async function c8WithStdin(input: string, ...args: string[]) {
	const dataDir = mkdtempSync(join(tmpdir(), "c8ctl-variables-stdin-"));
	writeFileSync(
		join(dataDir, "session.json"),
		JSON.stringify({ outputMode: "json" }),
	);
	try {
		return await asyncSpawnWithStdin(
			"node",
			["--experimental-strip-types", CLI, ...args],
			(stdin) => {
				stdin.write(input);
			},
			{
				env: {
					...process.env,
					CAMUNDA_BASE_URL: "http://test-cluster/v2",
					HOME: "/tmp/c8ctl-test-nonexistent-home",
					C8CTL_DATA_DIR: dataDir,
				},
			},
		);
	} finally {
		rmSync(dataDir, { recursive: true, force: true });
	}
}

describe("CLI behavioural: --variables input", () => {
	test("reads variables from an @file reference", async () => {
		const path = writeVars("vars.json", '{"a":{"b":[1,2]},"c":"x y"}');
		const result = await c8(
			"complete",
			"job",
			"2251799813685249",
			"--variables",
			`@${path}`,
			"--dry-run",
		);

		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const body = asRecord(parseJson(result).body, "dry-run body");
		assert.deepStrictEqual(body.variables, { a: { b: [1, 2] }, c: "x y" });
	});

	test("reads variables from stdin via @-", async () => {
		const result = await c8WithStdin(
			'{"discoveryQuestions":[{"id":"Question 1","q":"why?"}]}',
			"create",
			"pi",
			"--id",
			"my-process",
			"--variables",
			"@-",
			"--dry-run",
		);

		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const body = asRecord(parseJson(result).body, "dry-run body");
		assert.deepStrictEqual(body.variables, {
			discoveryQuestions: [{ id: "Question 1", q: "why?" }],
		});
	});

	test("shell-mangled inline JSON fails with a quoting hint", async () => {
		// {a:b} is what PowerShell leaves behind after stripping the quotes
		// of {"a":"b"}.
		const result = await c8(
			"complete",
			"job",
			"2251799813685249",
			"--variables",
			"{a:b}",
			"--dry-run",
		);

		assert.strictEqual(result.status, 1);
		assert.ok(
			result.stderr.includes("--variables @vars.json"),
			`expected quoting hint; stderr: ${result.stderr}`,
		);
		assert.ok(
			result.stderr.includes("PowerShell"),
			`expected PowerShell mention; stderr: ${result.stderr}`,
		);
	});

	test("missing @file is reported with the path", async () => {
		const result = await c8(
			"complete",
			"job",
			"2251799813685249",
			"--variables",
			`@${join(TMP_DIR, "does-not-exist.json")}`,
			"--dry-run",
		);

		assert.strictEqual(result.status, 1);
		assert.ok(
			result.stderr.includes("Cannot read variables file"),
			`stderr: ${result.stderr}`,
		);
	});

	test("non-object JSON is rejected", async () => {
		const path = writeVars("array.json", "[1,2,3]");
		const result = await c8(
			"publish",
			"message",
			"my-message",
			"--variables",
			`@${path}`,
			"--dry-run",
		);

		assert.strictEqual(result.status, 1);
		assert.ok(
			result.stderr.includes("--variables must be a JSON object"),
			`stderr: ${result.stderr}`,
		);
		assert.ok(
			result.stderr.includes(path),
			`expected the file to be named as the source; stderr: ${result.stderr}`,
		);
	});
});
