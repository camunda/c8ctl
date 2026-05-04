/**
 * Behavioural tests for the BPMN default plugin (default-plugins/bpmn/)
 */

import assert from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, test } from "node:test";
import { c8 } from "../utils/cli.ts";
import { asyncSpawn, asyncSpawnWithStdin } from "../utils/spawn.ts";

const FIXTURES_DIR = resolve(import.meta.dirname, "..", "fixtures");
const CLI = "src/index.ts";
const REPO_ROOT = resolve(import.meta.dirname, "..", "..");

async function c8text(...args: string[]) {
	const dataDir = mkdtempSync(join(tmpdir(), "c8ctl-bpmn-test-"));
	writeFileSync(
		join(dataDir, "session.json"),
		JSON.stringify({ outputMode: "text" }),
	);
	try {
		// The bpmn lint command auto-detects piped stdin via async iteration;
		// if the spawned child has stdin as an open pipe with no writer it
		// would hang. asyncSpawnWithStdin with a no-op writer closes stdin
		// immediately so isTTY-falsy checks still trip but the read loop
		// sees EOF right away.
		return await asyncSpawnWithStdin(
			"node",
			["--experimental-strip-types", CLI, ...args],
			() => {},
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
// bpmn verb – resource validation
// ---------------------------------------------------------------------------

describe("CLI behavioural: bpmn verb", () => {
	test("bpmn with no subcommand shows usage", async () => {
		const result = await c8text("bpmn");
		const output = result.stdout + result.stderr;
		assert.ok(
			output.includes("lint"),
			"Should list lint as available subcommand",
		);
	});
});

// ---------------------------------------------------------------------------
// bpmn lint
// ---------------------------------------------------------------------------

describe("CLI behavioural: bpmn lint", () => {
	test("lint clean file prints success line and exits 0", async () => {
		const file = join(FIXTURES_DIR, "simple.bpmn");
		const result = await c8text("bpmn", "lint", file);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assert.ok(
			result.stdout.includes("No issues found"),
			"Should print success affirmation on a clean lint",
		);
	});

	test("--quiet suppresses the success line on a clean lint", async () => {
		const file = join(FIXTURES_DIR, "simple.bpmn");
		const result = await c8text("bpmn", "lint", "--quiet", file);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assert.strictEqual(
			result.stdout,
			"",
			"--quiet should leave stdout empty on success",
		);
	});

	test("--quiet does not suppress problems", async () => {
		// --quiet only silences the success line. Problem output is the
		// whole point of running the linter, so it must always render.
		const file = join(FIXTURES_DIR, "simple-will-create-incident.bpmn");
		const result = await c8text("bpmn", "lint", "-q", file);
		assert.strictEqual(result.status, 1, "Should still exit 1 on errors");
		const output = result.stdout + result.stderr;
		assert.ok(
			output.includes("label-required"),
			"Problem output must render even with --quiet",
		);
	});

	test("lint file with issues exits 1 and reports errors", async () => {
		const file = join(FIXTURES_DIR, "simple-will-create-incident.bpmn");
		const result = await c8text("bpmn", "lint", file);
		assert.strictEqual(result.status, 1, "Should exit 1 on lint errors");
		const output = result.stdout + result.stderr;
		assert.ok(
			output.includes("label-required"),
			"Should report label-required rule",
		);
		assert.ok(/\d+ problem/.test(output), "Should show problem count summary");
	});

	test("lint file with issues in JSON mode outputs structured result", async () => {
		const file = join(FIXTURES_DIR, "simple-will-create-incident.bpmn");
		const result = await c8("bpmn", "lint", file);
		assert.strictEqual(result.status, 1, "Should exit 1 on lint errors");
		const parsed = JSON.parse(result.stdout);
		assert.ok(Array.isArray(parsed.issues), "Should have issues array");
		assert.ok(parsed.errorCount > 0, "Should have errors");
	});

	test("lint missing file exits 1 with error message", async () => {
		const result = await c8text("bpmn", "lint", "/nonexistent/file.bpmn");
		assert.strictEqual(result.status, 1);
		const output = result.stdout + result.stderr;
		assert.ok(
			output.includes("File not found") ||
				output.includes("Failed to bpmn lint"),
			"Should report file not found",
		);
	});

	test("lint with no file and TTY exits 1 with usage hint", async () => {
		const result = await c8text("bpmn", "lint");
		assert.strictEqual(result.status, 1);
		const output = result.stdout + result.stderr;
		assert.ok(
			output.includes("No BPMN input") ||
				output.includes("Failed to bpmn lint"),
			"Should report missing input",
		);
	});

	test("lint invalid XML exits 1", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "c8ctl-bpmn-test-"));
		const tempFile = join(tempDir, "invalid.bpmn");
		writeFileSync(tempFile, "<not-valid-bpmn>broken</not-valid-bpmn>");
		try {
			const result = await c8text("bpmn", "lint", tempFile);
			assert.strictEqual(result.status, 1, "Should exit 1 for invalid XML");
			const output = result.stdout + result.stderr;
			assert.ok(
				output.includes("parse") || output.includes("Failed"),
				"Should report parse error",
			);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// bpmn lint — piped stdin
// ---------------------------------------------------------------------------

describe("CLI behavioural: bpmn lint stdin", () => {
	const xml = readFileSync(
		join(FIXTURES_DIR, "simple-will-create-incident.bpmn"),
		"utf-8",
	);

	test("reads piped stdin from a fast writer", async () => {
		const result = await asyncSpawnWithStdin(
			"node",
			["--experimental-strip-types", CLI, "bpmn", "lint"],
			(stdin) => {
				stdin.write(xml);
			},
			{ cwd: REPO_ROOT, env: process.env },
		);
		assert.strictEqual(result.status, 1, `stderr: ${result.stderr}`);
		const output = result.stdout + result.stderr;
		assert.ok(
			output.includes("label-required"),
			"Should report lint issues from stdin",
		);
	});

	test("waits for a slow stdin writer (regression: EAGAIN treated as EOF)", async () => {
		const result = await asyncSpawnWithStdin(
			"node",
			["--experimental-strip-types", CLI, "bpmn", "lint"],
			async (stdin) => {
				// Delay before writing to simulate a slow upstream producer
				// (e.g. `apply | lint` where apply hasn't finished yet).
				await new Promise((r) => setTimeout(r, 200));
				stdin.write(xml);
			},
			{ cwd: REPO_ROOT, env: process.env },
		);
		assert.strictEqual(
			result.status,
			1,
			`Expected lint to wait for slow producer and report issues. stderr: ${result.stderr}`,
		);
		const output = result.stdout + result.stderr;
		assert.ok(
			!output.includes("No BPMN input provided"),
			"Should not bail with 'No BPMN input' when writer is slow",
		);
		assert.ok(
			output.includes("label-required"),
			"Should report lint issues after waiting for stdin",
		);
	});
});

// ---------------------------------------------------------------------------
// bpmn lint — running outside the c8ctl repo
// ---------------------------------------------------------------------------

describe("CLI behavioural: bpmn lint from external CWD", () => {
	test("resolves bpmnlint plugins regardless of caller's node_modules", async () => {
		const externalDir = mkdtempSync(join(tmpdir(), "c8ctl-bpmn-cwd-"));
		const file = join(externalDir, "with-issues.bpmn");
		writeFileSync(
			file,
			readFileSync(
				join(FIXTURES_DIR, "simple-will-create-incident.bpmn"),
				"utf-8",
			),
		);
		try {
			// Spawn from a tempdir with no node_modules — would have failed
			// before the NodeResolver fix because bpmnlint's default
			// resolver looks up plugins from the user's CWD.
			const result = await asyncSpawn(
				"node",
				[
					"--experimental-strip-types",
					join(REPO_ROOT, CLI),
					"bpmn",
					"lint",
					file,
				],
				{ cwd: externalDir, env: process.env },
			);
			assert.strictEqual(
				result.status,
				1,
				`stderr: ${result.stderr.slice(0, 500)}`,
			);
			const output = result.stdout + result.stderr;
			assert.ok(
				output.includes("label-required"),
				"Should still apply Camunda ruleset from external CWD",
			);
			assert.ok(
				!output.includes("Could not load") &&
					!output.includes("Cannot find module"),
				"Should not fail to load the camunda-compat plugin",
			);
		} finally {
			rmSync(externalDir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// bpmn lint — output formatting
// ---------------------------------------------------------------------------

describe("CLI behavioural: bpmn lint output formatting", () => {
	test("aligns columns by padding to the longest cell", async () => {
		const file = join(FIXTURES_DIR, "simple-will-create-incident.bpmn");
		const result = await c8text("bpmn", "lint", file);
		// Issue lines start with the leading 3-space indent the formatter
		// emits; this filter keeps issue rows and excludes the file path,
		// blank lines, and the summary line.
		const lines = (result.stdout + result.stderr)
			.split("\n")
			.filter((l) => /^\s{2,}\S/.test(l) && l.includes("error"));

		assert.ok(
			lines.length >= 2,
			"Need at least 2 issue lines to verify alignment",
		);

		// For each whitespace run separating two cells, record the END
		// position (i.e. where the next cell begins). Cell starts are
		// deterministic across rows when padding is applied; cell-content
		// END positions vary because shorter cells have more trailing
		// padding inside the run.
		const cellStarts = (line: string): number[] => {
			const positions: number[] = [];
			for (const match of line.matchAll(/\s{2,}/g)) {
				positions.push((match.index ?? 0) + match[0].length);
			}
			return positions;
		};
		const first = cellStarts(lines[0]);
		for (const line of lines.slice(1)) {
			assert.deepStrictEqual(
				cellStarts(line),
				first,
				`Cell starts should align across rows. Row: ${JSON.stringify(line)}`,
			);
		}
	});

	test("emits ANSI color codes when FORCE_COLOR=1", async () => {
		const file = join(FIXTURES_DIR, "simple-will-create-incident.bpmn");
		const result = await asyncSpawn(
			"node",
			["--experimental-strip-types", CLI, "bpmn", "lint", file],
			{
				cwd: REPO_ROOT,
				env: { ...process.env, FORCE_COLOR: "1" },
			},
		);
		const output = result.stdout + result.stderr;
		// styleText emits CSI escape sequences (ESC '[' ... 'm') around
		// colored text; presence proves the formatter wraps severity/summary.
		// Build the regex from char codes to avoid embedding a literal
		// control character (which biome's noControlCharactersInRegex flags).
		const ansiRegex = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]+m`);
		assert.ok(
			ansiRegex.test(output),
			`No ANSI codes in output: ${output.slice(0, 300)}`,
		);
	});
});
