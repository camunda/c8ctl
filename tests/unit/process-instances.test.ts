/**
 * Unit tests for process-instances commands
 */

import assert from "node:assert";
import { describe, test } from "node:test";
import {
	parseActivateFlag,
	parseMigrationMapping,
	parseModificationInstructions,
	parseMoveFlag,
	parseTerminateFlag,
	processInstancesEmptyMessage,
	toBatchMoveInstruction,
} from "../../src/utils/index.ts";

describe("Process Instances Table Formatting", () => {
	/**
	 * The table row mapping used in listProcessInstances.
	 * Mirrors the logic in src/commands/process-instances.ts.
	 */
	const formatRow = (pi: {
		hasIncident?: boolean;
		processInstanceKey?: string;
		key?: string;
		processDefinitionId?: string;
		state?: string;
		processDefinitionVersion?: number | string;
		version?: number | string;
		startDate?: string;
		tenantId?: string;
	}) => ({
		Key: `${pi.hasIncident ? "⚠ " : ""}${pi.processInstanceKey || pi.key}`,
		"Process ID": pi.processDefinitionId,
		State: pi.state,
		Version: pi.processDefinitionVersion || pi.version,
		"Start Date": pi.startDate || "-",
		"Tenant ID": pi.tenantId,
	});

	test("Key shows ⚠ prefix when hasIncident is true", () => {
		const row = formatRow({
			processInstanceKey: "123456789",
			hasIncident: true,
			processDefinitionId: "my-process",
			state: "ACTIVE",
		});
		assert.ok(
			row.Key.startsWith("⚠ "),
			"Key should start with ⚠ when hasIncident is true",
		);
		assert.ok(
			row.Key.includes("123456789"),
			"Key should include the process instance key",
		);
		assert.strictEqual(row.Key, "⚠ 123456789");
	});

	test("Key has no prefix when hasIncident is false", () => {
		const row = formatRow({
			processInstanceKey: "987654321",
			hasIncident: false,
			processDefinitionId: "my-process",
			state: "ACTIVE",
		});
		assert.ok(
			!row.Key.includes("⚠"),
			"Key should not include ⚠ when hasIncident is false",
		);
		assert.strictEqual(row.Key, "987654321");
	});

	test("Key has no prefix when hasIncident is undefined", () => {
		const row = formatRow({
			processInstanceKey: "111222333",
			processDefinitionId: "my-process",
			state: "COMPLETED",
		});
		assert.ok(
			!row.Key.includes("⚠"),
			"Key should not include ⚠ when hasIncident is undefined",
		);
		assert.strictEqual(row.Key, "111222333");
	});

	test("Key falls back to pi.key when processInstanceKey is absent", () => {
		const row = formatRow({
			key: "444555666",
			hasIncident: true,
			processDefinitionId: "fallback-process",
			state: "ACTIVE",
		});
		assert.strictEqual(row.Key, "⚠ 444555666");
	});
});

describe("processInstancesEmptyMessage", () => {
	test("surfaces the default ACTIVE state filter", () => {
		assert.strictEqual(
			processInstancesEmptyMessage({ tenantId: "<default>", state: "ACTIVE" }),
			"No ACTIVE process instances found",
		);
	});

	test("surfaces an explicit state filter (e.g. COMPLETED)", () => {
		assert.strictEqual(
			processInstancesEmptyMessage({ state: "COMPLETED" }),
			"No COMPLETED process instances found",
		);
	});

	test("omits the state adjective when no state filter is applied (--all)", () => {
		assert.strictEqual(
			processInstancesEmptyMessage({ tenantId: "<default>" }),
			"No process instances found",
		);
	});

	test("appends process id and version qualifiers", () => {
		assert.strictEqual(
			processInstancesEmptyMessage({
				state: "ACTIVE",
				processDefinitionId: "order-process",
				processDefinitionVersion: 2,
			}),
			'No ACTIVE process instances found for process "order-process", version 2',
		);
	});

	test("includes a non-default tenant but not the default tenant", () => {
		assert.strictEqual(
			processInstancesEmptyMessage({ state: "ACTIVE", tenantId: "acme" }),
			'No ACTIVE process instances found for tenant "acme"',
		);
		assert.strictEqual(
			processInstancesEmptyMessage({ state: "ACTIVE", tenantId: "<default>" }),
			"No ACTIVE process instances found",
		);
	});

	test("notes an applied date range", () => {
		assert.strictEqual(
			processInstancesEmptyMessage({
				state: "ACTIVE",
				startDate: { $gt: "2024-01-01" },
			}),
			"No ACTIVE process instances found for startDate within the given range",
		);
	});
});

