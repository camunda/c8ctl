/**
 * Behavioural tests for `c8ctl setup` (the skeleton): registration,
 * welcome + plan output, --dry-run, help, completion, and the
 * interactive checkbox list driven through a fake TTY.
 */

import assert from "node:assert";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { describe, test } from "node:test";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { c8, c8WithOptions } from "../utils/cli.ts";

const CLI = resolve(import.meta.dirname, "..", "..", "src", "index.ts");
const FAKE_TTY = pathToFileURL(
	resolve(import.meta.dirname, "..", "utils", "fake-tty.ts"),
).href;

const BRAND_BLUE = "\x1b[38;2;79;57;246m";
const PROMPT_TEXT = "What should we set up for you?";

interface InteractiveResult {
	status: number | null;
	stdout: string;
	stderr: string;
}

/**
 * Spawn `c8ctl setup` under a fake TTY, wait for the checkbox list to
 * render, then send the keystrokes. Mirrors the prompt driver in
 * tests/utils/deploy-resources.ts.
 */
function runInteractive(
	keys: string,
	args: string[] = [],
): Promise<InteractiveResult> {
	return new Promise((resolveRun, rejectRun) => {
		const child = spawn(
			"node",
			[
				"--experimental-strip-types",
				"--import",
				FAKE_TTY,
				CLI,
				"setup",
				...args,
			],
			{
				stdio: ["pipe", "pipe", "pipe"],
				env: {
					PATH: process.env.PATH,
					HOME: "/tmp/c8ctl-test-nonexistent-home",
					C8CTL_INTERACTIVE: "true",
					C8CTL_OUTPUT_MODE: "text",
				},
			},
		);
		let stdout = "";
		let stderr = "";
		let sent = false;
		child.stdout.setEncoding("utf-8");
		child.stderr.setEncoding("utf-8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
			// The last menu row signals the list has rendered; piped stdin
			// buffers, so the keys are delivered once the prompt listens.
			if (!sent && stderr.includes("Docs MCP server")) {
				sent = true;
				child.stdin.end(keys);
			}
		});
		// Safety net only: a stuck prompt must not hang the test runner.
		const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
		child.on("error", rejectRun);
		child.on("close", (status) => {
			clearTimeout(timer);
			resolveRun({ status, stdout, stderr });
		});
	});
}

describe("c8ctl setup", () => {
	test("is registered: prints the plan as JSON and exits 0", async () => {
		const result = await c8("setup");
		assert.strictEqual(result.status, 0, result.stderr);
		const payload = JSON.parse(result.stdout);
		assert.strictEqual(payload.command, "setup");
		assert.strictEqual(payload.preview, true);
		assert.strictEqual(payload.components.length, 6);
		assert.strictEqual(payload.steps.length, 10);
		assert.strictEqual(payload.steps[0].title, "Check prerequisites");
		const docsMcp = payload.components.find(
			(c: { id: string }) => c.id === "docs-mcp",
		);
		assert.strictEqual(docsMcp.selected, false);
	});

	test("text mode prints the welcome banner and the step overview", async () => {
		const result = await c8WithOptions(
			{ env: { C8CTL_OUTPUT_MODE: "text" } },
			"setup",
		);
		assert.strictEqual(result.status, 0, result.stderr);
		assert.match(result.stdout, /Welcome to Camunda 8!/);
		assert.match(result.stdout, /Here's what c8ctl setup will do:/);
		assert.match(result.stdout, /01\. Check prerequisites/);
		assert.match(result.stdout, /- Configure the docs MCP server — skipped/);
		// Non-interactive output is plain: no ANSI escapes on stdout.
		assert.strictEqual(result.stdout, stripVTControlCharacters(result.stdout));
	});

	test("--yes plans with the defaults without prompting", async () => {
		const result = await c8WithOptions(
			{ env: { C8CTL_OUTPUT_MODE: "text" } },
			"setup",
			"--yes",
		);
		assert.strictEqual(result.status, 0, result.stderr);
		assert.doesNotMatch(result.stderr, /What should we set up/);
		assert.match(result.stdout, /01\. Check prerequisites/);
		assert.doesNotMatch(result.stdout, /run interactively to choose/);
	});

	test("--dry-run emits a JSON preview without running anything", async () => {
		const result = await c8("setup", "--dry-run");
		assert.strictEqual(result.status, 0, result.stderr);
		const payload = JSON.parse(result.stdout);
		assert.strictEqual(payload.dryRun, true);
		assert.strictEqual(payload.command, "setup");
		assert.ok(Array.isArray(payload.steps));
	});

	test("--help documents the command", async () => {
		const result = await c8WithOptions(
			{ env: { C8CTL_OUTPUT_MODE: "text" } },
			"setup",
			"--help",
		);
		assert.strictEqual(result.status, 0, result.stderr);
		assert.match(
			result.stdout,
			/Guided first-run setup: install a local cluster/,
		);
	});

	test("help setup shows the detailed page with notes", async () => {
		const result = await c8WithOptions(
			{ env: { C8CTL_OUTPUT_MODE: "text" } },
			"help",
			"setup",
		);
		assert.strictEqual(result.status, 0, result.stderr);
		assert.match(result.stdout, /Usage: c8ctl setup/);
		assert.match(result.stdout, /Nothing is installed without your say\./);
		assert.match(result.stdout, /Preview: the wizard prints the plan/);
	});

	test("top-level help lists setup with its example", async () => {
		const result = await c8WithOptions(
			{ env: { C8CTL_OUTPUT_MODE: "text" } },
			"--help",
		);
		assert.strictEqual(result.status, 0, result.stderr);
		assert.match(
			result.stdout,
			/Guided first-run setup: install a local cluster/,
		);
		assert.match(result.stdout, /c8ctl setup --yes/);
	});

	test("completion lists the setup verb", async () => {
		const result = await c8("completion", "bash");
		assert.strictEqual(result.status, 0, result.stderr);
		assert.match(result.stdout, /setup/);
	});

	test("interactive: toggling the cluster off skips its steps", async () => {
		// Space on the highlighted "Local cluster" row, then Enter.
		const result = await runInteractive(" \r");
		assert.strictEqual(result.status, 0, result.stderr);
		assert.ok(result.stderr.includes(PROMPT_TEXT), "prompt not rendered");
		assert.ok(
			result.stderr.includes(BRAND_BLUE),
			"banner is not brand-colored",
		);
		const plan = stripVTControlCharacters(result.stdout);
		assert.match(plan, /01\. Check prerequisites/);
		assert.match(plan, /- Install Camunda 8 Run — skipped/);
		assert.match(plan, /- Start the local cluster — skipped/);
		assert.match(plan, /02\. Install Desktop Modeler/);
		assert.match(plan, /Nothing was installed/);
	});

	test("interactive: Escape cancels without printing a plan", async () => {
		const result = await runInteractive("\x1b");
		assert.strictEqual(result.status, 0, result.stderr);
		assert.match(result.stdout, /Cancelled — nothing was changed\./);
		assert.doesNotMatch(result.stdout, /Check prerequisites/);
	});
});
