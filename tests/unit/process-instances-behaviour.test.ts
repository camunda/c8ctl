/**
 * CLI behavioural tests for process-instance commands.
 *
 * These tests exercise the full dispatch path by spawning the CLI
 * as a subprocess with --dry-run. They verify that CLI flags flow
 * correctly through index.ts dispatch → validation → handler → JSON output.
 */

import assert from "node:assert";
import { describe, test } from "node:test";
import { c8, parseJson } from "../utils/cli.ts";
import { asRecord, getUrl } from "../utils/guards.ts";

// ─── create process-instance ─────────────────────────────────────────────────

describe("CLI behavioural: create process-instance", () => {
	test("--dry-run emits correct JSON with processDefinitionId", async () => {
		const result = await c8("create", "pi", "--dry-run", "--id", "my-process");

		assert.strictEqual(
			result.status,
			0,
			`CLI exited with ${result.status}\nstderr: ${result.stderr}`,
		);
		const out = parseJson(result);

		assert.strictEqual(out.dryRun, true);
		assert.strictEqual(out.method, "POST");
		assert.ok(getUrl(out).endsWith("/process-instances"));

		const body = asRecord(out.body, "dry-run body");
		assert.strictEqual(body.processDefinitionId, "my-process");
	});

	test("--dry-run includes variables when provided", async () => {
		const result = await c8(
			"create",
			"process-instance",
			"--dry-run",
			"--id",
			"my-process",
			"--variables",
			'{"foo":"bar"}',
		);

		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const body = asRecord(parseJson(result).body, "dry-run body");
		assert.deepStrictEqual(body.variables, { foo: "bar" });
	});

	test("--dry-run includes businessId when provided", async () => {
		const result = await c8(
			"create",
			"pi",
			"--dry-run",
			"--id",
			"my-process",
			"--businessId",
			"order-123",
		);

		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const body = asRecord(parseJson(result).body, "dry-run body");
		assert.strictEqual(body.businessId, "order-123");
	});

	test("--dry-run includes version when provided", async () => {
		const result = await c8(
			"create",
			"pi",
			"--dry-run",
			"--id",
			"my-process",
			"--version",
			"3",
		);

		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const body = asRecord(parseJson(result).body, "dry-run body");
		assert.strictEqual(body.processDefinitionVersion, 3);
	});

	test("--dry-run includes awaitCompletion when set", async () => {
		const result = await c8(
			"create",
			"pi",
			"--dry-run",
			"--id",
			"my-process",
			"--awaitCompletion",
		);

		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const body = asRecord(parseJson(result).body, "dry-run body");
		assert.strictEqual(body.awaitCompletion, true);
	});

	test("--dry-run includes requestTimeout when provided", async () => {
		const result = await c8(
			"create",
			"pi",
			"--dry-run",
			"--id",
			"my-process",
			"--awaitCompletion",
			"--requestTimeout",
			"5000",
		);

		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const body = asRecord(parseJson(result).body, "dry-run body");
		assert.strictEqual(body.requestTimeout, 5000);
	});

	test("rejects missing --id with exit code 1", async () => {
		const result = await c8("create", "pi", "--dry-run");

		assert.strictEqual(result.status, 1);
		assert.ok(
			result.stderr.includes("processDefinitionId is required") ||
				result.stderr.includes("is required"),
			`stderr: ${result.stderr}`,
		);
	});

	test("rejects invalid variables JSON during dry-run", async () => {
		const result = await c8(
			"create",
			"pi",
			"--dry-run",
			"--id",
			"my-process",
			"--variables",
			"not-json",
		);

		assert.strictEqual(result.status, 1);
		assert.ok(
			result.stderr.includes("Invalid JSON for variables"),
			`stderr: ${result.stderr}`,
		);
	});
});

// ─── await process-instance (alias for create --awaitCompletion) ─────────────

describe("CLI behavioural: await process-instance", () => {
	test("--dry-run emits create with awaitCompletion=true", async () => {
		const result = await c8("await", "pi", "--dry-run", "--id", "my-process");

		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);
		assert.strictEqual(out.dryRun, true);
		assert.strictEqual(out.method, "POST");

		const body = asRecord(out.body, "dry-run body");
		assert.strictEqual(body.processDefinitionId, "my-process");
		assert.strictEqual(body.awaitCompletion, true);
	});

	test("rejects invalid variables JSON during dry-run", async () => {
		const result = await c8(
			"await",
			"pi",
			"--dry-run",
			"--id",
			"my-process",
			"--variables",
			"not-json",
		);

		assert.strictEqual(result.status, 1);
		assert.ok(
			result.stderr.includes("Invalid JSON for variables"),
			`stderr: ${result.stderr}`,
		);
	});

	test("--dry-run includes businessId when provided", async () => {
		const result = await c8(
			"await",
			"pi",
			"--dry-run",
			"--id",
			"my-process",
			"--businessId",
			"claim-456",
		);

		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const body = asRecord(parseJson(result).body, "dry-run body");
		assert.strictEqual(body.businessId, "claim-456");
	});
});

// ─── cancel process-instance ─────────────────────────────────────────────────

describe("CLI behavioural: cancel process-instance", () => {
	test("--dry-run emits POST to cancellation endpoint", async () => {
		const result = await c8("cancel", "pi", "--dry-run", "12345");

		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);

		assert.strictEqual(out.dryRun, true);
		assert.strictEqual(out.method, "POST");
		assert.ok(getUrl(out).includes("/process-instances/12345/cancellation"));
	});

	test("rejects missing key with exit code 1", async () => {
		const result = await c8("cancel", "pi");

		assert.strictEqual(result.status, 1);
		assert.ok(
			result.stderr.includes("Process instance key required"),
			`stderr: ${result.stderr}`,
		);
	});
});

