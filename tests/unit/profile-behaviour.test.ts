/**
 * CLI behavioural tests for profile and use commands.
 *
 * These tests exercise the full dispatch path by spawning the CLI
 * as a subprocess. They verify that profile listing and the use
 * command produce expected output and exit codes.
 */

import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { c8, c8WithEnv } from "../utils/cli.ts";

// ─── list profiles ──────────────────────────────────────────────────────────

describe("CLI behavioural: list profiles", () => {
	test("exits 0 and includes the built-in local profile", async () => {
		const result = await c8("list", "profiles");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assert.ok(result.stdout.includes("local"), 'Expected "local" profile');
	});

	test("shows URL column header", async () => {
		const result = await c8("list", "profiles");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assert.ok(result.stdout.includes("URL"), 'Expected "URL" column header');
	});
});

// ─── use (without resource) ─────────────────────────────────────────────────

describe("CLI behavioural: use command", () => {
	test("exits 1 and shows available resources when no resource given", async () => {
		const result = await c8("use");
		assert.strictEqual(result.status, 1, `stderr: ${result.stderr}`);
		assert.ok(
			result.stdout.includes("profile") || result.stderr.includes("profile"),
			'Expected "profile" in available resources',
		);
	});
});

// ─── unknown profile ────────────────────────────────────────────────────────

describe("CLI behavioural: unknown profile", () => {
	test("open fails when --profile does not exist", async () => {
		// when
		const result = await c8("open", "operate", "--profile", "nonexistent");

		// then
		assert.strictEqual(result.status, 1, `stdout: ${result.stdout}`);
		assert.ok(
			`${result.stdout}${result.stderr}`.includes(
				"Profile 'nonexistent' not found",
			),
		);
	});

	test("list fails when --profile does not exist", async () => {
		// when
		const result = await c8(
			"list",
			"process-instances",
			"--profile",
			"nonexistent",
			"--dry-run",
		);

		// then
		assert.strictEqual(result.status, 1, `stdout: ${result.stdout}`);
		assert.ok(
			`${result.stdout}${result.stderr}`.includes(
				"Profile 'nonexistent' not found",
			),
		);
	});

	test("list fails when --profile is empty", async () => {
		// when
		const result = await c8(
			"list",
			"process-instances",
			"--profile=",
			"--dry-run",
		);

		// then
		assert.strictEqual(result.status, 1, `stdout: ${result.stdout}`);
		assert.ok(
			`${result.stdout}${result.stderr}`.includes(
				"Profile name must not be empty",
			),
		);
	});

	test("list fails when the active session profile no longer exists", async () => {
		// given
		const dataDir = mkdtempSync(join(tmpdir(), "c8ctl-stale-profile-"));
		writeFileSync(
			join(dataDir, "session.json"),
			JSON.stringify({ outputMode: "json", activeProfile: "ghost" }),
		);

		try {
			// when
			const result = await c8WithEnv(
				{ C8CTL_DATA_DIR: dataDir },
				"list",
				"process-instances",
				"--dry-run",
			);

			// then
			assert.strictEqual(result.status, 1, `stdout: ${result.stdout}`);
			assert.ok(
				`${result.stdout}${result.stderr}`.includes(
					"Profile 'ghost' not found",
				),
			);
		} finally {
			rmSync(dataDir, { recursive: true, force: true });
		}
	});
});
