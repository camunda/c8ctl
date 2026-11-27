import assert from "node:assert";
import { describe, test } from "node:test";
import { suspensionRows } from "../../src/utils/command-local/suspension-rows.ts";

describe("suspensionRows", () => {
	test("maps each version to a row carrying the batch operation key", () => {
		const rows = suspensionRows({
			processDefinitions: [
				{
					processDefinitionKey: "1",
					processDefinitionVersion: 1,
					outcome: "SUSPENDED",
				},
				{
					processDefinitionKey: "2",
					processDefinitionVersion: 2,
					outcome: "ALREADY_SUSPENDED",
				},
			],
			batchOperationKey: "42",
		});

		assert.deepStrictEqual(rows, [
			{
				processDefinitionKey: "1",
				version: 1,
				outcome: "SUSPENDED",
				batchOperationKey: "42",
			},
			{
				processDefinitionKey: "2",
				version: 2,
				outcome: "ALREADY_SUSPENDED",
				batchOperationKey: "42",
			},
		]);
	});

	test("keeps a missing batch operation key as null", () => {
		const rows = suspensionRows({
			processDefinitions: [
				{
					processDefinitionKey: "1",
					processDefinitionVersion: 3,
					outcome: "RESUMED",
				},
			],
			batchOperationKey: null,
		});

		assert.strictEqual(rows[0].batchOperationKey, null);
	});

	test("returns no rows when no version was affected", () => {
		assert.deepStrictEqual(
			suspensionRows({ processDefinitions: [], batchOperationKey: null }),
			[],
		);
	});
});
