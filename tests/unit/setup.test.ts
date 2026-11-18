/**
 * Behavioural tests for `c8ctl setup`: registration, welcome + plan
 * output, --dry-run, help, completion, the interactive prompts driven
 * through a fake TTY (including the cluster→blueprint dependency), and
 * full execution of every step against the offline stub in
 * tests/utils/setup-stub.ts (cluster child processes, GitHub, the
 * Orchestration Cluster API, Modeler detection, gh, browser).
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
 * An offline execution sandbox for `c8ctl setup --yes`:
 * - a temp working directory the blueprint project is scaffolded into
 * - a fake `camunda-modeler` executable (the Linux installed-lookup;
 *   macOS/Windows detection is patched in the stub itself)
 * - a fixture HOME with a `.claude` directory, so harness detection
 *   finds Claude Code and every harness config root (HOME, USERPROFILE,
 *   APPDATA, XDG_CONFIG_HOME) points into the fixture — a harness found
 *   on the host PATH can never write to a real user config
 * - the fetch/fs/child-process stub preload
 */
function stubbedExecution({
	clusterUp = false,
	failStep,
	capture,
}: {
	clusterUp?: boolean;
	/** Step id whose child process exits 1 (e.g. "start-cluster"). */
	failStep?: string;
	/** File the process-instance request body is captured into. */
	capture?: string;
} = {}): {
	cwd: string;
	home: string;
	options: {
		cwd: string;
		nodeArgs: string[];
		env: Record<string, string>;
	};
	cleanup: () => void;
} {
	const cwd = mkdtempSync(join(tmpdir(), "c8ctl-setup-run-"));
	const bin = join(cwd, "bin");
	const home = join(cwd, "home");
	mkdirSync(join(home, ".claude"), { recursive: true });
	mkdirSync(bin);
	const fakeModeler = join(bin, "camunda-modeler");
	writeFileSync(fakeModeler, "#!/bin/sh\n");
	chmodSync(fakeModeler, 0o755);
	return {
		cwd,
		home,
		options: {
			cwd,
			nodeArgs: ["--import", SETUP_STUB],
			env: {
				C8CTL_OUTPUT_MODE: "text",
				PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
				HOME: home,
				USERPROFILE: home,
				APPDATA: join(home, "AppData", "Roaming"),
				XDG_CONFIG_HOME: join(home, ".config"),
				// These take precedence over HOME in the MCP helper — pin them
				// into the fixture as well, or a developer who exports them
				// would have their real harness config rewritten by the test.
				CLAUDE_CONFIG_DIR: join(home, ".claude"),
				COPILOT_HOME: join(home, ".copilot"),
				...(clusterUp ? { C8CTL_SETUP_STUB_CLUSTER: "up" } : {}),
				...(failStep ? { C8CTL_SETUP_STUB_FAIL: failStep } : {}),
				...(capture ? { C8CTL_SETUP_STUB_CAPTURE: capture } : {}),
			},
		},
		cleanup: () => rmSync(cwd, { recursive: true, force: true }),
	};
}

/** Every step title followed by its status tag. */
function stepLine(
	out: string,
	title: string,
	tag: "SUCCESS" | "ERROR" | "SKIPPED",
): void {
	assert.match(
		out,
		new RegExp(
			`${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\.+ \\[${tag}\\]`,
		),
		`expected "${title} … [${tag}]" in:\n${out}`,
	);
}