describe("parseMigrationMapping", () => {
	test("splits source and target element IDs on '='", () => {
		assert.deepStrictEqual(parseMigrationMapping("Task_A=Task_A2"), {
			sourceElementId: "Task_A",
			targetElementId: "Task_A2",
		});
	});

	test("trims whitespace around both IDs", () => {
		assert.deepStrictEqual(parseMigrationMapping(" Task_A = Task_A2 "), {
			sourceElementId: "Task_A",
			targetElementId: "Task_A2",
		});
	});

	test("allows mapping an element onto the same ID", () => {
		assert.deepStrictEqual(parseMigrationMapping("Task_A=Task_A"), {
			sourceElementId: "Task_A",
			targetElementId: "Task_A",
		});
	});

	for (const invalid of ["Task_A", "=Task_A2", "Task_A=", " = ", "a=b=c", ""]) {
		test(`rejects malformed mapping ${JSON.stringify(invalid)}`, () => {
			assert.throws(
				() => parseMigrationMapping(invalid),
				/expected <sourceElementId>=<targetElementId>/,
			);
		});
	}
});

describe("parseActivateFlag", () => {
	test("builds an activate instruction from an element ID", () => {
		assert.deepStrictEqual(parseActivateFlag(" Task_A "), {
			elementId: "Task_A",
		});
	});

	test("rejects an element instance key, which cannot be activated", () => {
		assert.throws(() => parseActivateFlag("2251799813685249"), /element ID/);
	});

	for (const invalid of ["", "  ", "Task A"]) {
		test(`rejects ${JSON.stringify(invalid)}`, () => {
			assert.throws(() => parseActivateFlag(invalid), /element ID/);
		});
	}
});

describe("parseTerminateFlag", () => {
	test("terminates by element ID for a BPMN element ID", () => {
		assert.deepStrictEqual(parseTerminateFlag("Task_A"), {
			elementId: "Task_A",
		});
	});

	test("terminates by element instance key for an all-digit value", () => {
		assert.deepStrictEqual(parseTerminateFlag("2251799813685249"), {
			elementInstanceKey: "2251799813685249",
		});
	});

	for (const invalid of ["", "Task A"]) {
		test(`rejects ${JSON.stringify(invalid)}`, () => {
			assert.throws(() => parseTerminateFlag(invalid), /element ID/);
		});
	}
});

describe("parseMoveFlag", () => {
	test("moves by source element ID", () => {
		assert.deepStrictEqual(parseMoveFlag("Task_A=Task_B"), {
			sourceElementInstruction: {
				sourceType: "byId",
				sourceElementId: "Task_A",
			},
			targetElementId: "Task_B",
		});
	});

	test("moves by source element instance key for an all-digit source", () => {
		assert.deepStrictEqual(parseMoveFlag(" 2251799813685249 = Task_B "), {
			sourceElementInstruction: {
				sourceType: "byKey",
				sourceElementInstanceKey: "2251799813685249",
			},
			targetElementId: "Task_B",
		});
	});

	test("rejects an element instance key as the target", () => {
		assert.throws(
			() => parseMoveFlag("Task_A=2251799813685249"),
			/target must be an element ID/,
		);
	});

	for (const invalid of ["Task_A", "=Task_B", "Task_A=", "a=b=c", ""]) {
		test(`rejects malformed move ${JSON.stringify(invalid)}`, () => {
			assert.throws(
				() => parseMoveFlag(invalid),
				/expected <sourceElementId\|sourceElementInstanceKey>=<targetElementId>/,
			);
		});
	}
});

describe("toBatchMoveInstruction", () => {
	test("flattens a by-ID move into the batch shape", () => {
		assert.deepStrictEqual(
			toBatchMoveInstruction(parseMoveFlag("Task_A=Task_B")),
			{ sourceElementId: "Task_A", targetElementId: "Task_B" },
		);
	});

	test("rejects a by-key move, which batch modification does not support", () => {
		assert.throws(
			() => toBatchMoveInstruction(parseMoveFlag("123=Task_B")),
			/batch modification only supports moves by source element ID/,
		);
	});
});

