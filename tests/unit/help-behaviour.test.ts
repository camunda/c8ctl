/**
 * CLI behavioural tests for help commands.
 *
 * These tests exercise the full dispatch path by spawning the CLI
 * as a subprocess. They verify that help output is correct in both
 * text and JSON modes, for both top-level help and command-specific help.
 */

import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { c8 } from "../utils/cli.ts";
import { asyncSpawn, type SpawnResult } from "../utils/spawn.ts";

const CLI = "src/index.ts";

/**
 * Invoke the CLI with a writable data dir in text output mode.
 */
function c8text(dataDir: string, ...args: string[]): Promise<SpawnResult> {
	return asyncSpawn("node", ["--experimental-strip-types", CLI, ...args], {
		env: {
			...process.env,
			CAMUNDA_BASE_URL: "http://test-cluster/v2",
			HOME: "/tmp/c8ctl-test-nonexistent-home",
			C8CTL_DATA_DIR: dataDir,
		},
	});
}

// ─── JSON mode help (default) ────────────────────────────────────────────────

describe("CLI behavioural: help (JSON mode)", () => {
	test("top-level help exits 0 and emits valid JSON", async () => {
		const result = await c8("help");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = JSON.parse(result.stdout);
		assert.ok(out.version, 'Expected "version" field');
		assert.ok(out.usage, 'Expected "usage" field');
		assert.ok(Array.isArray(out.commands), 'Expected "commands" array');
	});

	test("help includes all major command verbs", async () => {
		const result = await c8("help");
		const out = JSON.parse(result.stdout);
		const verbs = out.commands.map((c: { verb: string }) => c.verb);
		for (const verb of [
			"list",
			"search",
			"get",
			"create",
			"delete",
			"deploy",
			"cancel",
			"help",
		]) {
			assert.ok(
				verbs.includes(verb),
				`Expected verb "${verb}" in help commands`,
			);
		}
	});

	test("help includes resourceAliases", async () => {
		const result = await c8("help");
		const out = JSON.parse(result.stdout);
		assert.ok(out.resourceAliases, 'Expected "resourceAliases" object');
		assert.strictEqual(out.resourceAliases.pi, "process-instance(s)");
		assert.strictEqual(out.resourceAliases.pd, "process-definition(s)");
	});

	test("help includes globalFlags, searchFlags, and agentFlags", async () => {
		const result = await c8("help");
		const out = JSON.parse(result.stdout);
		assert.ok(Array.isArray(out.globalFlags), 'Expected "globalFlags" array');
		assert.ok(Array.isArray(out.searchFlags), 'Expected "searchFlags" array');
		assert.ok(Array.isArray(out.agentFlags), 'Expected "agentFlags" array');
	});

	test("command-specific help exits 0 and includes the verb", async () => {
		const result = await c8("help", "list");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const out = JSON.parse(result.stdout);
		assert.strictEqual(out.verb, "list");
		assert.ok(Array.isArray(out.resources), 'Expected "resources" array');
	});

	test("help for search includes resources", async () => {
		const result = await c8("help", "search");
		const out = JSON.parse(result.stdout);
		assert.strictEqual(out.verb, "search");
		assert.ok(
			out.resources.includes("pi"),
			'Expected "pi" in search resources',
		);
		assert.ok(
			out.resources.includes("vars"),
			'Expected "vars" in search resources',
		);
	});

	test("help distinguishes mutating from non-mutating commands", async () => {
		const result = await c8("help");
		const out = JSON.parse(result.stdout);
		const list = out.commands.find((c: { verb: string }) => c.verb === "list");
		const create = out.commands.find(
			(c: { verb: string }) => c.verb === "create",
		);
		assert.strictEqual(list.mutating, false, "list should not be mutating");
		assert.strictEqual(create.mutating, true, "create should be mutating");
	});
});

// ─── text mode help ──────────────────────────────────────────────────────────

