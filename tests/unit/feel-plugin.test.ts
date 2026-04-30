/**
 * Behavioural tests for the feel default plugin (default-plugins/feel/).
 *
 * Local-engine tests run feelin in-process (no cluster needed). One
 * cluster-engine test points at a closed local port to exercise the
 * connection-refused error-classification path.
 */

import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { asyncSpawn } from "../utils/spawn.ts";

const CLI = "src/index.ts";

async function feelText(...args: string[]) {
	const dataDir = mkdtempSync(join(tmpdir(), "c8ctl-feel-test-"));
	writeFileSync(
		join(dataDir, "session.json"),
		JSON.stringify({ outputMode: "text" }),
	);
	try {
		return await asyncSpawn(
			"node",
			["--experimental-strip-types", CLI, "feel", ...args],
			{
				env: {
					...process.env,
					CAMUNDA_BASE_URL: "http://test-cluster/v2",
					HOME: "/tmp/c8ctl-test-nonexistent-home",
					C8CTL_DATA_DIR: dataDir,
				},
			},
		);
	} finally {
		rmSync(dataDir, { recursive: true, force: true });
	}
}

async function feelJson(...args: string[]) {
	const dataDir = mkdtempSync(join(tmpdir(), "c8ctl-feel-test-"));
	writeFileSync(
		join(dataDir, "session.json"),
		JSON.stringify({ outputMode: "json" }),
	);
	try {
		return await asyncSpawn(
			"node",
			["--experimental-strip-types", CLI, "feel", ...args],
			{
				env: {
					...process.env,
					CAMUNDA_BASE_URL: "http://test-cluster/v2",
					HOME: "/tmp/c8ctl-test-nonexistent-home",
					C8CTL_DATA_DIR: dataDir,
				},
			},
		);
	} finally {
		rmSync(dataDir, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// feel eval — local engine (text mode)
// ---------------------------------------------------------------------------

describe("CLI behavioural: feel eval (local engine)", () => {
	test("simple expression, leading = is optional", async () => {
		const a = await feelText("eval", "1 + 2", "--engine", "local");
		assert.strictEqual(a.status, 0, `stderr: ${a.stderr}`);
		assert.match(a.stdout, /^3\s*$/);

		const b = await feelText("eval", "=1 + 2", "--engine", "local");
		assert.strictEqual(b.status, 0);
		assert.match(b.stdout, /^3\s*$/);
	});

	test("evaluates with --var (number values, JSON-parsed)", async () => {
		const result = await feelText(
			"eval",
			"a + b",
			"--var",
			"a=10",
			"--var",
			"b=5",
			"--engine",
			"local",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assert.match(result.stdout, /^15\s*$/);
	});

	test("treats non-JSON --var values as string literals", async () => {
		const result = await feelText(
			"eval",
			"name",
			"--var",
			"name=Alice",
			"--engine",
			"local",
		);
		assert.strictEqual(result.status, 0);
		assert.match(result.stdout, /^Alice\s*$/);
	});

	test("dot-path --var nests under the path", async () => {
		const result = await feelText(
			"eval",
			"person.name",
			"--var",
			"person.name=Alice",
			"--var",
			"person.age=30",
			"--engine",
			"local",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assert.match(result.stdout, /^Alice\s*$/);
	});

	test("--vars provides a base, --var overrides", async () => {
		const result = await feelText(
			"eval",
			"a + b",
			"--vars",
			'{"a":1,"b":2}',
			"--var",
			"b=99",
			"--engine",
			"local",
		);
		assert.strictEqual(result.status, 0);
		assert.match(result.stdout, /^100\s*$/);
	});

	test("rejects --var that nests under a non-object", async () => {
		const result = await feelText(
			"eval",
			"foo.bar",
			"--var",
			"foo=hello",
			"--var",
			"foo.bar=nested",
			"--engine",
			"local",
		);
		assert.strictEqual(result.status, 1);
		const output = result.stdout + result.stderr;
		assert.ok(
			output.includes("is of type string"),
			`Should report conflict. Got: ${output}`,
		);
		assert.ok(output.includes("foo.bar"));
	});

	test("rejects --var with empty path", async () => {
		const result = await feelText(
			"eval",
			"1",
			"--var",
			"=hello",
			"--engine",
			"local",
		);
		assert.strictEqual(result.status, 1);
		assert.ok((result.stdout + result.stderr).includes("Path is empty"));
	});

	test("rejects --var without =", async () => {
		const result = await feelText(
			"eval",
			"1",
			"--var",
			"foo",
			"--engine",
			"local",
		);
		assert.strictEqual(result.status, 1);
		assert.ok((result.stdout + result.stderr).includes("Expected key=value"));
	});

	test("rejects invalid --vars JSON", async () => {
		const result = await feelText(
			"eval",
			"a",
			"--vars",
			"not-json",
			"--engine",
			"local",
		);
		assert.strictEqual(result.status, 1);
		assert.ok((result.stdout + result.stderr).includes("Invalid --vars JSON"));
	});

	test("parse error exits 1 with cleaned message", async () => {
		const result = await feelText("eval", "1 +", "--engine", "local");
		assert.strictEqual(result.status, 1);
		const output = result.stdout + result.stderr;
		assert.ok(output.includes("Failed to parse expression"), `Got: ${output}`);
	});

	test("missing expression exits 1", async () => {
		const result = await feelText("eval", "--engine", "local");
		assert.strictEqual(result.status, 1);
		assert.ok((result.stdout + result.stderr).includes("Missing expression"));
	});

	test("rejects invalid --engine value", async () => {
		const result = await feelText("eval", "1", "--engine", "invalid");
		assert.strictEqual(result.status, 1);
		assert.ok(
			(result.stdout + result.stderr).includes("Invalid --engine value"),
		);
	});
});

// ---------------------------------------------------------------------------
// feel eval — JSON output shape (engine-agnostic)
// ---------------------------------------------------------------------------

describe("CLI behavioural: feel eval JSON output shape", () => {
	test("local engine emits { expression, result, warnings: [] }", async () => {
		const result = await feelJson(
			"eval",
			"a + b",
			"--var",
			"a=10",
			"--var",
			"b=5",
			"--engine",
			"local",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const parsed = JSON.parse(result.stdout);
		assert.deepStrictEqual(Object.keys(parsed).sort(), [
			"expression",
			"result",
			"warnings",
		]);
		assert.strictEqual(parsed.result, 15);
		assert.deepStrictEqual(parsed.warnings, []);
	});

	test("local engine surfaces runtime warning for unknown var with result null", async () => {
		const result = await feelJson("eval", "unknownVar", "--engine", "local");
		assert.strictEqual(result.status, 0);
		const parsed = JSON.parse(result.stdout);
		assert.strictEqual(parsed.result, null);
		assert.ok(Array.isArray(parsed.warnings) && parsed.warnings.length >= 1);
		assert.ok(typeof parsed.warnings[0].message === "string");
	});
});

// ---------------------------------------------------------------------------
// feel eval — cluster engine error classification
// ---------------------------------------------------------------------------

describe("CLI behavioural: feel eval cluster errors", () => {
	test("unreachable cluster surfaces 'connection refused' with local-engine hint", async () => {
		// Connect attempts to a high-numbered closed port on loopback get
		// refused immediately on macOS/Linux without any DNS lookup,
		// producing ECONNREFUSED that the plugin's classifier translates
		// to a user-friendly message.
		const dataDir = mkdtempSync(join(tmpdir(), "c8ctl-feel-test-"));
		writeFileSync(
			join(dataDir, "session.json"),
			JSON.stringify({ outputMode: "text" }),
		);
		try {
			const result = await asyncSpawn(
				"node",
				["--experimental-strip-types", CLI, "feel", "eval", "1 + 2"],
				{
					env: {
						...process.env,
						CAMUNDA_BASE_URL: "http://127.0.0.1:9999",
						HOME: "/tmp/c8ctl-test-nonexistent-home",
						C8CTL_DATA_DIR: dataDir,
					},
				},
			);
			assert.strictEqual(result.status, 1);
			const output = result.stdout + result.stderr;
			assert.ok(
				output.includes("Cannot connect") || output.includes("refused"),
				`Should classify network failure. Got: ${output.slice(0, 300)}`,
			);
			assert.ok(
				output.includes("--engine local"),
				"Should hint to use --engine local",
			);
			assert.ok(
				output.includes("may differ"),
				"Hint should note feelin behaviour may differ from the cluster engine",
			);
		} finally {
			rmSync(dataDir, { recursive: true, force: true });
		}
	});
});
