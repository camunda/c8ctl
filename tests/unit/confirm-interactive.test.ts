/**
 * Tests for the interactive (TTY) branch of confirmDeployTarget().
 *
 * These tests exercise the readline prompt directly by spawning a
 * small script that imports confirmDeployTarget and writes input via
 * stdin. The script overrides process.stdin.isTTY / process.stderr.isTTY
 * so the interactive branch fires even from a non-TTY subprocess.
 */

import assert from "node:assert";
import { resolve } from "node:path";
import { describe, test } from "node:test";
import { asyncSpawnWithStdin } from "../utils/spawn.ts";

const HELPER = resolve(
	import.meta.dirname,
	"..",
	"fixtures",
	"confirm-interactive-helper.ts",
);

async function runConfirmHelper(
	input: string,
): Promise<{ stdout: string; stderr: string; status: number | null }> {
	return asyncSpawnWithStdin(
		"node",
		["--experimental-strip-types", HELPER],
		(stdin) => {
			stdin.write(`${input}\n`);
		},
		{ timeout: 10_000 },
	);
}

describe("confirmDeployTarget — interactive branch", () => {
	test("'y' resolves to 'yes'", async () => {
		const result = await runConfirmHelper("y");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assert.strictEqual(result.stdout.trim(), "yes");
	});

	test("'yes' resolves to 'yes'", async () => {
		const result = await runConfirmHelper("yes");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assert.strictEqual(result.stdout.trim(), "yes");
	});

	test("'Y' (uppercase) resolves to 'yes'", async () => {
		const result = await runConfirmHelper("Y");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assert.strictEqual(result.stdout.trim(), "yes");
	});

	test("'n' resolves to 'no'", async () => {
		const result = await runConfirmHelper("n");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assert.strictEqual(result.stdout.trim(), "no");
	});

	test("empty input (just Enter) resolves to 'no'", async () => {
		const result = await runConfirmHelper("");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assert.strictEqual(result.stdout.trim(), "no");
	});

	test("'a' resolves to 'always'", async () => {
		const result = await runConfirmHelper("a");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assert.strictEqual(result.stdout.trim(), "always");
	});

	test("'always' resolves to 'always'", async () => {
		const result = await runConfirmHelper("always");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assert.strictEqual(result.stdout.trim(), "always");
	});

	test("'A' (uppercase) resolves to 'always'", async () => {
		const result = await runConfirmHelper("A");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assert.strictEqual(result.stdout.trim(), "always");
	});

	test("EOF (Ctrl+D) without input resolves to 'no'", async () => {
		// Send nothing and let stdin close immediately (EOF).
		const result = await asyncSpawnWithStdin(
			"node",
			["--experimental-strip-types", HELPER],
			(stdin) => {
				// Close stdin without writing anything — simulates Ctrl+D.
				stdin.end();
			},
			{ timeout: 10_000 },
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assert.strictEqual(result.stdout.trim(), "no");
	});

	test("prompt text appears on stderr", async () => {
		const result = await runConfirmHelper("y");
		assert.ok(
			result.stderr.includes("Deploying to profile"),
			`prompt should appear on stderr, got: ${result.stderr}`,
		);
		assert.ok(
			result.stderr.includes("[y/N/a]"),
			`prompt should include [y/N/a], got: ${result.stderr}`,
		);
	});
});
