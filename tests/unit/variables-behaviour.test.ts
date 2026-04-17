/**
 * CLI behavioural tests for the "set variable" command.
 *
 * These tests exercise the full dispatch path by spawning the CLI
 * as a subprocess with --dry-run. They verify that CLI flags flow
 * correctly through index.ts dispatch → validation → handler → JSON output.
 */

import assert from "node:assert";
import { describe, test } from "node:test";
import { c8, parseJson } from "../utils/cli.ts";
import { asRecord, getUrl } from "../utils/guards.ts";

describe("CLI behavioural: set variable", () => {
	test("--dry-run emits PUT to /element-instances/{key}/variables", async () => {
		const result = await c8(
			"set",
			"variable",
			"2251799813685249",
			"--variables",
			'{"status":"approved"}',
			"--dry-run",
		);

		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);

		assert.strictEqual(out.dryRun, true);
		assert.strictEqual(out.method, "PUT");
		assert.ok(
			getUrl(out).includes("/element-instances/2251799813685249/variables"),
			`URL: ${getUrl(out)}`,
		);

		const body = asRecord(out.body, "dry-run body");
		assert.deepStrictEqual(body.variables, { status: "approved" });
	});

	test("--dry-run includes local=true when --local is passed", async () => {
		const result = await c8(
			"set",
			"variable",
			"2251799813685249",
			"--variables",
			'{"x":1}',
			"--local",
			"--dry-run",
		);

		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const body = asRecord(parseJson(result).body, "dry-run body");
		assert.strictEqual(body.local, true);
	});

	test("--dry-run does not include local when --local is not passed", async () => {
		const result = await c8(
			"set",
			"variable",
			"2251799813685249",
			"--variables",
			'{"x":1}',
			"--dry-run",
		);

		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const body = asRecord(parseJson(result).body, "dry-run body");
		assert.strictEqual(body.local, undefined);
	});

	test("accepts 'var' alias for 'variable'", async () => {
		const result = await c8(
			"set",
			"var",
			"2251799813685249",
			"--variables",
			'{"y":2}',
			"--dry-run",
		);

		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assert.ok(getUrl(parseJson(result)).includes("/element-instances/"));
	});

	test("rejects missing element instance key with exit code 1", async () => {
		const result = await c8("set", "variable", "--variables", '{"x":1}');

		assert.strictEqual(result.status, 1);
	});

	test("rejects missing --variables flag with exit code 1", async () => {
		const result = await c8("set", "variable", "2251799813685249", "--dry-run");

		assert.strictEqual(result.status, 1);
		assert.ok(
			result.stderr.includes("Failed to set variable"),
			`expected framework prefix; stderr: ${result.stderr}`,
		);
		assert.ok(
			result.stderr.includes("--variables is required"),
			`stderr: ${result.stderr}`,
		);
	});

	test("rejects invalid JSON in --variables with exit code 1", async () => {
		const result = await c8(
			"set",
			"variable",
			"2251799813685249",
			"--variables",
			"not-json",
			"--dry-run",
		);

		assert.strictEqual(result.status, 1);
		assert.ok(
			result.stderr.includes("Failed to set variable"),
			`expected framework prefix; stderr: ${result.stderr}`,
		);
		assert.ok(
			result.stderr.includes("Invalid JSON"),
			`stderr: ${result.stderr}`,
		);
	});

	test("rejects JSON array in --variables with exit code 1", async () => {
		const result = await c8(
			"set",
			"variable",
			"2251799813685249",
			"--variables",
			"[1,2,3]",
			"--dry-run",
		);

		assert.strictEqual(result.status, 1);
		assert.ok(
			result.stderr.includes("Invalid JSON"),
			`stderr: ${result.stderr}`,
		);
	});
});
