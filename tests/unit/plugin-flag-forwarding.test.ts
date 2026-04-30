/**
 * Unit tests for plugin argument forwarding (flag-stripping).
 *
 * Verifies that:
 * - Non-global flags (e.g. --from URL) are forwarded to the plugin.
 * - GLOBAL_FLAGS (--verbose, --dry-run, --profile, --fields, --help, and their
 *   short aliases) are stripped before the plugin receives the arg list.
 *
 * Also exercises the stripGlobalFlags helper directly against all GLOBAL_FLAGS.
 */

import assert from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { stripGlobalFlags } from "../../src/index.ts";
import { asyncSpawn } from "../utils/spawn.ts";

const CLI = resolve(import.meta.dirname, "..", "..", "src", "index.ts");

// ---------------------------------------------------------------------------
// Narrow unknown JSON output to string[] without type assertions.
// ---------------------------------------------------------------------------

function parseStringArray(raw: unknown, label = "value"): string[] {
	assert.ok(Array.isArray(raw), `expected ${label} to be a JSON array`);
	return raw.map((item: unknown, i: number) => {
		assert.ok(
			typeof item === "string",
			`expected ${label}[${i}] to be a string`,
		);
		return item;
	});
}

// ---------------------------------------------------------------------------
// stripGlobalFlags — pure unit tests (no subprocess)
// ---------------------------------------------------------------------------

describe("stripGlobalFlags — strips all GLOBAL_FLAGS", () => {
	test("passes through non-global flags unchanged", () => {
		const input = ["resource", "--from", "http://example.com", "--count", "5"];
		assert.deepStrictEqual(stripGlobalFlags(input), input);
	});

	test("removes --verbose (boolean flag)", () => {
		assert.deepStrictEqual(
			stripGlobalFlags(["resource", "--verbose", "--from", "url"]),
			["resource", "--from", "url"],
		);
	});

	test("removes --dry-run (boolean flag)", () => {
		assert.deepStrictEqual(stripGlobalFlags(["resource", "--dry-run"]), [
			"resource",
		]);
	});

	test("removes --help (boolean flag)", () => {
		assert.deepStrictEqual(stripGlobalFlags(["--help", "resource"]), [
			"resource",
		]);
	});

	test("removes -h short alias for --help (boolean)", () => {
		assert.deepStrictEqual(stripGlobalFlags(["-h"]), []);
	});

	test("removes --profile and its value (string flag)", () => {
		assert.deepStrictEqual(
			stripGlobalFlags(["resource", "--profile", "prod", "--from", "url"]),
			["resource", "--from", "url"],
		);
	});

	test("removes --profile=value form (string flag with =)", () => {
		assert.deepStrictEqual(
			stripGlobalFlags(["resource", "--profile=prod", "--from", "url"]),
			["resource", "--from", "url"],
		);
	});

	test("removes --fields and its value (string flag)", () => {
		assert.deepStrictEqual(
			stripGlobalFlags(["resource", "--fields", "key,name", "--from", "url"]),
			["resource", "--from", "url"],
		);
	});

	test("removes --version and its value (string flag)", () => {
		assert.deepStrictEqual(
			stripGlobalFlags(["resource", "--version", "2", "--from", "url"]),
			["resource", "--from", "url"],
		);
	});

	test("removes -v short alias for --version and its value (string)", () => {
		assert.deepStrictEqual(
			stripGlobalFlags(["resource", "-v", "2", "--from", "url"]),
			["resource", "--from", "url"],
		);
	});

	test("handles multiple global flags mixed with plugin flags", () => {
		assert.deepStrictEqual(
			stripGlobalFlags([
				"subcommand",
				"--profile",
				"dev",
				"--from",
				"https://example.com",
				"--verbose",
				"--dry-run",
				"--fields",
				"key,value",
			]),
			["subcommand", "--from", "https://example.com"],
		);
	});

	test("returns empty array when all tokens are global flags", () => {
		assert.deepStrictEqual(
			stripGlobalFlags(["--verbose", "--dry-run", "--help"]),
			[],
		);
	});

	test("handles empty input", () => {
		assert.deepStrictEqual(stripGlobalFlags([]), []);
	});

	test("does not strip a flag whose name is a prefix of a global flag", () => {
		// --profiles is NOT --profile, so it must pass through untouched.
		assert.deepStrictEqual(stripGlobalFlags(["--profiles", "all"]), [
			"--profiles",
			"all",
		]);
	});
});

// ---------------------------------------------------------------------------
// End-to-end: CLI subprocess with fixture plugin
// ---------------------------------------------------------------------------

/**
 * Write a minimal c8ctl plugin into tempDir that echoes the received args as
 * a JSON array to stdout so tests can parse and assert on them.
 */
