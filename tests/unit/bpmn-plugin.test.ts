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
		const dataDir = mkdtempSync(join(tmpdir(), "c8ctl-bpmn-test-"));
		writeFileSync(
			join(dataDir, "session.json"),
			JSON.stringify({ outputMode: "text" }),
		);
		let result: Awaited<ReturnType<typeof asyncSpawn>>;
		try {
			result = await asyncSpawn(
				"node",
				["--experimental-strip-types", CLI, "bpmn", "lint", file],
				{
					cwd: REPO_ROOT,
					env: { ...process.env, FORCE_COLOR: "1", C8CTL_DATA_DIR: dataDir },
				},
			);
		} finally {
			rmSync(dataDir, { recursive: true, force: true });
		}
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

// ---------------------------------------------------------------------------
// bpmn lint — --dry-run
// ---------------------------------------------------------------------------

describe("CLI behavioural: bpmn lint --dry-run", () => {
	test("Cloud file: prints platform, source, and resolved camunda-compat config", async () => {
		const file = join(FIXTURES_DIR, "simple.bpmn");
		const result = await c8text("bpmn", "lint", "--dry-run", file);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = result.stdout;
		assert.ok(
			out.includes("Dry run — no lint performed."),
			`dry-run banner missing. Got: ${out}`,
		);
		assert.ok(
			out.includes(`Source: ${file}`),
			"source line should be absolute",
		);
		assert.ok(
			out.includes("Camunda Cloud 8.8.0"),
			"platform line should reflect fixture's executionPlatform + version",
		);
		assert.ok(
			out.includes("bpmnlint:recommended"),
			"extends should include bpmnlint:recommended",
		);
		assert.ok(
			out.includes("plugin:camunda-compat/camunda-cloud-8-8"),
			"extends should include the resolved camunda-compat config",
		);
		assert.ok(
			!out.includes("No issues found"),
			"linter must not run under --dry-run",
		);
	});

	test("Cloud file: JSON mode emits structured dry-run envelope", async () => {
		const file = join(FIXTURES_DIR, "simple.bpmn");
		const result = await c8("bpmn", "lint", "--dry-run", file);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const parsed = JSON.parse(result.stdout);
		assert.strictEqual(parsed.dryRun, true);
		assert.strictEqual(parsed.command, "bpmn lint");
		assert.strictEqual(parsed.source, file);
		assert.deepStrictEqual(parsed.platform, {
			executionPlatform: "Camunda Cloud",
			version: "8.8.0",
		});
		assert.ok(Array.isArray(parsed.config.extends));
		assert.ok(parsed.config.extends.includes("bpmnlint:recommended"));
	});

	test("non-Cloud file: platform reported, no camunda-compat in extends", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "c8ctl-bpmn-dryrun-"));
		const file = join(tempDir, "no-platform.bpmn");
		writeFileSync(
			file,
			`<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL">
  <bpmn:process id="p1" isExecutable="true">
    <bpmn:startEvent id="StartEvent_1" />
  </bpmn:process>
</bpmn:definitions>`,
		);
		try {
			const result = await c8text("bpmn", "lint", "--dry-run", file);
			assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
			const out = result.stdout;
			assert.ok(
				out.includes("Platform: not declared"),
				`expected 'not declared'. Got: ${out}`,
			);
			assert.ok(out.includes("bpmnlint:recommended"));
			assert.ok(
				!out.includes("camunda-compat"),
				"no camunda-compat config should appear for non-Cloud files",
			);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test(".bpmnlintrc override: dry-run reflects the user's config", async () => {
		const externalDir = mkdtempSync(join(tmpdir(), "c8ctl-bpmn-dryrun-rc-"));
		const file = join(externalDir, "test.bpmn");
		writeFileSync(
			file,
			readFileSync(join(FIXTURES_DIR, "simple.bpmn"), "utf-8"),
		);
		writeFileSync(
			join(externalDir, ".bpmnlintrc"),
			JSON.stringify({
				extends: ["bpmnlint:recommended"],
				rules: { "label-required": "off" },
			}),
		);
		try {
			const result = await asyncSpawn(
				"node",
				[
					"--experimental-strip-types",
					join(REPO_ROOT, CLI),
					"bpmn",
					"lint",
					"--dry-run",
					file,
				],
				{ cwd: externalDir, env: process.env },
			);
			assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
			const out = result.stdout;
			assert.ok(out.includes("Dry run — no lint performed."));
			assert.ok(
				out.includes('"label-required": "off"'),
				"override rule should appear in printed config",
			);
			assert.ok(
				!out.includes("camunda-compat"),
				".bpmnlintrc takes precedence; no auto-detected compat config",
			);
		} finally {
			rmSync(externalDir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// bpmn lint — .bpmnlintrc override
// ---------------------------------------------------------------------------

describe("CLI behavioural: bpmn lint .bpmnlintrc override", () => {
	test("warnings-only override surfaces 'warning' in JSON and text", async () => {
		// Pin the contract that bpmnlint's raw "warn" category is
		// normalised to "warning" everywhere — JSON output, the text
		// severity column, and the summary row.
		const externalDir = mkdtempSync(join(tmpdir(), "c8ctl-bpmn-warn-"));
		const file = join(externalDir, "test.bpmn");
		writeFileSync(
			file,
			readFileSync(
				join(FIXTURES_DIR, "simple-will-create-incident.bpmn"),
				"utf-8",
			),
		);
		writeFileSync(
			join(externalDir, ".bpmnlintrc"),
			JSON.stringify({
				extends: ["bpmnlint:recommended"],
				rules: { "label-required": "warn" },
			}),
		);
		try {
			// JSON mode — category must be "warning", not "warn".
			const jsonRun = await asyncSpawn(
				"node",
				[
					"--experimental-strip-types",
					join(REPO_ROOT, CLI),
					"--json",
					"bpmn",
					"lint",
					file,
				],
				{ cwd: externalDir, env: process.env },
			);
			assert.strictEqual(jsonRun.status, 0, `stderr: ${jsonRun.stderr}`);
			const parsed = JSON.parse(jsonRun.stdout);
			assert.ok(parsed.issues.length > 0, "should have warning-level issues");
			for (const issue of parsed.issues) {
				assert.strictEqual(
					issue.category,
					"warning",
					`category should be 'warning', got '${issue.category}'`,
				);
			}
			assert.strictEqual(parsed.errorCount, 0);
			assert.ok(parsed.warningCount > 0);

			// Text mode — severity column should read "warning" and the
			// summary line should mention warnings, not errors.
			const textRun = await asyncSpawn(
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
			assert.strictEqual(textRun.status, 0, `stderr: ${textRun.stderr}`);
			assert.ok(
				/\swarning\s/.test(textRun.stdout),
				`text output should include 'warning' as severity. Got: ${textRun.stdout.slice(0, 400)}`,
			);
			assert.ok(
				/0 errors, \d+ warnings?/.test(textRun.stdout),
				"summary should report 0 errors and >=1 warning",
			);
		} finally {
			rmSync(externalDir, { recursive: true, force: true });
		}
	});

	test("respects user .bpmnlintrc that disables a rule", async () => {
		const externalDir = mkdtempSync(join(tmpdir(), "c8ctl-bpmn-rc-"));
		const file = join(externalDir, "test.bpmn");
		writeFileSync(
			file,
			readFileSync(
				join(FIXTURES_DIR, "simple-will-create-incident.bpmn"),
				"utf-8",
			),
		);
		// Disable the label-required rule so the output no longer includes it.
		// Without this override the default config flags label-required violations.
		writeFileSync(
			join(externalDir, ".bpmnlintrc"),
			JSON.stringify({
				extends: ["bpmnlint:recommended"],
				rules: { "label-required": "off" },
			}),
		);
		try {
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
			const output = result.stdout + result.stderr;
			// Assert exit 0 before checking output absence — a config
			// parse / module-load failure would also produce output
			// without "label-required" and falsely pass otherwise.
			assert.strictEqual(
				result.status,
				0,
				`lint should succeed with the override applied. Got status=${result.status}, output: ${output.slice(0, 400)}`,
			);
			assert.ok(
				!output.includes("label-required"),
				`label-required should be suppressed by .bpmnlintrc. Got: ${output.slice(0, 400)}`,
			);
		} finally {
			rmSync(externalDir, { recursive: true, force: true });
		}
	});
});
