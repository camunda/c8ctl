/**
 * CLI behavioural tests for message commands.
 *
 * These tests exercise the full dispatch path by spawning the CLI
 * as a subprocess with --dry-run. They verify that CLI flags flow
 * correctly through index.ts dispatch → validation → handler → JSON output.
 */

import assert from "node:assert";
import { describe, test } from "node:test";
import { c8, parseJson } from "../utils/cli.ts";
import { asRecord, getUrl } from "../utils/guards.ts";

// ─── publish message ─────────────────────────────────────────────────────────

describe("CLI behavioural: publish message", () => {
	test("--dry-run emits POST to /messages/publication", async () => {
		const result = await c8("publish", "message", "--dry-run", "my-message");

		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);

		assert.strictEqual(out.dryRun, true);
		assert.strictEqual(out.method, "POST");
		assert.ok(getUrl(out).includes("/messages/publication"));

		const body = asRecord(out.body, "dry-run body");
		assert.strictEqual(body.name, "my-message");
	});

	test("--dry-run includes correlationKey", async () => {
		const result = await c8(
			"publish",
			"msg",
			"--dry-run",
			"my-message",
			"--correlationKey",
			"order-123",
		);

		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const body = asRecord(parseJson(result).body, "dry-run body");
		assert.strictEqual(body.correlationKey, "order-123");
	});

	test("--dry-run includes variables when provided", async () => {
		const result = await c8(
			"publish",
			"msg",
			"--dry-run",
			"my-message",
			"--variables",
			'{"orderId":"123"}',
		);

		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const body = asRecord(parseJson(result).body, "dry-run body");
		assert.deepStrictEqual(body.variables, { orderId: "123" });
	});

	test("--dry-run includes timeToLive when provided", async () => {
		const result = await c8(
			"publish",
			"msg",
			"--dry-run",
			"my-message",
			"--timeToLive",
			"60000",
		);

		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const body = asRecord(parseJson(result).body, "dry-run body");
		assert.strictEqual(body.timeToLive, 60000);
	});

	test("rejects missing message name with exit code 1", async () => {
		const result = await c8("publish", "msg");

		assert.strictEqual(result.status, 1);
		assert.ok(
			result.stderr.includes("Message name required"),
			`stderr: ${result.stderr}`,
		);
	});
});

// ─── correlate message ───────────────────────────────────────────────────────

describe("CLI behavioural: correlate message", () => {
	test("--dry-run emits POST to /messages/correlation", async () => {
		const result = await c8("correlate", "message", "--dry-run", "my-message");

		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);

		assert.strictEqual(out.dryRun, true);
		assert.strictEqual(out.method, "POST");
		assert.ok(getUrl(out).includes("/messages/correlation"));

		const body = asRecord(out.body, "dry-run body");
		assert.strictEqual(body.name, "my-message");
	});

	test("--dry-run includes correlationKey and variables", async () => {
		const result = await c8(
			"correlate",
			"msg",
			"--dry-run",
			"my-message",
			"--correlationKey",
			"order-456",
			"--variables",
			'{"status":"done"}',
		);

		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const body = asRecord(parseJson(result).body, "dry-run body");
		assert.strictEqual(body.correlationKey, "order-456");
		assert.deepStrictEqual(body.variables, { status: "done" });
	});

	test("rejects missing message name with exit code 1", async () => {
		const result = await c8("correlate", "msg");

		assert.strictEqual(result.status, 1);
		assert.ok(
			result.stderr.includes("Message name required"),
			`stderr: ${result.stderr}`,
		);
	});
});
