/**
 * Behavioural tests for `c8ctl search wait-state`.
 *
 * All tests run the CLI as a subprocess via c8() — no source imports.
 */

import assert from "node:assert";
import { describe, test } from "node:test";
import { c8, parseJson } from "../utils/cli.ts";
import { getFilter } from "../utils/guards.ts";

function assertDryRun(
	out: Record<string, unknown>,
	expected: { method: string; urlSuffix: string },
) {
	assert.strictEqual(out.dryRun, true);
	assert.strictEqual(out.method, expected.method);
	assert.ok(
		typeof out.url === "string" && out.url.endsWith(expected.urlSuffix),
		`Expected URL to end with "${expected.urlSuffix}", got "${String(out.url)}"`,
	);
}

const WAIT_STATE_ENDPOINT = "/element-instances/wait-states/search";

// ═══════════════════════════════════════════════════════════════════════════════
//  Basic dispatch
// ═══════════════════════════════════════════════════════════════════════════════

describe("CLI behavioural: search wait-state", () => {
	test("--dry-run emits POST to /element-instances/wait-states/search", async () => {
		const result = await c8("search", "wait-state", "--dry-run");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assertDryRun(parseJson(result), {
			method: "POST",
			urlSuffix: WAIT_STATE_ENDPOINT,
		});
	});

	test("--dry-run works with full resource name", async () => {
		const result = await c8("search", "wait-states", "--dry-run");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assertDryRun(parseJson(result), {
			method: "POST",
			urlSuffix: WAIT_STATE_ENDPOINT,
		});
	});

	test("ws alias resolves to wait-state", async () => {
		const result = await c8("search", "ws", "--dry-run");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assertDryRun(parseJson(result), {
			method: "POST",
			urlSuffix: WAIT_STATE_ENDPOINT,
		});
	});
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Filter flags
// ═══════════════════════════════════════════════════════════════════════════════

describe("CLI behavioural: search wait-state filter flags", () => {
	test("--processInstanceKey (-k) sets filter.processInstanceKey", async () => {
		const result = await c8(
			"search",
			"wait-state",
			"--dry-run",
			"-k",
			"2251799813685249",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);
		assert.ok(
			getFilter(out).processInstanceKey,
			"Expected filter.processInstanceKey to be set",
		);
	});

	test("--rootProcessInstanceKey (-r) sets filter.rootProcessInstanceKey", async () => {
		const result = await c8(
			"search",
			"wait-state",
			"--dry-run",
			"-r",
			"9999999999999",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);
		assert.ok(
			getFilter(out).rootProcessInstanceKey,
			"Expected filter.rootProcessInstanceKey to be set",
		);
	});

	test("--elementInstanceKey (-e) sets filter.elementInstanceKey", async () => {
		const result = await c8(
			"search",
			"wait-state",
			"--dry-run",
			"-e",
			"3333333333333",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);
		assert.ok(
			getFilter(out).elementInstanceKey,
			"Expected filter.elementInstanceKey to be set",
		);
	});

	test("--elementId sets filter.elementId", async () => {
		const result = await c8(
			"search",
			"wait-state",
			"--dry-run",
			"--elementId",
			"serviceTask1",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);
		assert.ok(getFilter(out).elementId, "Expected filter.elementId to be set");
	});

	test("--elementType sets filter.elementType", async () => {
		const result = await c8(
			"search",
			"wait-state",
			"--dry-run",
			"--elementType",
			"SERVICE_TASK",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);
		assert.strictEqual(getFilter(out).elementType, "SERVICE_TASK");
	});

	test("--waitStateType sets filter.waitStateType", async () => {
		const result = await c8(
			"search",
			"wait-state",
			"--dry-run",
			"--waitStateType",
			"JOB",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);
		assert.strictEqual(getFilter(out).waitStateType, "JOB");
	});

	test("all six filters combined produce correct body", async () => {
		const result = await c8(
			"search",
			"wait-state",
			"--dry-run",
			"-k",
			"100",
			"-r",
			"200",
			"-e",
			"300",
			"--elementId",
			"task1",
			"--elementType",
			"USER_TASK",
			"--waitStateType",
			"MESSAGE",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const filter = getFilter(parseJson(result));
		assert.ok(filter.processInstanceKey, "processInstanceKey");
		assert.ok(filter.rootProcessInstanceKey, "rootProcessInstanceKey");
		assert.ok(filter.elementInstanceKey, "elementInstanceKey");
		assert.ok(filter.elementId, "elementId");
		assert.strictEqual(filter.elementType, "USER_TASK");
		assert.strictEqual(filter.waitStateType, "MESSAGE");
	});
});
