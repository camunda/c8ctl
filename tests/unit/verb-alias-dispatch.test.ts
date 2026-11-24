/**
 * End-to-end tests that verb aliases dispatch correctly (#407).
 *
 * Before this fix, alias verbs (w, rm) were rejected with
 * "Unknown command" because the dispatch key was built from the raw
 * alias instead of the canonical verb. These tests prove that alias
 * verbs now reach their handlers.
 */

import assert from "node:assert";
import { describe, test } from "node:test";
import { c8 } from "../utils/cli.ts";

describe("verb alias dispatch (#407)", () => {
	test("'w' dispatches to watch handler", async () => {
		// watch requires a valid path — use a non-existent one so the handler
		// fails fast. The key assertion: the error comes from the watch handler
		// (framework prefix + handler error) not from the dispatcher ("Unknown command").
		const result = await c8("w", "nonexistent.bpmn");
		assert.strictEqual(result.status, 1);
		assert.ok(
			result.stderr.includes("Path does not exist"),
			`expected watch handler path error, got: ${result.stderr}`,
		);
		assert.ok(
			!result.stderr.includes("Unknown command"),
			"verb alias 'w' should not produce 'Unknown command'",
		);
	});

	test("'rm profile' dispatches to remove handler", async () => {
		const result = await c8("rm", "profile", "nonexistent-profile");
		assert.strictEqual(result.status, 1);
		assert.ok(
			result.stderr.includes("not found"),
			`expected remove handler 'not found' error, got: ${result.stderr}`,
		);
		assert.ok(
			!result.stderr.includes("Unknown command"),
			"verb alias 'rm' should not produce 'Unknown command'",
		);
	});

	test("'rm' without resource shows verb help (not unknown command)", async () => {
		// rm requires a resource — should show available resources, not "Unknown command".
		// Help text is written to stdout, so check combined output.
		const result = await c8("rm");
		assert.strictEqual(
			result.status,
			1,
			`unexpected exit code: ${result.stderr}`,
		);
		const combined = result.stdout + result.stderr;
		assert.ok(
			combined.includes("resources"),
			`expected verb help with resource list, got: ${combined}`,
		);
		assert.ok(
			!combined.includes("Unknown command"),
			"verb alias 'rm' without resource should not produce 'Unknown command'",
		);
	});

	test("'rm plugin' dispatches to unload handler", async () => {
		// Only unload declares 'plugin' in its resources — rm plugin resolves
		// unambiguously to unload.
		const result = await c8("rm", "plugin", "nonexistent-plugin");
		assert.strictEqual(result.status, 1);
		assert.ok(
			result.stderr.includes("neither registered nor installed"),
			`expected unload handler error, got: ${result.stderr}`,
		);
		assert.ok(
			!result.stderr.includes("Unknown command"),
			"'rm plugin' should not produce 'Unknown command'",
		);
	});

	test("'w --help' exits 0 (not rejected as unknown command)", async () => {
		const result = await c8("w", "--help");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
	});
});
