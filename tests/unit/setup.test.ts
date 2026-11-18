/**
 * Behavioural tests for `c8ctl setup`: registration, welcome + plan
 * output, --dry-run, help, completion, the interactive prompts driven
 * through a fake TTY, and execution of the wired-up steps (Desktop
 * Modeler install, blueprint scaffold + deploy) against the offline
 * stub in tests/utils/setup-stub.ts.
 */

import assert from "node:assert";
import { spawn } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { describe, test } from "node:test";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { isRecord } from "../../src/core/index.ts";
import { c8, c8WithOptions } from "../utils/cli.ts";

const CLI = resolve(import.meta.dirname, "..", "..", "src", "index.ts");
const FAKE_TTY = pathToFileURL(
	resolve(import.meta.dirname, "..", "utils", "fake-tty.ts"),
).href;
const SETUP_STUB = pathToFileURL(
	resolve(import.meta.dirname, "..", "utils", "setup-stub.ts"),
).href;

const BRAND_BLUE = "\x1b[38;2;79;57;246m";
const PROMPT_TEXT = "What should we set up for you?";
const BLUEPRINT_PROMPT_TEXT = "Which starter blueprint should we install?";

interface InteractiveResult {
	status: number | null;
	stdout: string;
	stderr: string;
}

interface KeyStage {
	/** stderr marker that arms this stage. */
	waitFor: string;
	/** Keys written (stdin closed) once the marker appears. */
	keys: string;
}

/**
 * Spawn `c8ctl setup` under a fake TTY, then send each stage's keys when
 * its marker renders on stderr. Mirrors the prompt driver in
 * tests/utils/deploy-resources.ts.
 *
 * The child env forwards the isolated C8CTL_DATA_DIR from the test
 * preload (or allocates a dedicated temp dir) so spawned processes never
 * touch the developer's real session, profiles or completion files.
 * `fallbackKeys` are sent when no menu appears within 5s, so a
 * regression that wrongly skips rendering fails fast instead of hitting
 * the SIGKILL safety net.
 */
function runInteractive(
	stages: KeyStage[],
	{
		args = [],
		env = {},
		nodeArgs = [],
		cwd,
		fallbackKeys = "\x1b",
	}: {
		args?: string[];
		env?: Record<string, string>;
		nodeArgs?: string[];
		/** Working directory — pass a temp dir for runs that scaffold. */
		cwd?: string;
		fallbackKeys?: string;
	} = {},
): Promise<InteractiveResult> {
	const forwardedDataDir = process.env.C8CTL_DATA_DIR;
	const ownDataDir = forwardedDataDir
		? undefined
		: mkdtempSync(join(tmpdir(), "c8ctl-setup-test-"));
	return new Promise((resolveRun, rejectRun) => {
		const child = spawn(
			"node",
			[
				"--experimental-strip-types",
				"--import",
				FAKE_TTY,
				...nodeArgs,
				CLI,
				"setup",
				...args,
			],
			{
				stdio: ["pipe", "pipe", "pipe"],
				...(cwd !== undefined ? { cwd } : {}),
				env: {
					PATH: process.env.PATH,
					HOME: "/tmp/c8ctl-test-nonexistent-home",
					C8CTL_DATA_DIR: forwardedDataDir ?? ownDataDir,
					C8CTL_INTERACTIVE: "true",
					C8CTL_OUTPUT_MODE: "text",
					...env,
				},
			},
		);
		let stdout = "";
		let stderr = "";
		let stageIndex = 0;
		const sendStage = () => {
			if (stageIndex >= stages.length) return;
			child.stdin.write(stages[stageIndex].keys);
			stageIndex += 1;
			if (stageIndex >= stages.length) child.stdin.end();
		};
		child.stdout.setEncoding("utf-8");
		child.stderr.setEncoding("utf-8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
			// The marker row signals the prompt has rendered; piped stdin
			// buffers, so the keys are delivered once the prompt listens.
			if (
				stageIndex < stages.length &&
				stderr.includes(stages[stageIndex].waitFor)
			) {
				sendStage();
			}
		});
		// If no menu renders (e.g. a mode that must not prompt), close
		// stdin with the fallback keys so the child can exit on its own.
		const fallback = setTimeout(() => {
			if (stageIndex === 0) {
				child.stdin.end(fallbackKeys);
				stageIndex = stages.length;
			}
		}, 5_000);
		// Safety net only: a stuck prompt must not hang the test runner.
		const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
		child.on("error", rejectRun);
		child.on("close", (status) => {
			clearTimeout(fallback);
			clearTimeout(timer);
			if (ownDataDir) rmSync(ownDataDir, { recursive: true, force: true });
			resolveRun({ status, stdout, stderr });
		});
	});
}

