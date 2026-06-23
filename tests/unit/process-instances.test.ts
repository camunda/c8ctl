/**
 * Unit tests for process-instances commands
 */

import assert from "node:assert";
import { describe, test } from "node:test";
import { processInstancesEmptyMessage } from "../../src/utils/index.ts";

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