// ─── suspend process-instance ────────────────────────────────────────────────

describe("CLI behavioural: suspend process-instance", () => {
	test("--dry-run emits POST to suspension endpoint", async () => {
		const result = await c8("suspend", "pi", "--dry-run", "12345");

		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);

		assert.strictEqual(out.dryRun, true);
		assert.strictEqual(out.method, "POST");
		assert.ok(getUrl(out).includes("/process-instances/12345/suspension"));
	});

	test("rejects missing key with exit code 1", async () => {
		const result = await c8("suspend", "pi");

		assert.strictEqual(result.status, 1);
		assert.ok(
			result.stderr.includes("Process instance key required"),
			`stderr: ${result.stderr}`,
		);
	});
});

// ─── resume process-instance ─────────────────────────────────────────────────

describe("CLI behavioural: resume process-instance", () => {
	test("--dry-run emits POST to resumption endpoint", async () => {
		const result = await c8("resume", "pi", "--dry-run", "12345");

		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);

		assert.strictEqual(out.dryRun, true);
		assert.strictEqual(out.method, "POST");
		assert.ok(getUrl(out).includes("/process-instances/12345/resumption"));
	});

	test("rejects missing key with exit code 1", async () => {
		const result = await c8("resume", "pi");

		assert.strictEqual(result.status, 1);
		assert.ok(
			result.stderr.includes("Process instance key required"),
			`stderr: ${result.stderr}`,
		);
	});
});

// ─── migrate process-instance ────────────────────────────────────────────────

describe("CLI behavioural: migrate process-instance", () => {
	test("--dry-run emits POST to the single-instance migration endpoint", async () => {
		const result = await c8(
			"migrate",
			"pi",
			"12345",
			"--dry-run",
			"--targetProcessDefinitionKey",
			"67890",
			"--map",
			"Task_A=Task_A2",
			"--map",
			"Task_B=Task_B",
		);

		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);

		assert.strictEqual(out.dryRun, true);
		assert.strictEqual(out.method, "POST");
		assert.ok(getUrl(out).endsWith("/process-instances/12345/migration"));
		assert.deepStrictEqual(out.body, {
			targetProcessDefinitionKey: "67890",
			mappingInstructions: [
				{ sourceElementId: "Task_A", targetElementId: "Task_A2" },
				{ sourceElementId: "Task_B", targetElementId: "Task_B" },
			],
		});
	});

	test("--processDefinitionKey without an instance key emits a batch migration", async () => {
		const result = await c8(
			"migrate",
			"process-instances",
			"--dry-run",
			"--processDefinitionKey",
			"11111",
			"--targetProcessDefinitionKey",
			"67890",
			"--map",
			"Task_A=Task_A2",
		);

		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);

		assert.strictEqual(out.method, "POST");
		assert.ok(getUrl(out).endsWith("/process-instances/migration"));
		assert.deepStrictEqual(out.body, {
			filter: { processDefinitionKey: "11111" },
			migrationPlan: {
				targetProcessDefinitionKey: "67890",
				mappingInstructions: [
					{ sourceElementId: "Task_A", targetElementId: "Task_A2" },
				],
			},
		});
	});

	test("rejects missing --targetProcessDefinitionKey", async () => {
		const result = await c8("migrate", "pi", "12345", "--map", "a=b");

		assert.strictEqual(result.status, 1);
		assert.ok(
			result.stderr.includes("--targetProcessDefinitionKey is required"),
			`stderr: ${result.stderr}`,
		);
	});

	test("rejects a non-numeric --targetProcessDefinitionKey", async () => {
		const result = await c8(
			"migrate",
			"pi",
			"12345",
			"--targetProcessDefinitionKey",
			"not-a-key",
			"--map",
			"a=b",
		);

		assert.strictEqual(result.status, 1);
		assert.ok(
			result.stderr.includes("Invalid --targetProcessDefinitionKey"),
			`stderr: ${result.stderr}`,
		);
	});

	test("rejects missing --map", async () => {
		const result = await c8(
			"migrate",
			"pi",
			"12345",
			"--dry-run",
			"--targetProcessDefinitionKey",
			"67890",
		);

		assert.strictEqual(result.status, 1);
		assert.ok(
			result.stderr.includes("At least one --map"),
			`stderr: ${result.stderr}`,
		);
	});

	test("rejects a malformed --map even in dry-run", async () => {
		const result = await c8(
			"migrate",
			"pi",
			"12345",
			"--dry-run",
			"--targetProcessDefinitionKey",
			"67890",
			"--map",
			"Task_A",
		);

		assert.strictEqual(result.status, 1);
		assert.ok(
			result.stderr.includes("Invalid --map"),
			`stderr: ${result.stderr}`,
		);
	});

	test("rejects neither an instance key nor --processDefinitionKey", async () => {
		const result = await c8(
			"migrate",
			"pi",
			"--dry-run",
			"--targetProcessDefinitionKey",
			"67890",
			"--map",
			"a=b",
		);

		assert.strictEqual(result.status, 1);
		assert.ok(
			result.stderr.includes(
				"Process instance key or --processDefinitionKey required",
			),
			`stderr: ${result.stderr}`,
		);
	});

	test("rejects both an instance key and --processDefinitionKey", async () => {
		const result = await c8(
			"migrate",
			"pi",
			"12345",
			"--dry-run",
			"--processDefinitionKey",
			"11111",
			"--targetProcessDefinitionKey",
			"67890",
			"--map",
			"a=b",
		);

		assert.strictEqual(result.status, 1);
		assert.ok(result.stderr.includes("not both"), `stderr: ${result.stderr}`);
	});
});