/**
 * An offline execution sandbox for `c8ctl setup --yes`: a temp working
 * directory for the scaffolded project, a fake `camunda-modeler` on PATH
 * (the Linux installed-lookup; macOS/Windows detection is patched in the
 * stub itself), and the fetch/fs stub preload.
 */
function stubbedExecution({
	clusterUp = false,
}: {
	clusterUp?: boolean;
} = {}): {
	cwd: string;
	options: {
		cwd: string;
		nodeArgs: string[];
		env: Record<string, string>;
	};
	cleanup: () => void;
} {
	const cwd = mkdtempSync(join(tmpdir(), "c8ctl-setup-run-"));
	const bin = join(cwd, "bin");
	mkdirSync(bin);
	const fakeModeler = join(bin, "camunda-modeler");
	writeFileSync(fakeModeler, "#!/bin/sh\n");
	chmodSync(fakeModeler, 0o755);
	return {
		cwd,
		options: {
			cwd,
			nodeArgs: ["--import", SETUP_STUB],
			env: {
				C8CTL_OUTPUT_MODE: "text",
				PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
				...(clusterUp ? { C8CTL_SETUP_STUB_CLUSTER: "up" } : {}),
			},
		},
		cleanup: () => rmSync(cwd, { recursive: true, force: true }),
	};
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

	test("JSON mode never executes: it prints the plan only", async () => {
		const stub = stubbedExecution();
		try {
			const result = await c8WithOptions(
				{ nodeArgs: stub.options.nodeArgs, cwd: stub.cwd },
				"setup",
				"--yes",
			);
			assert.strictEqual(result.status, 0, result.stderr);
			const payload = JSON.parse(result.stdout);
			assert.strictEqual(payload.command, "setup");
			assert.strictEqual(payload.blueprint, "rocket-launch");
			// Nothing was scaffolded, though --yes would execute in text mode.
			assert.ok(!existsSync(join(stub.cwd, "rocket-launch")));
		} finally {
			stub.cleanup();
		}
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
		// Without --yes or an interactive selection nothing is executed.
		assert.match(result.stdout, /Nothing was installed\./);
		// Non-interactive output is plain: no ANSI escapes on stdout.
		assert.strictEqual(result.stdout, stripVTControlCharacters(result.stdout));
	});

	test("--dry-run emits a JSON preview without running anything", async () => {
		const result = await c8("setup", "--dry-run");
		assert.strictEqual(result.status, 0, result.stderr);
		const payload = JSON.parse(result.stdout);
		assert.strictEqual(payload.dryRun, true);
		assert.strictEqual(payload.command, "setup");
		assert.ok(Array.isArray(payload.steps));
	});

	test("--dry-run --blueprint reports the requested blueprint", async () => {
		const result = await c8("setup", "--dry-run", "--blueprint", "ai-agent");
		assert.strictEqual(result.status, 0, result.stderr);
		const payload = JSON.parse(result.stdout);
		assert.strictEqual(payload.blueprint, "ai-agent");
	});

	test("an unknown --blueprint id fails and lists the valid ids", async () => {
		const result = await c8WithOptions(
			{ env: { C8CTL_OUTPUT_MODE: "text" } },
			"setup",
			"--blueprint",
			"bogus",
		);
		assert.strictEqual(result.status, 1, result.stdout);
		const out = stripVTControlCharacters(result.stdout + result.stderr);
		assert.match(
			out,
			/Unknown blueprint "bogus"\. Available blueprints: rocket-launch, service-worker, ai-agent\./,
		);
	});

	test("--no-modeler marks the modeler step skipped", async () => {
		const result = await c8WithOptions(
			{ env: { C8CTL_OUTPUT_MODE: "text" } },
			"setup",
			"--no-modeler",
		);
		assert.strictEqual(result.status, 0, result.stderr);
		assert.match(result.stdout, /- Install Desktop Modeler — skipped/);
	});

	test("--no-modeler wins over --modeler", async () => {
		const result = await c8WithOptions(
			{ env: { C8CTL_OUTPUT_MODE: "text" } },
			"setup",
			"--modeler",
			"--no-modeler",
		);
		assert.strictEqual(result.status, 0, result.stderr);
		assert.match(result.stdout, /- Install Desktop Modeler — skipped/);
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

	test("help setup shows the detailed page with notes and flags", async () => {
		const result = await c8WithOptions(
			{ env: { C8CTL_OUTPUT_MODE: "text" } },
			"help",
			"setup",
		);
		assert.strictEqual(result.status, 0, result.stderr);
		assert.match(result.stdout, /Usage: c8ctl setup/);
		assert.match(result.stdout, /Nothing is installed without your say\./);
		assert.match(result.stdout, /--blueprint/);
		assert.match(result.stdout, /--no-modeler/);
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

	test("--yes executes the plan: prerequisites, modeler, blueprint", async () => {
		const stub = stubbedExecution();
		try {
			const result = await c8WithOptions(
				stub.options,
				"setup",
				"--yes",
				"--blueprint",
				"rocket-launch",
			);
			assert.strictEqual(result.status, 0, result.stderr);
			assert.doesNotMatch(result.stderr, /What should we set up/);
			const out = stripVTControlCharacters(result.stdout + result.stderr);
			assert.match(out, /▸ Check prerequisites/);
			assert.match(out, /✓ Node\.js version/);
			// Steps that are not wired up yet say so instead of running.
			assert.match(
				out,
				/Install Camunda 8 Run — setup can't do this step yet; skipped\./,
			);
			assert.match(out, /▸ Install Desktop Modeler/);
			assert.match(out, /already installed at .*skipping installation/);
			assert.match(out, /▸ Create the blueprint project/);
			assert.match(out, /Project ready at /);
			// The stub cluster is down: deploy degrades to next actions,
			// pinned to the same local profile the healthy path uses.
			assert.match(out, /Could not reach the local cluster/);
			assert.match(out, /c8ctl cluster start/);
			assert.match(out, /c8ctl deploy ".*rocket-launch" --profile local/);
			assert.match(out, /Setup finished\./);
			// The project was scaffolded into the working directory.
			assert.ok(
				existsSync(join(stub.cwd, "rocket-launch", "rocket-launch.bpmn")),
				"blueprint was not scaffolded",
			);
		} finally {
			stub.cleanup();
		}
	});

	test("--yes deploys the blueprint and starts a process instance when the cluster is up", async () => {
		const stub = stubbedExecution({ clusterUp: true });
		const capture = join(stub.cwd, "capture.json");
		try {
			const result = await c8WithOptions(
				{
					...stub.options,
					env: {
						...stub.options.env,
						C8CTL_SETUP_STUB_CAPTURE: capture,
					},
				},
				"setup",
				"--yes",
				"--blueprint",
				"rocket-launch",
			);
			assert.strictEqual(result.status, 0, result.stderr);
			const out = stripVTControlCharacters(result.stdout + result.stderr);
			assert.match(out, /Deployment successful/);
			assert.match(out, /Process instance created/);
			assert.match(out, /2251799813686751/);
			assert.match(out, /Setup finished\./);
			// The Rocket Launch model needs mission inputs to run through;
			// setup starts the instance with the blueprint's variables.
			const request: unknown = JSON.parse(readFileSync(capture, "utf-8"));
			assert.ok(isRecord(request), "capture is not an object");
			assert.strictEqual(request.processDefinitionId, "rocket-launch");
			assert.deepStrictEqual(request.variables, {
				missionName: "Apollo",
				fuelLevel: 80,
			});
		} finally {
			stub.cleanup();
		}
	});

	test("interactive: toggling the cluster off skips its steps", async () => {
		// Space on the highlighted "Local cluster" row, Enter to confirm,
		// then Enter again to accept the default blueprint.
		const stub = stubbedExecution();
		try {
			const result = await runInteractive(
				[
					{ waitFor: "Docs MCP server", keys: " \r" },
					{ waitFor: BLUEPRINT_PROMPT_TEXT, keys: "\r" },
				],
				{
					nodeArgs: stub.options.nodeArgs,
					env: stub.options.env,
					cwd: stub.cwd,
				},
			);
			assert.strictEqual(result.status, 0, result.stderr);
			assert.ok(result.stderr.includes(PROMPT_TEXT), "prompt not rendered");
			assert.ok(
				result.stderr.includes(BLUEPRINT_PROMPT_TEXT),
				"blueprint prompt not rendered",
			);
			assert.ok(
				result.stderr.includes(BRAND_BLUE),
				"banner is not brand-colored",
			);
			// stdout is piped here: output must stay plain text even though
			// the session is interactive and the banner on stderr is colored.
			assert.strictEqual(
				result.stdout,
				stripVTControlCharacters(result.stdout),
			);
			const out = stripVTControlCharacters(result.stdout + result.stderr);
			assert.match(out, /01\. Check prerequisites/);
			assert.match(out, /- Install Camunda 8 Run — skipped/);
			assert.match(out, /- Start the local cluster — skipped/);
			assert.match(out, /02\. Install Desktop Modeler/);
			// With the go-ahead given, the selected steps executed.
			assert.match(out, /Setup finished\./);
		} finally {
			stub.cleanup();
		}
	});

	test("interactive terminal with --json never prompts and prints the plan", async () => {
		const result = await runInteractive(
			[{ waitFor: PROMPT_TEXT, keys: "\x1b" }],
			{ args: ["--json"] },
		);
		assert.strictEqual(result.status, 0, result.stderr);
		assert.doesNotMatch(result.stderr, new RegExp(PROMPT_TEXT));
		const payload = JSON.parse(result.stdout);
		assert.strictEqual(payload.command, "setup");
		assert.strictEqual(payload.preview, true);
		assert.strictEqual(payload.steps.length, 10);
	});

	test("interactive: Escape cancels without printing a plan", async () => {
		const result = await runInteractive([
			{ waitFor: "Docs MCP server", keys: "\x1b" },
		]);
		assert.strictEqual(result.status, 0, result.stderr);
		assert.match(result.stdout, /Cancelled — nothing was changed\./);
		assert.doesNotMatch(result.stdout, /Check prerequisites/);
	});

	test("interactive: Escape at the blueprint choice cancels too", async () => {
		const result = await runInteractive([
			{ waitFor: "Docs MCP server", keys: "\r" },
			{ waitFor: BLUEPRINT_PROMPT_TEXT, keys: "\x1b" },
		]);
		assert.strictEqual(result.status, 0, result.stderr);
		assert.match(result.stdout, /Cancelled — nothing was changed\./);
		assert.doesNotMatch(result.stdout, /Setup finished\./);
	});
});
