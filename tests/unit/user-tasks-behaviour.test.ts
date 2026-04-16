/**
 * CLI behavioural tests for user-task commands.
 *
 * These tests exercise the full dispatch path by spawning the CLI
 * as a subprocess with --dry-run. They verify that CLI flags flow
 * correctly through index.ts dispatch → validation → handler → JSON output.
 */

import assert from "node:assert";
import { describe, test } from "node:test";
import { c8, parseJson } from "../utils/cli.ts";

// ─── complete user-task ──────────────────────────────────────────────────────

describe("CLI behavioural: complete user-task", () => {
	test("--dry-run emits POST to /user-tasks/:key/completion", async () => {
		const result = await c8("complete", "user-task", "--dry-run", "66666");

		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);

		assert.strictEqual(out.dryRun, true);
		assert.strictEqual(out.method, "POST");
		assert.ok((out.url as string).includes("/user-tasks/66666/completion"));
	});

	test("--dry-run works with ut alias", async () => {
		const result = await c8("complete", "ut", "--dry-run", "66666");

		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);
		assert.strictEqual(out.dryRun, true);
		assert.ok((out.url as string).includes("/user-tasks/66666/completion"));
	});

	test("--dry-run includes variables when provided", async () => {
		const result = await c8(
			"complete",
			"ut",
			"--dry-run",
			"66666",
			"--variables",
			'{"approved":true}',
		);

		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const body = parseJson(result).body as Record<string, unknown>;
		assert.deepStrictEqual(body.variables, { approved: true });
	});

	test("rejects missing user-task key with exit code 1", async () => {
		const result = await c8("complete", "ut");

		assert.strictEqual(result.status, 1);
		assert.ok(
			result.stderr.includes("User task key required"),
			`stderr: ${result.stderr}`,
		);
	});
});
