/**
 * CLI behavioural tests for job commands.
 *
 * These tests exercise the full dispatch path by spawning the CLI
 * as a subprocess with --dry-run. They verify that CLI flags flow
 * correctly through index.ts dispatch → validation → handler → JSON output.
 */

import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, test } from "node:test";
import { c8, parseJson } from "../utils/cli.ts";
import { asRecord, asRecordArray, getUrl, isRecord } from "../utils/guards.ts";
import { asyncSpawn } from "../utils/spawn.ts";

const CLI = resolve(import.meta.dirname, "..", "..", "src", "index.ts");

/**
 * Pull the listening port off a Node `http.Server` without an `as` cast.
 */
function getServerPort(server: Server): number {
	const addr = server.address();
	if (isRecord(addr) && typeof addr.port === "number") {
		return addr.port;
	}
	throw new Error("mock server has no port (not listening?)");
}

/**
 * Start a mock HTTP server and return its URL.
 * The handler is provided by the caller so each test can customise the response.
 */
async function startMockServer(
	handler: (
		req: import("node:http").IncomingMessage,
		res: import("node:http").ServerResponse,
	) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
	const server: Server = createServer(handler);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const port = getServerPort(server);
	return {
		url: `http://127.0.0.1:${port}/v2`,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

/**
 * Spawn the CLI against a mock server URL with output mode set to JSON.
 * No credentials are supplied so the SDK uses CAMUNDA_AUTH_STRATEGY=NONE.
 */
async function c8WithMockServer(
	mockBaseUrl: string,
	...args: string[]
): ReturnType<typeof asyncSpawn> {
	const dataDir = mkdtempSync(join(tmpdir(), "c8ctl-jobs-mock-"));
	writeFileSync(
		join(dataDir, "session.json"),
		JSON.stringify({ outputMode: "json" }),
	);
	try {
		return await asyncSpawn(
			"node",
			["--experimental-strip-types", CLI, ...args],
			{
				env: {
					PATH: process.env.PATH,
					CAMUNDA_BASE_URL: mockBaseUrl,
					HOME: "/tmp/c8ctl-test-nonexistent-home",
					C8CTL_DATA_DIR: dataDir,
				},
			},
		);
	} finally {
		rmSync(dataDir, { recursive: true, force: true });
	}
}

// ─── activate jobs ───────────────────────────────────────────────────────────

describe("CLI behavioural: activate jobs", () => {
	test("--dry-run emits POST to /jobs/activation with defaults", async () => {
		const result = await c8("activate", "jobs", "--dry-run", "my-job-type");

		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);

		assert.strictEqual(out.dryRun, true);
		assert.strictEqual(out.method, "POST");
		assert.ok(getUrl(out).endsWith("/jobs/activation"));

		const body = asRecord(out.body, "dry-run body");
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
		const body = asRecord(parseJson(result).body, "dry-run body");
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
		const body = asRecord(parseJson(result).body, "dry-run body");
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

	test("--dry-run does not include customHeaders by default", async () => {
		const result = await c8("activate", "jobs", "--dry-run", "my-job-type");

		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const body = asRecord(parseJson(result).body, "dry-run body");
		assert.strictEqual(body.customHeaders, undefined);
	});

	test("--customHeaders flag is accepted without error", async () => {
		const result = await c8(
			"activate",
			"jobs",
			"--dry-run",
			"my-job-type",
			"--customHeaders",
		);

		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const body = asRecord(parseJson(result).body, "dry-run body");
		// --customHeaders is a display flag only; it must not appear in the API body
		assert.strictEqual(body.customHeaders, undefined);
	});
});

// ─── activate jobs with customHeaders response ───────────────────────────────
//
// --customHeaders comes from the API response, so these tests require a mock
// HTTP server: --dry-run exits before the API call and cannot exercise the
// rendering path.

describe("CLI behavioural: activate jobs --customHeaders rendering", () => {
	let server: { url: string; close: () => Promise<void> } | null = null;

	afterEach(async () => {
		if (server) {
			await server.close();
			server = null;
		}
	});

	test("--customHeaders includes headers as an object in JSON output", async () => {
		const mockJob = {
			jobKey: "123456",
			type: "my-job-type",
			retries: 3,
			processInstanceKey: "789",
			customHeaders: { "x-foo": "bar", "x-count": 42 },
			worker: "c8ctl",
			deadline: Date.now() + 60000,
			elementId: "task1",
			processDefinitionId: "process1",
			processDefinitionVersion: 1,
			processDefinitionKey: "pd1",
			tenantId: "<default>",
			variables: {},
		};
		server = await startMockServer((_req, res) => {
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ jobs: [mockJob] }));
		});

		const result = await c8WithMockServer(
			server.url,
			"activate",
			"jobs",
			"--customHeaders",
			"my-job-type",
		);

		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		// JSON output: table renders as a JSON array
		const rows = asRecordArray(JSON.parse(result.stdout), "output rows");
		assert.ok(rows.length > 0, "expected at least one row");
		const row = asRecord(rows[0], "first row");
		// "Custom Headers" must be a plain object, not a JSON string
		assert.deepStrictEqual(row["Custom Headers"], {
			"x-foo": "bar",
			"x-count": 42,
		});
	});

	test("without --customHeaders the field is absent from output", async () => {
		const mockJob = {
			jobKey: "123456",
			type: "my-job-type",
			retries: 3,
			processInstanceKey: "789",
			customHeaders: { "x-foo": "bar" },
			worker: "c8ctl",
			deadline: Date.now() + 60000,
			elementId: "task1",
			processDefinitionId: "process1",
			processDefinitionVersion: 1,
			processDefinitionKey: "pd1",
			tenantId: "<default>",
			variables: {},
		};
		server = await startMockServer((_req, res) => {
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ jobs: [mockJob] }));
		});

		const result = await c8WithMockServer(
			server.url,
			"activate",
			"jobs",
			"my-job-type",
		);

		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const rows = asRecordArray(JSON.parse(result.stdout), "output rows");
		assert.ok(rows.length > 0, "expected at least one row");
		const row = asRecord(rows[0], "first row");
		assert.strictEqual(
			row["Custom Headers"],
			undefined,
			"Custom Headers should be absent when --customHeaders flag is not passed",
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
		assert.ok(getUrl(out).includes("/jobs/99999/completion"));
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
		const body = asRecord(parseJson(result).body, "dry-run body");
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
		assert.ok(getUrl(out).includes("/jobs/88888/failure"));

		const body = asRecord(out.body, "dry-run body");
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
		const body = asRecord(parseJson(result).body, "dry-run body");
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

// ─── update job ──────────────────────────────────────────────────────────────

describe("CLI behavioural: update job", () => {
	test("--dry-run emits PATCH to /jobs/:key with retries", async () => {
		const result = await c8(
			"update",
			"job",
			"--dry-run",
			"77777",
			"--retries",
			"3",
		);

		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);

		assert.strictEqual(out.dryRun, true);
		assert.strictEqual(out.method, "PATCH");
		assert.ok(getUrl(out).includes("/jobs/77777"));

		const body = asRecord(out.body, "dry-run body");
		const changeset = asRecord(body.changeset, "changeset");
		assert.strictEqual(changeset.retries, 3);
		assert.strictEqual(changeset.timeout, undefined);
	});

	test("--dry-run emits PATCH to /jobs/:key with timeout", async () => {
		const result = await c8(
			"update",
			"job",
			"--dry-run",
			"77777",
			"--timeout",
			"60000",
		);

		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const body = asRecord(parseJson(result).body, "dry-run body");
		const changeset = asRecord(body.changeset, "changeset");
		assert.strictEqual(changeset.timeout, 60000);
		assert.strictEqual(changeset.retries, undefined);
	});

	test("--dry-run accepts both --retries and --timeout", async () => {
		const result = await c8(
			"update",
			"job",
			"--dry-run",
			"77777",
			"--retries",
			"5",
			"--timeout",
			"30000",
		);

		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const body = asRecord(parseJson(result).body, "dry-run body");
		const changeset = asRecord(body.changeset, "changeset");
		assert.strictEqual(changeset.retries, 5);
		assert.strictEqual(changeset.timeout, 30000);
	});

	test("rejects missing job key with exit code 1", async () => {
		const result = await c8("update", "job");

		assert.strictEqual(result.status, 1);
		assert.ok(
			result.stderr.includes("Job key required"),
			`stderr: ${result.stderr}`,
		);
	});

	test("rejects missing --retries and --timeout with exit code 1", async () => {
		const result = await c8("update", "job", "--dry-run", "77777");

		assert.strictEqual(result.status, 1);
		assert.ok(
			result.stderr.includes("--retries or --timeout"),
			`stderr: ${result.stderr}`,
		);
	});

	test("rejects invalid --retries value with exit code 1", async () => {
		const result = await c8(
			"update",
			"job",
			"--dry-run",
			"77777",
			"--retries",
			"abc",
		);

		assert.strictEqual(result.status, 1);
		assert.ok(result.stderr.includes("--retries"), `stderr: ${result.stderr}`);
	});

	test("rejects invalid --timeout value with exit code 1", async () => {
		const result = await c8(
			"update",
			"job",
			"--dry-run",
			"77777",
			"--timeout",
			"0",
		);

		assert.strictEqual(result.status, 1);
		assert.ok(result.stderr.includes("--timeout"), `stderr: ${result.stderr}`);
	});

	test("--dry-run includes operationReference in body when provided", async () => {
		const result = await c8(
			"update",
			"job",
			"--dry-run",
			"77777",
			"--retries",
			"3",
			"--operationReference",
			"9999",
		);

		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);
		assert.strictEqual(out.method, "PATCH");
		assert.ok(getUrl(out).includes("/jobs/77777"));
		const body = asRecord(out.body, "dry-run body");
		assert.strictEqual(body.operationReference, 9999);
	});

	test("rejects invalid --operationReference value with exit code 1", async () => {
		const result = await c8(
			"update",
			"job",
			"--dry-run",
			"77777",
			"--retries",
			"3",
			"--operationReference",
			"not-a-number",
		);

		assert.strictEqual(result.status, 1);
		assert.ok(
			result.stderr.includes("--operationReference"),
			`stderr: ${result.stderr}`,
		);
	});
});
