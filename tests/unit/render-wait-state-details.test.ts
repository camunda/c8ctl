/**
 * Unit tests for renderWaitStateDetails — the pure function that
 * converts type-specific wait-state detail payloads into a
 * human-readable string for the CLI table's "Details" column.
 */

import assert from "node:assert";
import { describe, test } from "node:test";
import { renderWaitStateDetails } from "../../src/utils/command-local/search-helpers.ts";

// ─── Non-record / missing inputs ──────────────────────────────────────────────

describe("renderWaitStateDetails — non-record inputs", () => {
	test("null returns dash", () => {
		assert.strictEqual(renderWaitStateDetails(null), "-");
	});

	test("undefined returns dash", () => {
		assert.strictEqual(renderWaitStateDetails(undefined), "-");
	});

	test("string returns dash", () => {
		assert.strictEqual(renderWaitStateDetails("not-an-object"), "-");
	});

	test("number returns dash", () => {
		assert.strictEqual(renderWaitStateDetails(42), "-");
	});
});

// ─── JOB ──────────────────────────────────────────────────────────────────────

describe("renderWaitStateDetails — JOB", () => {
	test("returns jobType when present", () => {
		assert.strictEqual(
			renderWaitStateDetails({
				waitStateType: "JOB",
				jobType: "io.camunda:http-json:1",
			}),
			"io.camunda:http-json:1",
		);
	});

	test("returns dash when jobType is missing", () => {
		assert.strictEqual(renderWaitStateDetails({ waitStateType: "JOB" }), "-");
	});

	test("returns dash when jobType is not a string", () => {
		assert.strictEqual(
			renderWaitStateDetails({ waitStateType: "JOB", jobType: 123 }),
			"-",
		);
	});
});

// ─── MESSAGE ──────────────────────────────────────────────────────────────────

describe("renderWaitStateDetails — MESSAGE", () => {
	test("returns messageName when present", () => {
		assert.strictEqual(
			renderWaitStateDetails({
				waitStateType: "MESSAGE",
				messageName: "paymentReceived",
			}),
			"paymentReceived",
		);
	});

	test("returns dash when messageName is missing", () => {
		assert.strictEqual(
			renderWaitStateDetails({ waitStateType: "MESSAGE" }),
			"-",
		);
	});

	test("returns dash when messageName is not a string", () => {
		assert.strictEqual(
			renderWaitStateDetails({ waitStateType: "MESSAGE", messageName: 999 }),
			"-",
		);
	});
});

// ─── TIMER ────────────────────────────────────────────────────────────────────

describe("renderWaitStateDetails — TIMER", () => {
	test("returns ISO date when dueDate is a number and repetitions is 0", () => {
		const dueDate = new Date("2025-06-20T12:00:00Z").getTime();
		assert.strictEqual(
			renderWaitStateDetails({
				waitStateType: "TIMER",
				dueDate,
				repetitions: 0,
			}),
			"2025-06-20T12:00:00.000Z",
		);
	});

	test("returns ISO date without repetitions when repetitions is absent", () => {
		const dueDate = new Date("2025-06-20T12:00:00Z").getTime();
		assert.strictEqual(
			renderWaitStateDetails({ waitStateType: "TIMER", dueDate }),
			"2025-06-20T12:00:00.000Z",
		);
	});

	test("returns ISO date with infinite symbol when repetitions is -1", () => {
		const dueDate = new Date("2025-06-20T12:00:00Z").getTime();
		const result = renderWaitStateDetails({
			waitStateType: "TIMER",
			dueDate,
			repetitions: -1,
		});
		assert.strictEqual(result, "2025-06-20T12:00:00.000Z (\u221E)");
	});

	test("returns ISO date with multiplier when repetitions is positive", () => {
		const dueDate = new Date("2025-06-20T12:00:00Z").getTime();
		const result = renderWaitStateDetails({
			waitStateType: "TIMER",
			dueDate,
			repetitions: 5,
		});
		assert.strictEqual(result, "2025-06-20T12:00:00.000Z (\u00D75)");
	});

	test("returns dash when dueDate is missing", () => {
		assert.strictEqual(renderWaitStateDetails({ waitStateType: "TIMER" }), "-");
	});

	test("returns dash when dueDate is not a number", () => {
		assert.strictEqual(
			renderWaitStateDetails({ waitStateType: "TIMER", dueDate: "2025-06-20" }),
			"-",
		);
	});
});

