/**
 * CLI behavioural tests for process-instance commands.
 *
 * These tests exercise the full dispatch path by spawning the CLI
 * as a subprocess with --dry-run. They verify that CLI flags flow
 * correctly through index.ts dispatch → validation → handler → JSON output.
 */

import assert from "node:assert";
import { describe, test } from "node:test";
import { c8, c8WithOptions, parseJson } from "../utils/cli.ts";
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

// ─── modify process-instance ─────────────────────────────────────────────────

describe("CLI behavioural: modify process-instance", () => {
	test("--dry-run emits every shorthand instruction to the single-instance endpoint", async () => {
		const result = await c8(
			"modify",
			"pi",
			"12345",
			"--dry-run",
			"--activate",
			"Task_A",
			"--terminate",
			"Task_B",
			"--terminate",
			"2251799813685300",
			"--move",
			"Task_C=Task_D",
			"--move",
			"2251799813685301=Task_E",
			"--operationReference",
			"7",
		);

		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);

		assert.strictEqual(out.dryRun, true);
		assert.strictEqual(out.method, "POST");
		assert.ok(getUrl(out).endsWith("/process-instances/12345/modification"));
		assert.deepStrictEqual(out.body, {
			activateInstructions: [{ elementId: "Task_A" }],
			moveInstructions: [
				{
					sourceElementInstruction: {
						sourceType: "byId",
						sourceElementId: "Task_C",
					},
					targetElementId: "Task_D",
				},
				{
					sourceElementInstruction: {
						sourceType: "byKey",
						sourceElementInstanceKey: "2251799813685301",
					},
					targetElementId: "Task_E",
				},
			],
			terminateInstructions: [
				{ elementId: "Task_B" },
				{ elementInstanceKey: "2251799813685300" },
			],
			operationReference: 7,
		});
	});

	test("--instructions from stdin is merged ahead of shorthand instructions", async () => {
		const instructions = {
			activateInstructions: [
				{
					elementId: "Task_A",
					ancestorElementInstanceKey: "2251799813685302",
					variableInstructions: [{ variables: { retry: true } }],
				},
			],
		};
		const result = await c8WithOptions(
			{ stdin: JSON.stringify(instructions) },
			"modify",
			"pi",
			"12345",
			"--dry-run",
			"--instructions",
			"@-",
			"--activate",
			"Task_B",
		);

		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);
		assert.deepStrictEqual(out.body, {
			activateInstructions: [
				...instructions.activateInstructions,
				{ elementId: "Task_B" },
			],
		});
	});

	test("a repeated --instructions keeps the last value", async () => {
		const result = await c8(
			"modify",
			"pi",
			"12345",
			"--dry-run",
			"--instructions",
			'{"activateInstructions":[{"elementId":"Task_A"}]}',
			"--instructions",
			'{"terminateInstructions":[{"elementId":"Task_B"}]}',
		);

		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);
		assert.deepStrictEqual(out.body, {
			terminateInstructions: [{ elementId: "Task_B" }],
		});
	});

	test("--processDefinitionKey without an instance key emits a batch modification", async () => {
		const result = await c8(
			"modify",
			"process-instances",
			"--dry-run",
			"--processDefinitionKey",
			"11111",
			"--move",
			"Task_A=Task_B",
		);

		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);

		assert.strictEqual(out.method, "POST");
		assert.ok(getUrl(out).endsWith("/process-instances/modification"));
		assert.deepStrictEqual(out.body, {
			filter: { processDefinitionKey: "11111" },
			moveInstructions: [
				{ sourceElementId: "Task_A", targetElementId: "Task_B" },
			],
		});
	});

	const rejected: Array<[string, string[], string]> = [
		[
			"no instructions",
			["pi", "12345"],
			"At least one modification instruction is required",
		],
		[
			"neither an instance key nor --processDefinitionKey",
			["pi", "--move", "a=b"],
			"Process instance key or --processDefinitionKey required",
		],
		[
			"both an instance key and --processDefinitionKey",
			["pi", "12345", "--processDefinitionKey", "11111", "--move", "a=b"],
			"not both",
		],
		[
			"a malformed --move",
			["pi", "12345", "--move", "Task_A"],
			"Invalid --move",
		],
		[
			"an element instance key passed to --activate",
			["pi", "12345", "--activate", "123"],
			"Invalid --activate",
		],
		[
			"invalid --instructions JSON",
			["pi", "12345", "--instructions", "{not json"],
			"Invalid JSON for --instructions",
		],
		[
			"an unknown field in --instructions",
			["pi", "12345", "--instructions", '{"activate":[]}'],
			"unknown field",
		],
		[
			"a non-positive --operationReference",
			["pi", "12345", "--move", "a=b", "--operationReference", "0"],
			"Invalid --operationReference",
		],
		[
			"--operationReference given twice",
			[
				"pi",
				"12345",
				"--instructions",
				'{"operationReference":1}',
				"--operationReference",
				"2",
			],
			"not both",
		],
		[
			"--activate in batch mode",
			["pi", "--processDefinitionKey", "11111", "--activate", "Task_A"],
			"Batch modification only supports --move",
		],
		[
			"--terminate in batch mode",
			["pi", "--processDefinitionKey", "11111", "--terminate", "Task_A"],
			"Batch modification only supports --move",
		],
		[
			"--instructions in batch mode",
			["pi", "--processDefinitionKey", "11111", "--instructions", "{}"],
			"Batch modification only supports --move",
		],
		[
			"a by-key --move in batch mode",
			["pi", "--processDefinitionKey", "11111", "--move", "123=Task_B"],
			"batch modification only supports moves by source element ID",
		],
		// An empty instruction (e.g. from an unset shell variable) must fail
		// rather than be dropped, which would apply only part of the plan.
		[
			"an empty --activate next to a valid --terminate",
			["pi", "12345", "--activate", "", "--terminate", "Task_A"],
			"Invalid --activate: value must not be empty",
		],
		[
			"an empty --terminate next to a valid --activate",
			["pi", "12345", "--terminate", "", "--activate", "Task_B"],
			"Invalid --terminate: value must not be empty",
		],
		[
			"an empty --move next to a valid --move",
			["pi", "12345", "--move", "Task_A=Task_B", "--move", ""],
			"Invalid --move: value must not be empty",
		],
		[
			"an empty --activate among repeated valid ones",
			["pi", "12345", "--activate", "Task_A", "--activate", ""],
			"Invalid --activate: value must not be empty",
		],
		[
			"an empty --instructions next to a valid --activate",
			["pi", "12345", "--instructions", "", "--activate", "Task_B"],
			"Invalid --instructions: value must not be empty",
		],
		// --instructions is not repeatable, so the parser keeps only its last
		// value; an empty earlier occurrence must still be caught.
		[
			"an empty --instructions followed by a valid one",
			[
				"pi",
				"12345",
				"--instructions",
				"",
				"--instructions",
				'{"terminateInstructions":[{"elementId":"Task_A"}]}',
			],
			"Invalid --instructions: value must not be empty",
		],
		[
			"an --instructions with no value followed by a valid one",
			[
				"pi",
				"12345",
				"--instructions",
				"--instructions",
				'{"terminateInstructions":[{"elementId":"Task_A"}]}',
			],
			"Invalid --instructions: value must not be empty",
		],
		[
			"an --activate with no value before another flag",
			["pi", "12345", "--activate", "--terminate", "Task_A"],
			"Invalid --activate: value must not be empty",
		],
		[
			"an empty --activate in batch mode",
			[
				"pi",
				"--processDefinitionKey",
				"11111",
				"--activate",
				"",
				"--move",
				"Task_A=Task_B",
			],
			"Invalid --activate: value must not be empty",
		],
	];
	for (const [name, args, message] of rejected) {
		test(`rejects ${name} even in dry-run`, async () => {
			const result = await c8("modify", ...args, "--dry-run");

			assert.strictEqual(result.status, 1);
			assert.ok(result.stderr.includes(message), `stderr: ${result.stderr}`);
		});
	}
});