describe("CLI behavioural: help (text mode)", () => {
	let dataDir: string;

	test("top-level help in text mode exits 0 and contains usage line", async () => {
		dataDir = mkdtempSync(join(tmpdir(), "c8ctl-help-test-"));
		// Set text mode via session file
		writeFileSync(
			join(dataDir, "session.json"),
			JSON.stringify({ outputMode: "text" }),
		);

		const result = await c8text(dataDir, "help");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assert.ok(
			result.stdout.includes("Usage:"),
			'Expected "Usage:" in text help',
		);
		assert.ok(
			result.stdout.includes("Commands:"),
			'Expected "Commands:" in text help',
		);

		rmSync(dataDir, { recursive: true, force: true });
	});

	test("text help lists command verbs", async () => {
		dataDir = mkdtempSync(join(tmpdir(), "c8ctl-help-test-"));
		writeFileSync(
			join(dataDir, "session.json"),
			JSON.stringify({ outputMode: "text" }),
		);

		const result = await c8text(dataDir, "help");
		assert.ok(result.stdout.includes("list"), 'Expected "list" verb');
		assert.ok(result.stdout.includes("search"), 'Expected "search" verb');
		assert.ok(result.stdout.includes("get"), 'Expected "get" verb');
		assert.ok(result.stdout.includes("deploy"), 'Expected "deploy" verb');

		rmSync(dataDir, { recursive: true, force: true });
	});

	test("command-specific help in text mode mentions the command", async () => {
		dataDir = mkdtempSync(join(tmpdir(), "c8ctl-help-test-"));
		writeFileSync(
			join(dataDir, "session.json"),
			JSON.stringify({ outputMode: "text" }),
		);

		const result = await c8text(dataDir, "help", "search");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assert.ok(
			result.stdout.includes("search") || result.stderr.includes("search"),
			'Expected "search" in help output',
		);

		rmSync(dataDir, { recursive: true, force: true });
	});

	test("help for plugin command delegates to plugin (c8ctl help cluster)", async () => {
		dataDir = mkdtempSync(join(tmpdir(), "c8ctl-help-test-"));
		writeFileSync(
			join(dataDir, "session.json"),
			JSON.stringify({ outputMode: "text" }),
		);

		const result = await c8text(dataDir, "help", "cluster");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const output = result.stdout + result.stderr;
		// The cluster plugin shows its own help — verify key sections appear
		assert.ok(
			output.includes("c8ctl cluster start"),
			"Expected cluster start usage",
		);
		assert.ok(
			output.includes("c8ctl cluster stop"),
			"Expected cluster stop usage",
		);
		assert.ok(output.includes("Subcommands:"), "Expected Subcommands section");
		assert.ok(output.includes("Examples:"), "Expected Examples section");
		// Must NOT show the "No detailed help available" fallback
		assert.ok(
			!output.includes("No detailed help available"),
			"Should not show fallback message",
		);

		rmSync(dataDir, { recursive: true, force: true });
	});

	test("help for plugin command delegates to plugin (c8ctl help bpmn)", async () => {
		dataDir = mkdtempSync(join(tmpdir(), "c8ctl-help-test-"));
		writeFileSync(
			join(dataDir, "session.json"),
			JSON.stringify({ outputMode: "text" }),
		);

		const result = await c8text(dataDir, "help", "bpmn");
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const output = result.stdout + result.stderr;
		// The bpmn plugin shows its own help — verify key sections appear
		assert.ok(output.includes("c8ctl bpmn lint"), "Expected bpmn lint usage");
		assert.ok(
			output.includes("apply-element-template"),
			"Expected apply-element-template usage",
		);
		assert.ok(output.includes("Subcommands:"), "Expected Subcommands section");
		// Must NOT show the "No detailed help available" fallback
		assert.ok(
			!output.includes("No detailed help available"),
			"Should not show fallback message",
		);

		rmSync(dataDir, { recursive: true, force: true });
	});
});