// ─── USER_TASK ────────────────────────────────────────────────────────────────

describe("renderWaitStateDetails — USER_TASK", () => {
	test("returns stringified taskKey when present", () => {
		assert.strictEqual(
			renderWaitStateDetails({ waitStateType: "USER_TASK", taskKey: 12345678 }),
			"12345678",
		);
	});

	test("returns string taskKey as-is", () => {
		assert.strictEqual(
			renderWaitStateDetails({
				waitStateType: "USER_TASK",
				taskKey: "2251799813685249",
			}),
			"2251799813685249",
		);
	});

	test("returns dash when taskKey is undefined", () => {
		assert.strictEqual(
			renderWaitStateDetails({ waitStateType: "USER_TASK" }),
			"-",
		);
	});
});

// ─── SIGNAL ───────────────────────────────────────────────────────────────────

describe("renderWaitStateDetails — SIGNAL", () => {
	test("returns signalName when present", () => {
		assert.strictEqual(
			renderWaitStateDetails({
				waitStateType: "SIGNAL",
				signalName: "approvalGranted",
			}),
			"approvalGranted",
		);
	});

	test("returns dash when signalName is missing", () => {
		assert.strictEqual(
			renderWaitStateDetails({ waitStateType: "SIGNAL" }),
			"-",
		);
	});

	test("returns dash when signalName is not a string", () => {
		assert.strictEqual(
			renderWaitStateDetails({ waitStateType: "SIGNAL", signalName: 42 }),
			"-",
		);
	});
});

// ─── CONDITION ────────────────────────────────────────────────────────────────

describe("renderWaitStateDetails — CONDITION", () => {
	test("returns short expression verbatim", () => {
		assert.strictEqual(
			renderWaitStateDetails({
				waitStateType: "CONDITION",
				expression: "= ready",
			}),
			"= ready",
		);
	});

	test("truncates expression longer than 40 chars with ellipsis", () => {
		const longExpr = "= someVariable > 10 AND anotherVariable < 100 AND foo";
		const result = renderWaitStateDetails({
			waitStateType: "CONDITION",
			expression: longExpr,
		});
		assert.strictEqual(result, `${longExpr.slice(0, 40)}\u2026`);
		assert.strictEqual(result.length, 41); // 40 chars + ellipsis
	});

	test("returns expression of exactly 40 chars without truncation", () => {
		const exact40 = "a".repeat(40);
		assert.strictEqual(
			renderWaitStateDetails({
				waitStateType: "CONDITION",
				expression: exact40,
			}),
			exact40,
		);
	});

	test("returns dash when expression is missing", () => {
		assert.strictEqual(
			renderWaitStateDetails({ waitStateType: "CONDITION" }),
			"-",
		);
	});

	test("returns dash when expression is not a string", () => {
		assert.strictEqual(
			renderWaitStateDetails({ waitStateType: "CONDITION", expression: 42 }),
			"-",
		);
	});
});

// ─── Unknown type ─────────────────────────────────────────────────────────────

describe("renderWaitStateDetails — unknown type", () => {
	test("returns dash for unrecognised waitStateType", () => {
		assert.strictEqual(
			renderWaitStateDetails({ waitStateType: "UNKNOWN_TYPE" }),
			"-",
		);
	});

	test("returns dash when waitStateType is missing", () => {
		assert.strictEqual(renderWaitStateDetails({ someField: "value" }), "-");
	});
});