describe("c8ctl setup", () => {
	test("is registered: prints the plan as JSON and exits 0", async () => {
		const result = await c8("setup");
		assert.strictEqual(result.status, 0, result.stderr);
		const payload = JSON.parse(result.stdout);
		assert.strictEqual(payload.command, "setup");
		assert.strictEqual(payload.preview, true);
		assert.strictEqual(payload.components.length, 6);
		assert.strictEqual(payload.steps.length, 8);
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

	test("text mode prints the welcome banner and stops without a go-ahead", async () => {
		const result = await c8WithOptions(
			{ env: { C8CTL_OUTPUT_MODE: "text" } },
			"setup",
		);
		assert.strictEqual(result.status, 0, result.stderr);
		assert.match(result.stdout, /Welcome to Camunda 8!/);
		// No plan preview: the step report is the only step listing.
		assert.doesNotMatch(result.stdout, /Here's what c8ctl setup will do/);
		// Without --yes or an interactive selection nothing is executed.
		assert.match(result.stdout, /Nothing was installed\./);
		assert.match(result.stdout, /c8ctl setup --yes/);
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

	test("--no-modeler deselects the modeler component", async () => {
		const result = await c8("setup", "--no-modeler");
		assert.strictEqual(result.status, 0, result.stderr);
		const payload = JSON.parse(result.stdout);
		const modeler = payload.components.find(
			(c: { id: string }) => c.id === "modeler",
		);
		assert.strictEqual(modeler.selected, false);
		const modelerStep = payload.steps.find(
			(s: { title: string }) => s.title === "Install Desktop Modeler",
		);
		assert.strictEqual(modelerStep.status, "skipped");
	});

	test("--no-modeler wins over --modeler", async () => {
		const result = await c8("setup", "--modeler", "--no-modeler");
		assert.strictEqual(result.status, 0, result.stderr);
		const payload = JSON.parse(result.stdout);
		const modeler = payload.components.find(
			(c: { id: string }) => c.id === "modeler",
		);
		assert.strictEqual(modeler.selected, false);
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
		assert.match(result.stdout, /\[SUCCESS\]/);
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

	test("--yes runs every selected step and reports [SUCCESS] per step", async () => {
		const capture = join(
			mkdtempSync(join(tmpdir(), "c8ctl-setup-capture-")),
			"capture.json",
		);
		const stub = stubbedExecution({ capture });
		// A preselected tenant must not leak into the local deployment:
		// setup pins the local cluster's default tenant.
		stub.options.env.CAMUNDA_DEFAULT_TENANT_ID = "remote-tenant";
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
			stepLine(out, "Check prerequisites", "SUCCESS");
			stepLine(out, "Start the local cluster", "SUCCESS");
			stepLine(out, "Install Desktop Modeler", "SUCCESS");
			stepLine(out, "Create the blueprint project", "SUCCESS");
			stepLine(out, "Deploy and start the process", "SUCCESS");
			stepLine(out, "Install AI assistant skills", "SUCCESS");
			stepLine(out, "Configure the cluster MCP server", "SUCCESS");
			assert.doesNotMatch(out, /Configure the docs MCP server .+ \[/);
			// A step without additional info collapses to a single line…
			assert.doesNotMatch(out, /^ {2}Start the local cluster$/m);
			// …while a step with useful lines shows them between its title
			// and its status line.
			assert.match(out, /^ {2}Install AI assistant skills$/m);
			assert.match(out, /Installing Camunda skills \(camunda\/skills\) for /);
			assert.match(out, /MCP configuration: /);
			// Everything else is held back: no c8run chatter, no progress
			// percentages, no deploy progress, no prerequisite checklist.
			assert.doesNotMatch(out, /\/\/>/);
			assert.doesNotMatch(out, /Downloading Camunda/);
			assert.doesNotMatch(out, /Cluster is ready!/);
			assert.doesNotMatch(out, /Deploying \d+ resource/);
			assert.doesNotMatch(out, /Deployment successful/);
			assert.doesNotMatch(out, /✓ Network access/);
			assert.match(
				out,
				/Operate: http:\/\/localhost:8080\/operate — log in with demo\/demo/,
			);
			assert.match(out, /Setup finished\./);
			// The project was scaffolded into the working directory.
			assert.ok(
				existsSync(join(stub.cwd, "rocket-launch", "rocket-launch.bpmn")),
				"blueprint was not scaffolded",
			);
			// The cluster MCP server was written into the fixture harness
			// (CLAUDE_CONFIG_DIR is pinned into the fixture home).
			const mcpConfig: unknown = JSON.parse(
				readFileSync(join(stub.home, ".claude", ".claude.json"), "utf-8"),
			);
			assert.ok(isRecord(mcpConfig) && isRecord(mcpConfig.mcpServers));
			assert.ok(isRecord(mcpConfig.mcpServers.camunda));
			// The Rocket Launch model needs mission inputs to run through;
			// setup starts the instance with the blueprint's variables.
			const request: unknown = JSON.parse(readFileSync(capture, "utf-8"));
			assert.ok(isRecord(request), "capture is not an object");
			assert.strictEqual(request.processDefinitionId, "rocket-launch");
			assert.strictEqual(
				request.tenantId,
				"<default>",
				"a preselected tenant leaked into the local deployment",
			);
			assert.deepStrictEqual(request.variables, {
				missionName: "Apollo",
				fuelLevel: 80,
			});
		} finally {
			stub.cleanup();
		}
	});

	test("a cluster warning on stderr shows even though the step succeeds", async () => {
		const stub = stubbedExecution();
		stub.options.env.C8CTL_SETUP_STUB_CLUSTER_WARN = "1";
		try {
			const result = await c8WithOptions(
				stub.options,
				"setup",
				"--yes",
				"--blueprint",
				"rocket-launch",
			);
			assert.strictEqual(result.status, 0, result.stderr);
			const out = stripVTControlCharacters(result.stdout + result.stderr);
			stepLine(out, "Start the local cluster", "SUCCESS");
			// stderr passes through: the warning is not buffered away.
			assert.match(out, /Could not persist the durable cluster PID record/);
		} finally {
			stub.cleanup();
		}
	});

	test("a failed step reports [ERROR] with its buffered output, skips dependents, and the rest still runs", async () => {
		const stub = stubbedExecution({ failStep: "start-cluster" });
		try {
			const result = await c8WithOptions(
				stub.options,
				"setup",
				"--yes",
				"--blueprint",
				"rocket-launch",
			);
			assert.strictEqual(result.status, 1, result.stdout);
			const out = stripVTControlCharacters(result.stdout + result.stderr);
			stepLine(out, "Start the local cluster", "ERROR");
			assert.match(out, /c8ctl cluster start failed \(exit code 1\)\./);
			// The failed step's buffered output is flushed as diagnostics…
			assert.match(out, /stubbed cluster failure diagnostics/);
			assert.match(out, /Downloading Camunda 8\.10 for darwin\.\.\./);
			// …but the percentage spam is filtered even then.
			assert.doesNotMatch(out, /\/\/>/);
			// Dependents are skipped with the unmet step named.
			stepLine(out, "Deploy and start the process", "SKIPPED");
			stepLine(out, "Configure the cluster MCP server", "SKIPPED");
			assert.match(out, /needs: Start the local cluster/);
			// Unrelated steps still ran.
			stepLine(out, "Install Desktop Modeler", "SUCCESS");
			stepLine(out, "Create the blueprint project", "SUCCESS");
			stepLine(out, "Install AI assistant skills", "SUCCESS");
			assert.match(out, /Setup finished with 1 failed step/);
			// The project exists but was never deployed.
			assert.ok(
				existsSync(join(stub.cwd, "rocket-launch", "rocket-launch.bpmn")),
			);
		} finally {
			stub.cleanup();
		}
	});

	test("--quiet hides step chatter but a failed step still shows its diagnostics", async () => {
		const stub = stubbedExecution({ failStep: "start-cluster" });
		try {
			const result = await c8WithOptions(
				stub.options,
				"setup",
				"--yes",
				"--quiet",
				"--blueprint",
				"rocket-launch",
			);
			assert.strictEqual(result.status, 1, result.stdout);
			const out = stripVTControlCharacters(result.stdout + result.stderr);
			stepLine(out, "Start the local cluster", "ERROR");
			// The failed step's buffered output is essential on failure.
			assert.match(out, /stubbed cluster failure diagnostics/);
			assert.match(out, /Downloading Camunda 8\.10/);
			assert.doesNotMatch(out, /\/\/>/);
			// Successful steps stay collapsed: no title announcement lines.
			assert.doesNotMatch(out, /^ {2}Install Desktop Modeler$/m);
		} finally {
			stub.cleanup();
		}
	});

	test("--yes --docs-mcp also configures the docs MCP server", async () => {
		const stub = stubbedExecution();
		try {
			const result = await c8WithOptions(
				stub.options,
				"setup",
				"--yes",
				"--docs-mcp",
				"--blueprint",
				"rocket-launch",
			);
			assert.strictEqual(result.status, 0, result.stderr);
			const out = stripVTControlCharacters(result.stdout + result.stderr);
			stepLine(out, "Configure the docs MCP server", "SUCCESS");
			// The sign-in browser window is announced before the first step runs.
			assert.match(
				out,
				/the docs MCP server needs you to sign in — your AI assistant will open a browser window/,
			);
			assert.match(out, /asks you to sign in in a browser on first use/);
			const mcpConfig: unknown = JSON.parse(
				readFileSync(join(stub.home, ".claude", ".claude.json"), "utf-8"),
			);
			assert.ok(
				isRecord(mcpConfig) &&
					isRecord(mcpConfig.mcpServers) &&
					isRecord(mcpConfig.mcpServers["camunda-docs"]),
				"docs MCP server was not written",
			);
		} finally {
			stub.cleanup();
		}
	});

	test("--docs-mcp plans the docs step non-interactively", async () => {
		const result = await c8("setup", "--docs-mcp");
		assert.strictEqual(result.status, 0, result.stderr);
		const payload = JSON.parse(result.stdout);
		const docsStep = payload.steps.find(
			(s: { title: string }) => s.title === "Configure the docs MCP server",
		);
		assert.strictEqual(docsStep.status, "planned");
	});

	test("the ai-agent blueprint is deployed but not started, with guidance", async () => {
		const capture = join(
			mkdtempSync(join(tmpdir(), "c8ctl-setup-capture-")),
			"capture.json",
		);
		const stub = stubbedExecution({ capture });
		try {
			const result = await c8WithOptions(
				stub.options,
				"setup",
				"--yes",
				"--blueprint",
				"ai-agent",
			);
			assert.strictEqual(result.status, 0, result.stderr);
			const out = stripVTControlCharacters(result.stdout + result.stderr);
			stepLine(out, "Deploy and start the process", "SUCCESS");
			// The deploy's success render is quiet; the guidance is essential.
			assert.doesNotMatch(out, /Deployment successful/);
			assert.match(out, /deployed but not started/);
			assert.match(out, /needs an LLM provider/);
			assert.match(
				out,
				/c8ctl create pi --id=ai-agent-chat-with-tools .* --profile local/,
			);
			// No process instance was started.
			assert.ok(
				!existsSync(capture),
				"an instance was started despite the missing LLM provider",
			);
		} finally {
			stub.cleanup();
		}
	});

	test("a failed scaffold skips the deploy step instead of failing it too", async () => {
		const stub = stubbedExecution();
		try {
			// The destination exists and is not empty, so scaffolding refuses.
			mkdirSync(join(stub.cwd, "rocket-launch"));
			writeFileSync(join(stub.cwd, "rocket-launch", "README.md"), "occupied\n");
			const result = await c8WithOptions(
				stub.options,
				"setup",
				"--yes",
				"--blueprint",
				"rocket-launch",
			);
			assert.strictEqual(result.status, 1, result.stdout);
			const out = stripVTControlCharacters(result.stdout + result.stderr);
			stepLine(out, "Create the blueprint project", "ERROR");
			assert.match(out, /already exists and is not empty/);
			stepLine(out, "Deploy and start the process", "SKIPPED");
			assert.match(out, /needs: Create the blueprint project/);
			// One failed step, not two.
			assert.match(out, /Setup finished with 1 failed step/);
		} finally {
			stub.cleanup();
		}
	});

	test("a failed deploy closes the title line before its diagnostics", async () => {
		const stub = stubbedExecution({ failStep: "deploy-blueprint" });
		try {
			const result = await c8WithOptions(
				stub.options,
				"setup",
				"--yes",
				"--blueprint",
				"rocket-launch",
			);
			assert.strictEqual(result.status, 1, result.stdout);
			const out = stripVTControlCharacters(result.stdout + result.stderr);
			stepLine(out, "Deploy and start the process", "ERROR");
			// The deploy helper renders through the step's logger, so its
			// diagnostics close the title line instead of colliding with it.
			assert.match(out, /^ {2}Deploy and start the process$/m);
			assert.match(out, /✗ Deployment failed/);
			// SilentError: the helper rendered the failure — no summary reprint.
			assert.doesNotMatch(out, /^ {4}INVALID_ARGUMENT$/m);
		} finally {
			stub.cleanup();
		}
	});

	test("a failed skills install does not stop the remaining steps", async () => {
		const stub = stubbedExecution({ failStep: "install-skills" });
		try {
			const result = await c8WithOptions(
				stub.options,
				"setup",
				"--yes",
				"--blueprint",
				"rocket-launch",
			);
			assert.strictEqual(result.status, 1, result.stdout);
			const out = stripVTControlCharacters(result.stdout + result.stderr);
			stepLine(out, "Install AI assistant skills", "ERROR");
			assert.match(out, /GitHub CLI failed to install Camunda skills/);
			// The steps after it are independent and still succeeded.
			stepLine(out, "Configure the cluster MCP server", "SUCCESS");
		} finally {
			stub.cleanup();
		}
	});

	test("interactive: toggling the cluster off disables the blueprint", async () => {
		// Space on the highlighted "Local cluster" row, then Enter. The
		// blueprint option is dependency-disabled, so no blueprint prompt.
		const stub = stubbedExecution();
		try {
			const result = await runInteractive(
				[{ waitFor: "Docs MCP server", keys: " \r" }],
				{
					nodeArgs: stub.options.nodeArgs,
					env: stub.options.env,
					cwd: stub.cwd,
				},
			);
			assert.strictEqual(result.status, 0, result.stderr);
			assert.ok(result.stderr.includes(PROMPT_TEXT), "prompt not rendered");
			assert.ok(
				!result.stderr.includes(BLUEPRINT_PROMPT_TEXT),
				"blueprint prompt should not render when the cluster is off",
			);
			assert.match(
				stripVTControlCharacters(result.stderr),
				/Starter blueprint.*— needs the local cluster/,
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
			// Deselected steps simply do not run — there is no plan preview.
			// (The skipped cluster MCP step names its unmet dependency, so
			// only a step-line-shaped match counts.)
			assert.doesNotMatch(out, /^ {2}Start the local cluster/m);
			assert.doesNotMatch(out, /Create the blueprint project/);
			stepLine(out, "Configure the cluster MCP server", "SKIPPED");
			stepLine(out, "Install Desktop Modeler", "SUCCESS");
			stepLine(out, "Install AI assistant skills", "SUCCESS");
			// No blueprint project without the cluster.
			assert.ok(!existsSync(join(stub.cwd, "rocket-launch")));
		} finally {
			stub.cleanup();
		}
	});

	test("interactive: --blueprint is ignored when the cluster is deselected", async () => {
		// The flag cannot resurrect the dependency-disabled blueprint.
		const stub = stubbedExecution();
		try {
			const result = await runInteractive(
				[{ waitFor: "Docs MCP server", keys: " \r" }],
				{
					args: ["--blueprint", "rocket-launch"],
					nodeArgs: stub.options.nodeArgs,
					env: stub.options.env,
					cwd: stub.cwd,
				},
			);
			assert.strictEqual(result.status, 0, result.stderr);
			assert.match(
				stripVTControlCharacters(result.stdout + result.stderr),
				/--blueprint is ignored: the local cluster is not selected\./,
			);
			assert.ok(!existsSync(join(stub.cwd, "rocket-launch")));
		} finally {
			stub.cleanup();
		}
	});

	test("interactive: defaults run the whole setup end to end", async () => {
		const stub = stubbedExecution();
		try {
			const result = await runInteractive(
				[
					{ waitFor: "Docs MCP server", keys: "\r" },
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
			const out = stripVTControlCharacters(result.stdout + result.stderr);
			stepLine(out, "Check prerequisites", "SUCCESS");
			stepLine(out, "Deploy and start the process", "SUCCESS");
			assert.match(out, /Setup finished\./);
			assert.ok(
				existsSync(join(stub.cwd, "rocket-launch", "rocket-launch.bpmn")),
			);
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
		assert.strictEqual(payload.steps.length, 8);
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
