/**
 * CLI behavioural tests for job commands.
 *
 * These tests exercise the full dispatch path by spawning the CLI
 * as a subprocess with --dry-run. They verify that CLI flags flow
 * correctly through index.ts dispatch → validation → handler → JSON output.
 */

import assert from "node:assert";
import { describe, test } from "node:test";
import { c8, parseJson } from "../utils/cli.ts";

// ─── activate jobs ───────────────────────────────────────────────────────────

describe("CLI behavioural: activate jobs", () => {
	test("--dry-run emits POST to /jobs/activation with defaults", async () => {
		const result = await c8("activate", "jobs", "--dry-run", "my-job-type");

		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);

		assert.strictEqual(out.dryRun, true);
		assert.strictEqual(out.method, "POST");
		assert.ok((out.url as string).endsWith("/jobs/activation"));

		const body = out.body as Record<string, unknown>;
		assert.strictEqual(body.type, "my-job-type");
		assert.strictEqual(body.maxJobsToActivate, 10);
		assert.strictEqual(body.timeout, 60000);
		assert.strictEqual(body.worker, "c8ctl");
	});

	test("--dry-run respects custom --maxJobsToActivate", async () => {
		const result = await c8(
			"activate",
			"jobs",
			"--dry-run",
			"my-job-type",
			"--maxJobsToActivate",
			"5",
		);

		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const body = parseJson(result).body as Record<string, unknown>;
		assert.strictEqual(body.maxJobsToActivate, 5);
	});

	test("--dry-run respects custom --timeout and --worker", async () => {
		const result = await c8(
			"activate",
			"jobs",
			"--dry-run",
			"my-job-type",
			"--timeout",
			"30000",
			"--worker",
			"custom-worker",
		);

		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const body = parseJson(result).body as Record<string, unknown>;
		assert.strictEqual(body.timeout, 30000);
		assert.strictEqual(body.worker, "custom-worker");
	});

	test("rejects missing job type with exit code 1", async () => {
		const result = await c8("activate", "jobs");

		assert.strictEqual(result.status, 1);
		assert.ok(
			result.stderr.includes("Job type required"),
			`stderr: ${result.stderr}`,
		);
	});
});

// ─── complete job ────────────────────────────────────────────────────────────

describe("CLI behavioural: complete job", () => {
	test("--dry-run emits POST to /jobs/:key/completion", async () => {
		const result = await c8("complete", "job", "--dry-run", "99999");

		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);

		assert.strictEqual(out.dryRun, true);
		assert.strictEqual(out.method, "POST");
		assert.ok((out.url as string).includes("/jobs/99999/completion"));
	});

	test("--dry-run includes variables when provided", async () => {
		const result = await c8(
			"complete",
			"job",
			"--dry-run",
			"99999",
			"--variables",
			'{"result":"ok"}',
		);

		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const body = parseJson(result).body as Record<string, unknown>;
		assert.deepStrictEqual(body.variables, { result: "ok" });
	});

	test("rejects missing job key with exit code 1", async () => {
		const result = await c8("complete", "job");

		assert.strictEqual(result.status, 1);
		assert.ok(
			result.stderr.includes("Job key required"),
			`stderr: ${result.stderr}`,
		);
	});
});

// ─── fail job ────────────────────────────────────────────────────────────────

describe("CLI behavioural: fail job", () => {
	test("--dry-run emits POST to /jobs/:key/failure with defaults", async () => {
		const result = await c8("fail", "job", "--dry-run", "88888");

		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);

		assert.strictEqual(out.dryRun, true);
		assert.strictEqual(out.method, "POST");
		assert.ok((out.url as string).includes("/jobs/88888/failure"));

		const body = out.body as Record<string, unknown>;
		assert.strictEqual(body.retries, 0);
		assert.strictEqual(body.errorMessage, "Job failed via c8ctl");
	});

	test("--dry-run respects custom --retries and --errorMessage", async () => {
		const result = await c8(
			"fail",
			"job",
			"--dry-run",
			"88888",
			"--retries",
			"3",
			"--errorMessage",
			"custom error",
		);

		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const body = parseJson(result).body as Record<string, unknown>;
		assert.strictEqual(body.retries, 3);
		assert.strictEqual(body.errorMessage, "custom error");
	});

	test("rejects missing job key with exit code 1", async () => {
		const result = await c8("fail", "job");

		assert.strictEqual(result.status, 1);
		assert.ok(
			result.stderr.includes("Job key required"),
			`stderr: ${result.stderr}`,
		);
	});
});