describe("parseModificationInstructions", () => {
	test("accepts every instruction kind with all optional fields", () => {
		const input = {
			activateInstructions: [
				{
					elementId: "Task_A",
					ancestorElementInstanceKey: "-1",
					variableInstructions: [
						{ variables: { retry: true }, scopeId: "SubProcess_1" },
					],
				},
			],
			moveInstructions: [
				{
					sourceElementInstruction: {
						sourceType: "byKey",
						sourceElementInstanceKey: "2251799813685300",
					},
					targetElementId: "Task_B",
					ancestorScopeInstruction: { ancestorScopeType: "sourceParent" },
					variableInstructions: [{ variables: { x: 1 } }],
				},
				{
					sourceElementInstruction: {
						sourceType: "byId",
						sourceElementId: "Task_C",
					},
					targetElementId: "Task_D",
					ancestorScopeInstruction: {
						ancestorScopeType: "direct",
						ancestorElementInstanceKey: "2251799813685301",
					},
				},
				{
					sourceElementInstruction: {
						sourceType: "byId",
						sourceElementId: "Task_E",
					},
					targetElementId: "Task_F",
					ancestorScopeInstruction: { ancestorScopeType: "inferred" },
				},
			],
			terminateInstructions: [
				{ elementId: "Task_G" },
				{ elementInstanceKey: "2251799813685302" },
			],
			operationReference: 42,
		};

		assert.deepStrictEqual(parseModificationInstructions(input), input);
	});

	test("accepts safe-integer keys and normalises them to strings", () => {
		assert.deepStrictEqual(
			parseModificationInstructions({
				activateInstructions: [
					{ elementId: "Task_A", ancestorElementInstanceKey: -1 },
				],
				terminateInstructions: [{ elementInstanceKey: 123 }],
			}),
			{
				activateInstructions: [
					{ elementId: "Task_A", ancestorElementInstanceKey: "-1" },
				],
				terminateInstructions: [{ elementInstanceKey: "123" }],
			},
		);
	});

	const rejected: Array<[string, unknown, RegExp]> = [
		["a non-object", [], /must be a JSON object/],
		[
			"an unknown top-level field",
			{ activate: [] },
			/unknown field "activate"/,
		],
		[
			"a non-array instruction list",
			{ activateInstructions: { elementId: "A" } },
			/activateInstructions must be an array/,
		],
		[
			"an activate without elementId",
			{ activateInstructions: [{}] },
			/activateInstructions\[0\]\.elementId/,
		],
		[
			"an unknown field inside an instruction",
			{ terminateInstructions: [{ elementId: "A", force: true }] },
			/terminateInstructions\[0\]: unknown field "force"/,
		],
		[
			"a terminate with both elementId and elementInstanceKey",
			{ terminateInstructions: [{ elementId: "A", elementInstanceKey: "1" }] },
			/exactly one of elementId or elementInstanceKey/,
		],
		[
			"an unknown sourceType",
			{
				moveInstructions: [
					{
						sourceElementInstruction: { sourceType: "byName" },
						targetElementId: "B",
					},
				],
			},
			/sourceType must be "byId" or "byKey"/,
		],
		[
			"an unknown ancestorScopeType",
			{
				moveInstructions: [
					{
						sourceElementInstruction: {
							sourceType: "byId",
							sourceElementId: "A",
						},
						targetElementId: "B",
						ancestorScopeInstruction: { ancestorScopeType: "parent" },
					},
				],
			},
			/ancestorScopeType must be "direct", "inferred" or "sourceParent"/,
		],
		[
			"a direct ancestor scope without a key",
			{
				moveInstructions: [
					{
						sourceElementInstruction: {
							sourceType: "byId",
							sourceElementId: "A",
						},
						targetElementId: "B",
						ancestorScopeInstruction: { ancestorScopeType: "direct" },
					},
				],
			},
			/ancestorScopeInstruction\.ancestorElementInstanceKey/,
		],
		[
			"non-object variables",
			{
				activateInstructions: [
					{ elementId: "A", variableInstructions: [{ variables: [1] }] },
				],
			},
			/variableInstructions\[0\]\.variables must be a JSON object/,
		],
		[
			"a key that is not an integer",
			{ terminateInstructions: [{ elementInstanceKey: "12a" }] },
			/elementInstanceKey must be an integer key/,
		],
		[
			"a key number beyond the safe-integer range",
			// Parsed from JSON text, as `--instructions` is, so the key arrives
			// as an already-rounded number.
			JSON.parse(
				'{"terminateInstructions":[{"elementInstanceKey":2251799813685249123}]}',
			),
			/pass large keys as strings/,
		],
		[
			"a non-positive operationReference",
			{ operationReference: 0 },
			/operationReference must be a positive integer/,
		],
	];
	for (const [name, input, message] of rejected) {
		test(`rejects ${name}`, () => {
			assert.throws(() => parseModificationInstructions(input), message);
		});
	}
});
