/**
 * Behavioural tests for the instance-state searches:
 * `search element-instance`, `search message-subscription` and
 * `search incident --includeCalled`.
 *
 * All tests run the CLI as a subprocess via c8() — no source imports.
 */

import assert from "node:assert";
import { describe, test } from "node:test";
import { c8, parseJson } from "../utils/cli.ts";
import { getFilter } from "../utils/guards.ts";

const PROCESS_INSTANCE_KEY = "2251799813685249";

function assertDryRun(out: Record<string, unknown>, urlSuffix: string) {
	assert.strictEqual(out.dryRun, true);
	assert.strictEqual(out.method, "POST");
	assert.ok(
		typeof out.url === "string" && out.url.endsWith(urlSuffix),
		`Expected URL to end with "${urlSuffix}", got "${String(out.url)}"`,
	);
}

describe("CLI behavioural: search element-instance", () => {
	test("--dry-run sends the filters to /element-instances/search", async () => {
		const result = await c8(
			"search",
			"ei",
			"--dry-run",
			"-k",
			PROCESS_INSTANCE_KEY,
			"--elementType",
			"SERVICE_TASK",
			"--state",
			"ACTIVE",
		);

		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);
		assertDryRun(out, "/element-instances/search");
		const filter = getFilter(out);
		assert.strictEqual(filter.processInstanceKey, PROCESS_INSTANCE_KEY);
		assert.strictEqual(filter.type, "SERVICE_TASK");
		assert.strictEqual(filter.state, "ACTIVE");
	});
});

describe("CLI behavioural: search message-subscription", () => {
	test("--dry-run sends the filters to /message-subscriptions/search", async () => {
		const result = await c8(
			"search",
			"message-subscriptions",
			"--dry-run",
			"-k",
			PROCESS_INSTANCE_KEY,
			"--messageName",
			"order*",
			"--state",
			"CREATED",
		);

		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);
		assertDryRun(out, "/message-subscriptions/search");
		const filter = getFilter(out);
		assert.strictEqual(filter.processInstanceKey, PROCESS_INSTANCE_KEY);
		assert.deepStrictEqual(filter.messageName, { $like: "order*" });
		assert.strictEqual(filter.messageSubscriptionState, "CREATED");
	});
});

describe("CLI behavioural: search incident --includeCalled", () => {
	test("--dry-run searches the process instance tree", async () => {
		const result = await c8(
			"search",
			"inc",
			"--dry-run",
			"--processInstanceKey",
			PROCESS_INSTANCE_KEY,
			"--includeCalled",
		);

		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);
		assertDryRun(
			out,
			`/process-instances/${PROCESS_INSTANCE_KEY}/incidents/search`,
		);
		assert.strictEqual(getFilter(out).processInstanceKey, undefined);
	});

	test("fails without --processInstanceKey", async () => {
		const result = await c8("--json", "search", "inc", "--includeCalled");

		assert.strictEqual(result.status, 1);
		assert.match(result.stderr, /"code":"invalid-input"/);
		assert.match(result.stderr, /"field":"processInstanceKey"/);
	});
});