function writeArgCapturePlugin(tempDir: string): void {
	const pluginDir = join(
		tempDir,
		"plugins",
		"node_modules",
		"arg-capture-plugin",
	);
	mkdirSync(pluginDir, { recursive: true });

	writeFileSync(
		join(pluginDir, "package.json"),
		JSON.stringify({ name: "arg-capture-plugin", keywords: ["c8ctl"] }),
	);

	// The plugin writes its received args as a JSON array to stdout.
	// Command name: "argcapture" (unlikely to clash with built-ins).
	writeFileSync(
		join(pluginDir, "c8ctl-plugin.js"),
		`
export const metadata = {
  name: "arg-capture-plugin",
  commands: {
    argcapture: { description: "Capture and echo args" },
  },
};

export const commands = {
  argcapture: async (args) => {
    process.stdout.write(JSON.stringify(args) + "\\n");
  },
};
`,
	);
}

describe("CLI plugin flag forwarding (subprocess)", () => {
	let dataDir: string;

	beforeEach(() => {
		dataDir = mkdtempSync(join(tmpdir(), "c8ctl-plugin-flag-test-"));
		// Pin output mode to JSON so c8ctl framework output is deterministic.
		writeFileSync(
			join(dataDir, "session.json"),
			JSON.stringify({ outputMode: "json" }),
		);
		writeArgCapturePlugin(dataDir);
	});

	afterEach(() => {
		rmSync(dataDir, { recursive: true, force: true });
	});

	async function runCLI(...cliArgs: string[]) {
		return asyncSpawn("node", ["--experimental-strip-types", CLI, ...cliArgs], {
			env: {
				PATH: process.env.PATH,
				CAMUNDA_BASE_URL: "http://test-cluster/v2",
				HOME: "/tmp/c8ctl-test-nonexistent-home",
				C8CTL_DATA_DIR: dataDir,
			},
		});
	}

	test("forwards non-global flag --from to the plugin", async () => {
		const result = await runCLI(
			"argcapture",
			"myresource",
			"--from",
			"https://example.com",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);

		const received = parseStringArray(
			JSON.parse(result.stdout.trim()),
			"plugin args",
		);
		assert.ok(
			received.includes("--from"),
			`Expected --from in plugin args, got: ${JSON.stringify(received)}`,
		);
		assert.ok(
			received.includes("https://example.com"),
			`Expected URL value in plugin args, got: ${JSON.stringify(received)}`,
		);
	});

	test("does not forward --verbose to the plugin", async () => {
		const result = await runCLI(
			"argcapture",
			"myresource",
			"--verbose",
			"--from",
			"https://example.com",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);

		const received = parseStringArray(
			JSON.parse(result.stdout.trim()),
			"plugin args",
		);
		assert.ok(
			!received.includes("--verbose"),
			`--verbose should be stripped, got: ${JSON.stringify(received)}`,
		);
		assert.ok(
			received.includes("--from"),
			`--from should still be present, got: ${JSON.stringify(received)}`,
		);
	});

	test("does not forward --dry-run to the plugin", async () => {
		// NOTE: --dry-run is consumed by c8ctl before plugin dispatch, so the
		// plugin never sees it even without stripping. This test asserts the
		// stripping layer also handles it, ensuring the raw-argv slice path
		// is covered.
		const result = await runCLI(
			"argcapture",
			"myresource",
			"--from",
			"url",
			"--dry-run",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);

		const received = parseStringArray(
			JSON.parse(result.stdout.trim()),
			"plugin args",
		);
		assert.ok(
			!received.includes("--dry-run"),
			`--dry-run should be stripped, got: ${JSON.stringify(received)}`,
		);
	});

	test("does not forward --profile and its value to the plugin", async () => {
		const result = await runCLI(
			"argcapture",
			"myresource",
			"--profile",
			"prod",
			"--from",
			"url",
		);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);

		const received = parseStringArray(
			JSON.parse(result.stdout.trim()),
			"plugin args",
		);
		assert.ok(
			!received.includes("--profile"),
			`--profile should be stripped, got: ${JSON.stringify(received)}`,
		);
		assert.ok(
			!received.includes("prod"),
			`profile value should be stripped, got: ${JSON.stringify(received)}`,
		);
		assert.ok(
			received.includes("--from"),
			`--from should still be present, got: ${JSON.stringify(received)}`,
		);
	});

	test("forwards positional arguments unchanged", async () => {
		const result = await runCLI("argcapture", "sub", "pos1", "pos2");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);

		const received = parseStringArray(
			JSON.parse(result.stdout.trim()),
			"plugin args",
		);
		assert.ok(
			received.includes("sub"),
			`Expected "sub" in plugin args, got: ${JSON.stringify(received)}`,
		);
		assert.ok(
			received.includes("pos1"),
			`Expected "pos1" in plugin args, got: ${JSON.stringify(received)}`,
		);
		assert.ok(
			received.includes("pos2"),
			`Expected "pos2" in plugin args, got: ${JSON.stringify(received)}`,
		);
	});
});
