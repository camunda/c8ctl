/**
 * CLI behavioural tests for incident commands.
 *
 * These tests exercise the full dispatch path by spawning the CLI
 * as a subprocess with --dry-run. They verify that CLI flags flow
 * correctly through index.ts dispatch → validation → handler → JSON output.
 */

import assert from "node:assert";
import { describe, test } from "node:test";
import { c8, parseJson } from "../utils/cli.ts";
import { getUrl } from "../utils/guards.ts";

// ─── resolve incident ────────────────────────────────────────────────────────

describe("CLI behavioural: resolve incident", () => {
	test("--dry-run emits POST to /incidents/:key/resolution", async () => {
		const result = await c8("resolve", "incident", "--dry-run", "77777");

		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);

		assert.strictEqual(out.dryRun, true);
		assert.strictEqual(out.method, "POST");
		assert.ok(getUrl(out).includes("/incidents/77777/resolution"));
	});

	test("--dry-run works with inc alias", async () => {
		const result = await c8("resolve", "inc", "--dry-run", "77777");

		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = parseJson(result);
		assert.strictEqual(out.dryRun, true);
		assert.ok(getUrl(out).includes("/incidents/77777/resolution"));
	});

	test("rejects missing incident key with exit code 1", async () => {
		const result = await c8("resolve", "inc");

		assert.strictEqual(result.status, 1);
		assert.ok(
			result.stderr.includes("Incident key required"),
			`stderr: ${result.stderr}`,
		);
	});
});
