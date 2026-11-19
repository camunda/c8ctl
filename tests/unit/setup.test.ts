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
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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

function vscodeMcpConfigPath(home: string): string {
	const appData =
		process.platform === "darwin"
			? join(home, "Library", "Application Support")
			: process.platform === "win32"
				? join(home, "AppData", "Roaming")
				: join(home, ".config");
	return join(appData, "Code", "User", "mcp.json");
}

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
			process.execPath,
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
 *   outside the fixture cannot be discovered
 * - PATH contains only fixture executables
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
				PATH: bin,
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
		assert.strictEqual(result.status, 0, result.stderr + result.stdout);
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
			assert.strictEqual(result.status, 0, result.stderr + result.stdout);
			const payload = JSON.parse(result.stdout);
			assert.strictEqual(payload.command, "setup");
			assert.strictEqual(payload.blueprint, "rocket-launch");
			// Nothing was scaffolded, though --yes would execute in text mode.
			assert.ok(!existsSync(join(stub.cwd, "rocket-launch")));
		} finally {
			stub.cleanup();
		}
	});

	test("setup execution limits PATH to fixture executables", () => {
		const stub = stubbedExecution();
		try {
			assert.strictEqual(stub.options.env.PATH, join(stub.cwd, "bin"));
		} finally {
			stub.cleanup();
		}
	});

	test("text mode prints the welcome banner and stops without a go-ahead", async () => {
		const result = await c8WithOptions(
			{ env: { C8CTL_OUTPUT_MODE: "text" } },
			"setup",
		);
		assert.strictEqual(result.status, 0, result.stderr + result.stdout);
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
		assert.strictEqual(result.status, 0, result.stderr + result.stdout);
		const payload = JSON.parse(result.stdout);
		assert.strictEqual(payload.dryRun, true);
		assert.strictEqual(payload.command, "setup");
		assert.ok(Array.isArray(payload.steps));
	});

	test("--dry-run reports the default blueprint", async () => {
		const result = await c8("setup", "--dry-run");
		assert.strictEqual(result.status, 0, result.stderr + result.stdout);
		const payload = JSON.parse(result.stdout);
		assert.strictEqual(payload.blueprint, "rocket-launch");
	});

	test("--no-modeler deselects the modeler component", async () => {
		const result = await c8("setup", "--no-modeler");
		assert.strictEqual(result.status, 0, result.stderr + result.stdout);
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
		assert.strictEqual(result.status, 0, result.stderr + result.stdout);
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
		assert.strictEqual(result.status, 0, result.stderr + result.stdout);
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
		assert.strictEqual(result.status, 0, result.stderr + result.stdout);
		assert.match(result.stdout, /Usage: c8ctl setup/);
		assert.match(result.stdout, /Nothing is installed without your say\./);
		assert.match(result.stdout, /\[SUCCESS\]/);
		assert.match(result.stdout, /--no-modeler/);
		assert.match(result.stdout, /--remove/);
		assert.match(result.stdout, /--stop-cluster/);
		assert.match(result.stdout, /Desktop Modeler is not removed/);
		// The documented exit-code contract.
		assert.match(result.stdout, /Exit code 0/);
		assert.match(result.stdout, /Exit code 1: arguments failed validation/);
		// The blueprint is a wizard choice, not a CLI flag.
		assert.doesNotMatch(result.stdout, /--blueprint/);
	});

	test("top-level help lists setup with its example", async () => {
		const result = await c8WithOptions(
			{ env: { C8CTL_OUTPUT_MODE: "text" } },
			"--help",
		);
		assert.strictEqual(result.status, 0, result.stderr + result.stdout);
		assert.match(
			result.stdout,
			/Guided first-run setup: install a local cluster/,
		);
		assert.match(result.stdout, /c8ctl setup --yes/);
		assert.match(result.stdout, /c8ctl setup --remove/);
	});

	test("completion lists the setup verb", async () => {
		const result = await c8("completion", "bash");
		assert.strictEqual(result.status, 0, result.stderr + result.stdout);
		assert.match(result.stdout, /setup/);
		assert.match(result.stdout, /--remove/);
		assert.match(result.stdout, /--stop-cluster/);
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
			const result = await c8WithOptions(stub.options, "setup", "--yes");
			assert.strictEqual(result.status, 0, result.stderr + result.stdout);
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
			assert.match(out, /Checking Camunda skills \(camunda\/skills\) for /);
			assert.match(out, /MCP configuration: /);
			// Everything else is held back: no c8run chatter, no progress
			// percentages, no deploy progress, no prerequisite checklist.
			assert.doesNotMatch(out, /\/\/>/);
			assert.doesNotMatch(out, /Downloading Camunda/);
			assert.doesNotMatch(out, /Cluster is ready!/);
			assert.doesNotMatch(out, /Deploying \d+ resource/);
			assert.doesNotMatch(out, /Deployment successful/);
			assert.doesNotMatch(out, /✓ Network access/);
			// Deploy and start is the last step of the run.
			const deployAt = out.indexOf("Deploy and start the process");
			const clusterMcpAt = out.indexOf("Configure the cluster MCP server");
			assert.ok(
				deployAt > clusterMcpAt,
				"the deploy step must come after the MCP step",
			);
			// The completion instructions are a distinct block, not status lines.
			assert.match(out, /What's next/);
			assert.match(out, /Project: .*rocket-launch/);
			assert.match(
				out,
				/Guide: https:\/\/docs\.camunda\.io\/docs\/guides\/getting-started-hello-world\//,
			);
			assert.match(
				out,
				/Operate: http:\/\/localhost:8080\/operate \(demo\/demo\)/,
			);
			// The box is actionable: setup already started an instance, and
			// the box says so and names the command that shows it.
			assert.match(out, /A Rocket Launch instance is already running/);
			// Tenant and profile are pinned: a saved session tenant or a
			// remote active profile must not redirect the suggestion. Two
			// separate lines — && is a syntax error in Windows
			// PowerShell 5.1.
			assert.match(out, /See it:/);
			assert.match(out, /c8ctl use tenant "<default>"/);
			assert.match(out, /c8ctl search process-instance --profile local/);
			assert.doesNotMatch(out, /&&/);
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
			const result = await c8WithOptions(stub.options, "setup", "--yes");
			assert.strictEqual(result.status, 0, result.stderr + result.stdout);
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
			const result = await c8WithOptions(stub.options, "setup", "--yes");
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

	describe("step spinner on terminal stdout", () => {
		const BRAILLE_FRAME = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/;

		/**
		 * Run `setup --yes` with stdout simulated as a terminal — the
		 * spinner branch only runs when stdout is a TTY.
		 */
		const runOnTty = (
			stub: ReturnType<typeof stubbedExecution>,
			{
				columns,
				extraArgs = [],
			}: { columns?: number; extraArgs?: string[] } = {},
		) =>
			c8WithOptions(
				{
					...stub.options,
					nodeArgs: [...(stub.options.nodeArgs ?? []), "--import", FAKE_TTY],
					env: {
						...stub.options.env,
						C8CTL_FAKE_TTY_STDOUT: "true",
						...(columns !== undefined
							? { C8CTL_FAKE_TTY_COLUMNS: String(columns) }
							: {}),
					},
				},
				"setup",
				"--yes",
				...extraArgs,
			);

		/**
		 * Every line's final state (after its last carriage return) must
		 * be free of spinner frames: a completed step never leaves the
		 * activity indicator behind.
		 */
		const assertNoLeftoverFrames = (stdout: string) => {
			for (const line of stdout.split("\n")) {
				const finalSegment = line.split("\r").pop() ?? "";
				assert.doesNotMatch(
					finalSegment,
					BRAILLE_FRAME,
					`spinner frame left on a finished line: ${JSON.stringify(line)}`,
				);
			}
		};

		test("every step spins on its open title line, then completes it", async () => {
			const stub = stubbedExecution();
			try {
				const result = await runOnTty(stub);
				assert.strictEqual(result.status, 0, result.stderr + result.stdout);
				// The first frame lands with the step — no waiting for a tick.
				assert.ok(
					result.stdout.includes("\r  Check prerequisites ⠋"),
					"no spinner frame on the prerequisites line",
				);
				assert.ok(
					result.stdout.includes("\r  Start the local cluster ⠋"),
					"no spinner frame on the cluster line",
				);
				const out = stripVTControlCharacters(result.stdout + result.stderr);
				stepLine(out, "Check prerequisites", "SUCCESS");
				stepLine(out, "Deploy and start the process", "SUCCESS");
				assertNoLeftoverFrames(result.stdout);
			} finally {
				stub.cleanup();
			}
		});

		test("essential output closes the spinning line and erases the frame", async () => {
			const stub = stubbedExecution();
			stub.options.env.C8CTL_SETUP_STUB_CLUSTER_WARN = "1";
			try {
				const result = await runOnTty(stub);
				assert.strictEqual(result.status, 0, result.stderr + result.stdout);
				// The passthrough warning closes the title line first: the
				// rewrite erases to end of line so the frame can't linger.
				assert.ok(
					result.stdout.includes("\r  Start the local cluster\x1b[K\n"),
					"title line closed without erasing the spinner frame",
				);
				const out = stripVTControlCharacters(result.stdout + result.stderr);
				stepLine(out, "Start the local cluster", "SUCCESS");
				assert.match(out, /Could not persist the durable cluster PID record/);
				assertNoLeftoverFrames(result.stdout);
			} finally {
				stub.cleanup();
			}
		});

		test("essential mid-step output reopens the spinning title below it", async () => {
			const stub = stubbedExecution();
			try {
				const result = await runOnTty(stub);
				assert.strictEqual(result.status, 0, result.stderr + result.stdout);
				// The skills step prints one essential line per harness, then
				// downloads; the spinning title reopens below the printed
				// line and the step still completes on its own line.
				const messageAt = result.stdout.indexOf("Checking Camunda skills");
				assert.ok(messageAt !== -1, "skills install message missing");
				const reopened = result.stdout.indexOf(
					"\r  Install AI assistant skills ⠋",
					messageAt,
				);
				assert.ok(
					reopened > messageAt,
					"the title line did not reopen below the essential output",
				);
				const out = stripVTControlCharacters(result.stdout + result.stderr);
				stepLine(out, "Install AI assistant skills", "SUCCESS");
				assertNoLeftoverFrames(result.stdout);
			} finally {
				stub.cleanup();
			}
		});

		test("a failed deploy does not reopen the spinner into its stderr diagnostics", async () => {
			// deploy-helpers renders failure diagnostics straight to stderr;
			// the error passthrough must close the title for good, or a
			// reopened frame is stranded between "Deployment failed" and
			// the detail lines on a shared terminal.
			const stub = stubbedExecution({ failStep: "deploy-blueprint" });
			try {
				const result = await runOnTty(stub);
				assert.strictEqual(result.status, 1, result.stdout);
				const openings = result.stdout.match(
					/\r {2}Deploy and start the process ⠋/g,
				);
				assert.strictEqual(
					openings?.length ?? 0,
					1,
					"the deploy title reopened after the error passthrough",
				);
				const out = stripVTControlCharacters(result.stdout + result.stderr);
				stepLine(out, "Deploy and start the process", "ERROR");
				assert.match(out, /stubbed invalid deployment/);
				assertNoLeftoverFrames(result.stdout);
			} finally {
				stub.cleanup();
			}
		});

		test("a failed step stops the spinner and reports [ERROR] cleanly", async () => {
			const stub = stubbedExecution({ failStep: "start-cluster" });
			try {
				const result = await runOnTty(stub);
				assert.strictEqual(result.status, 1, result.stdout);
				const out = stripVTControlCharacters(result.stdout + result.stderr);
				stepLine(out, "Start the local cluster", "ERROR");
				assert.match(out, /stubbed cluster failure diagnostics/);
				assertNoLeftoverFrames(result.stdout);
			} finally {
				stub.cleanup();
			}
		});

		test("narrow terminals and --quiet suppress the animation", async () => {
			const narrow = stubbedExecution();
			try {
				const result = await runOnTty(narrow, { columns: 10 });
				assert.strictEqual(result.status, 0, result.stderr + result.stdout);
				assert.doesNotMatch(result.stdout, BRAILLE_FRAME);
				const out = stripVTControlCharacters(result.stdout + result.stderr);
				stepLine(out, "Check prerequisites", "SUCCESS");
			} finally {
				narrow.cleanup();
			}

			const quiet = stubbedExecution();
			try {
				const result = await runOnTty(quiet, { extraArgs: ["--quiet"] });
				assert.strictEqual(result.status, 0, result.stderr + result.stdout);
				assert.doesNotMatch(result.stdout, BRAILLE_FRAME);
				// No open title lines: quiet prints only the essential
				// completed status lines.
				assert.doesNotMatch(result.stdout, /^ {2}Check prerequisites$/m);
			} finally {
				quiet.cleanup();
			}
		});
	});

	test("--yes --docs-mcp also configures the docs MCP server", async () => {
		const stub = stubbedExecution();
		try {
			const result = await c8WithOptions(
				stub.options,
				"setup",
				"--yes",
				"--docs-mcp",
			);
			assert.strictEqual(result.status, 0, result.stderr + result.stdout);
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
		assert.strictEqual(result.status, 0, result.stderr + result.stdout);
		const payload = JSON.parse(result.stdout);
		const docsStep = payload.steps.find(
			(s: { title: string }) => s.title === "Configure the docs MCP server",
		);
		assert.strictEqual(docsStep.status, "planned");
	});

	test("--remove previews setup-owned files and requires confirmation", async () => {
		const stub = stubbedExecution();
		try {
			const installed = await c8WithOptions(
				stub.options,
				"setup",
				"--yes",
				"--docs-mcp",
			);
			assert.strictEqual(
				installed.status,
				0,
				installed.stderr + installed.stdout,
			);

			const blueprintDir = join(stub.cwd, "rocket-launch");
			const editedBlueprint = join(blueprintDir, "rocket-launch.bpmn");
			writeFileSync(editedBlueprint, "user edits\n");
			writeFileSync(join(blueprintDir, "notes.txt"), "keep this file\n");

			const mcpConfigPath = join(stub.home, ".claude", ".claude.json");
			const mcpConfig: unknown = JSON.parse(
				readFileSync(mcpConfigPath, "utf-8"),
			);
			assert.ok(isRecord(mcpConfig) && isRecord(mcpConfig.mcpServers));
			mcpConfig.mcpServers.personal = { url: "https://example.invalid/mcp" };
			writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig));

			const preview = await c8WithOptions(stub.options, "setup", "--remove");
			assert.strictEqual(preview.status, 0, preview.stderr + preview.stdout);
			assert.match(preview.stdout, /Setup removal preview/);
			assert.match(preview.stdout, /camunda.*\.claude\.json/);
			assert.match(preview.stdout, /camunda-docs/);
			assert.match(preview.stdout, /camunda-c8ctl/);
			assert.match(preview.stdout, /rocket-launch\.bpmn/);
			assert.match(preview.stdout, /local edits/i);
			assert.match(preview.stdout, /Nothing was removed/);
			assert.ok(existsSync(editedBlueprint));
			assert.ok(existsSync(join(blueprintDir, ".c8ctl-blueprint.json")));
			assert.ok(
				existsSync(join(stub.home, ".claude", "skills", "camunda-c8ctl")),
			);
			assert.ok(isRecord(mcpConfig.mcpServers.camunda));

			const removed = await c8WithOptions(
				stub.options,
				"setup",
				"--remove",
				"--yes",
			);
			assert.strictEqual(removed.status, 0, removed.stderr + removed.stdout);
			assert.match(removed.stdout, /Setup removal finished/);
			assert.ok(!existsSync(editedBlueprint));
			assert.ok(!existsSync(join(blueprintDir, ".c8ctl-blueprint.json")));
			assert.ok(existsSync(join(blueprintDir, "notes.txt")));
			assert.ok(
				!existsSync(join(stub.home, ".claude", "skills", "camunda-c8ctl")),
			);

			const remainingConfig: unknown = JSON.parse(
				readFileSync(mcpConfigPath, "utf-8"),
			);
			assert.ok(
				isRecord(remainingConfig) && isRecord(remainingConfig.mcpServers),
			);
			assert.deepStrictEqual(remainingConfig.mcpServers, {
				personal: { url: "https://example.invalid/mcp" },
			});
		} finally {
			stub.cleanup();
		}
	});

	test("skips skill discovery when no user skills directory exists", async () => {
		const stub = stubbedExecution({ failStep: "list-skills" });
		const ghCapture = join(stub.cwd, "gh-calls.jsonl");
		stub.options.env.C8CTL_SETUP_STUB_GH_CAPTURE = ghCapture;
		try {
			const removal = await c8WithOptions(
				stub.options,
				"setup",
				"--remove",
				"--yes",
			);
			assert.strictEqual(removal.status, 0, removal.stderr + removal.stdout);
			assert.ok(!existsSync(ghCapture));
		} finally {
			stub.cleanup();
		}
	});

	test("continues removing known setup artifacts when skill discovery fails", async () => {
		const stub = stubbedExecution();
		try {
			const installed = await c8WithOptions(
				stub.options,
				"setup",
				"--yes",
				"--docs-mcp",
			);
			assert.strictEqual(
				installed.status,
				0,
				installed.stderr + installed.stdout,
			);

			stub.options.env.C8CTL_SETUP_STUB_FAIL = "list-skills";
			const removal = await c8WithOptions(
				stub.options,
				"setup",
				"--remove",
				"--yes",
			);
			assert.strictEqual(removal.status, 1, removal.stderr + removal.stdout);
			assert.match(
				`${removal.stderr}\n${removal.stdout}`,
				/Could not inspect Camunda skills for claude-code/,
			);
			assert.ok(
				existsSync(join(stub.home, ".claude", "skills", "camunda-c8ctl")),
			);
			assert.ok(
				!existsSync(join(stub.cwd, "rocket-launch", "rocket-launch.bpmn")),
			);
			assert.ok(
				!existsSync(join(stub.cwd, "rocket-launch", ".c8ctl-blueprint.json")),
			);

			const remainingConfig: unknown = JSON.parse(
				readFileSync(join(stub.home, ".claude", ".claude.json"), "utf-8"),
			);
			assert.ok(
				isRecord(remainingConfig) && isRecord(remainingConfig.mcpServers),
			);
			assert.ok(!Object.hasOwn(remainingConfig.mcpServers, "camunda"));
			assert.ok(!Object.hasOwn(remainingConfig.mcpServers, "camunda-docs"));
		} finally {
			stub.cleanup();
		}
	});

	test("continues removal when MCP inspection fails for other harnesses", async () => {
		const stub = stubbedExecution();
		try {
			const installed = await c8WithOptions(stub.options, "setup", "--yes");
			assert.strictEqual(
				installed.status,
				0,
				installed.stderr + installed.stdout,
			);

			const cursorConfigPath = join(stub.home, ".cursor", "mcp.json");
			mkdirSync(join(stub.home, ".cursor"), { recursive: true });
			writeFileSync(cursorConfigPath, "{");

			const vscodeConfigPath = vscodeMcpConfigPath(stub.home);
			mkdirSync(dirname(vscodeConfigPath), { recursive: true });
			writeFileSync(vscodeConfigPath, JSON.stringify({ servers: [] }));

			const removal = await c8WithOptions(
				stub.options,
				"setup",
				"--remove",
				"--stop-cluster",
				"--yes",
			);
			const output = `${removal.stderr}\n${removal.stdout}`;
			assert.strictEqual(removal.status, 1, output);
			assert.match(output, /Could not inspect MCP configuration for cursor/);
			assert.match(output, /Could not inspect MCP configuration for vscode/);
			assert.match(output, /Stopped the local cluster/);
			assert.strictEqual(readFileSync(cursorConfigPath, "utf-8"), "{");
			assert.strictEqual(
				readFileSync(vscodeConfigPath, "utf-8"),
				JSON.stringify({ servers: [] }),
			);
			assert.ok(
				!existsSync(join(stub.home, ".claude", "skills", "camunda-c8ctl")),
			);
			assert.ok(
				!existsSync(join(stub.cwd, "rocket-launch", "rocket-launch.bpmn")),
			);

			const remainingConfig: unknown = JSON.parse(
				readFileSync(join(stub.home, ".claude", ".claude.json"), "utf-8"),
			);
			assert.ok(
				isRecord(remainingConfig) && isRecord(remainingConfig.mcpServers),
			);
			assert.ok(!Object.hasOwn(remainingConfig.mcpServers, "camunda"));
		} finally {
			stub.cleanup();
		}
	});

	test("continues cleanup when blueprint marker inspection fails", async () => {
		const stub = stubbedExecution();
		try {
			const installed = await c8WithOptions(stub.options, "setup", "--yes");
			assert.strictEqual(
				installed.status,
				0,
				installed.stderr + installed.stdout,
			);

			const malformedMarkerPath = join(stub.cwd, ".c8ctl-blueprint.json");
			writeFileSync(malformedMarkerPath, "{");
			const unreadableMarkerPath = join(
				stub.cwd,
				"service-worker",
				".c8ctl-blueprint.json",
			);
			mkdirSync(unreadableMarkerPath, { recursive: true });

			const removal = await c8WithOptions(
				stub.options,
				"setup",
				"--remove",
				"--stop-cluster",
				"--yes",
			);
			const output = `${removal.stderr}\n${removal.stdout}`;
			assert.strictEqual(removal.status, 1, output);
			assert.strictEqual(
				(
					output.match(/Warning: Could not inspect setup blueprint marker/g) ??
					[]
				).length,
				2,
				output,
			);
			assert.match(output, /Stopped the local cluster/);
			assert.match(output, /Removed MCP server "camunda"/);
			assert.match(output, /Removed Camunda skill "camunda-c8ctl"/);
			assert.strictEqual(readFileSync(malformedMarkerPath, "utf-8"), "{");
			assert.ok(statSync(unreadableMarkerPath).isDirectory());
			assert.ok(
				!existsSync(join(stub.cwd, "rocket-launch", "rocket-launch.bpmn")),
			);
			assert.ok(
				!existsSync(join(stub.cwd, "rocket-launch", ".c8ctl-blueprint.json")),
			);
			assert.ok(
				!existsSync(join(stub.home, ".claude", "skills", "camunda-c8ctl")),
			);

			const remainingConfig: unknown = JSON.parse(
				readFileSync(join(stub.home, ".claude", ".claude.json"), "utf-8"),
			);
			assert.ok(
				isRecord(remainingConfig) && isRecord(remainingConfig.mcpServers),
			);
			assert.ok(!Object.hasOwn(remainingConfig.mcpServers, "camunda"));
		} finally {
			stub.cleanup();
		}
	});

	test("reports blueprint inspection failures when no artifacts are removable", async () => {
		const stub = stubbedExecution();
		try {
			const malformedMarkerPath = join(stub.cwd, ".c8ctl-blueprint.json");
			writeFileSync(malformedMarkerPath, "{");

			const removal = await c8WithOptions(
				stub.options,
				"setup",
				"--remove",
				"--yes",
			);
			const output = `${removal.stderr}\n${removal.stdout}`;
			assert.strictEqual(removal.status, 1, output);
			assert.match(output, /Warning: Could not inspect setup blueprint marker/);
			assert.match(output, /No setup-managed components were found/);
			assert.strictEqual(readFileSync(malformedMarkerPath, "utf-8"), "{");
		} finally {
			stub.cleanup();
		}
	});

	test("preserves foreign MCP entries while removing setup-owned artifacts", async () => {
		const stub = stubbedExecution();
		try {
			const installed = await c8WithOptions(
				stub.options,
				"setup",
				"--yes",
				"--docs-mcp",
			);
			assert.strictEqual(
				installed.status,
				0,
				installed.stderr + installed.stdout,
			);

			const mcpConfigPath = join(stub.home, ".claude", ".claude.json");
			const mcpConfig: unknown = JSON.parse(
				readFileSync(mcpConfigPath, "utf-8"),
			);
			assert.ok(isRecord(mcpConfig) && isRecord(mcpConfig.mcpServers));
			const foreignDocs = {
				type: "http",
				url: "https://example.invalid/mcp",
			};
			mcpConfig.mcpServers["camunda-docs"] = foreignDocs;
			writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig));

			const removal = await c8WithOptions(
				stub.options,
				"setup",
				"--remove",
				"--yes",
			);
			assert.strictEqual(removal.status, 0, removal.stderr + removal.stdout);
			assert.match(
				removal.stdout,
				/Preserved foreign MCP server "camunda-docs"/,
			);
			assert.ok(
				!existsSync(join(stub.cwd, "rocket-launch", "rocket-launch.bpmn")),
			);
			assert.ok(
				!existsSync(join(stub.home, ".claude", "skills", "camunda-c8ctl")),
			);

			const remainingConfig: unknown = JSON.parse(
				readFileSync(mcpConfigPath, "utf-8"),
			);
			assert.ok(
				isRecord(remainingConfig) && isRecord(remainingConfig.mcpServers),
			);
			assert.ok(!Object.hasOwn(remainingConfig.mcpServers, "camunda"));
			assert.deepStrictEqual(
				remainingConfig.mcpServers["camunda-docs"],
				foreignDocs,
			);
		} finally {
			stub.cleanup();
		}
	});

	test("coalesces removals when harness configs share a target", async () => {
		const stub = stubbedExecution();
		try {
			const installed = await c8WithOptions(
				stub.options,
				"setup",
				"--yes",
				"--docs-mcp",
			);
			assert.strictEqual(
				installed.status,
				0,
				installed.stderr + installed.stdout,
			);

			const claudeConfigPath = join(stub.home, ".claude", ".claude.json");
			const claudeConfig: unknown = JSON.parse(
				readFileSync(claudeConfigPath, "utf-8"),
			);
			assert.ok(isRecord(claudeConfig) && isRecord(claudeConfig.mcpServers));
			claudeConfig.mcpServers.personal = {
				url: "https://personal.example.invalid/mcp",
			};
			claudeConfig.servers = {
				camunda: {
					command: process.execPath,
					args: ["index.ts", "mcp-proxy", "--profile", "local"],
					env: { C8CTL_DATA_DIR: join(stub.home, "data") },
				},
				"camunda-docs": {
					type: "http",
					url: "https://camunda-docs.mcp.kapa.ai",
				},
				personal: { url: "https://other.example.invalid/mcp" },
			};
			writeFileSync(claudeConfigPath, JSON.stringify(claudeConfig));

			const vscodeConfigPath = vscodeMcpConfigPath(stub.home);
			mkdirSync(dirname(vscodeConfigPath), { recursive: true });
			symlinkSync(claudeConfigPath, vscodeConfigPath, "file");

			const removal = await c8WithOptions(
				stub.options,
				"setup",
				"--remove",
				"--yes",
			);
			assert.strictEqual(removal.status, 0, removal.stderr + removal.stdout);

			const remainingConfig: unknown = JSON.parse(
				readFileSync(claudeConfigPath, "utf-8"),
			);
			assert.ok(
				isRecord(remainingConfig) &&
					isRecord(remainingConfig.mcpServers) &&
					isRecord(remainingConfig.servers),
			);
			assert.deepStrictEqual(remainingConfig.mcpServers, {
				personal: { url: "https://personal.example.invalid/mcp" },
			});
			assert.deepStrictEqual(remainingConfig.servers, {
				personal: { url: "https://other.example.invalid/mcp" },
			});
		} finally {
			stub.cleanup();
		}
	});

	test("removal JSON and dry-run only preview, and cluster stop requires removal", async () => {
		const stub = stubbedExecution();
		try {
			const installed = await c8WithOptions(stub.options, "setup", "--yes");
			assert.strictEqual(
				installed.status,
				0,
				installed.stderr + installed.stdout,
			);

			const blueprintFile = join(
				stub.cwd,
				"rocket-launch",
				"rocket-launch.bpmn",
			);
			const skillDirectory = join(
				stub.home,
				".claude",
				"skills",
				"camunda-c8ctl",
			);
			const jsonPreview = await c8WithOptions(
				stub.options,
				"setup",
				"--remove",
				"--stop-cluster",
				"--json",
			);
			assert.strictEqual(jsonPreview.status, 0, jsonPreview.stderr);
			const jsonPayload: unknown = JSON.parse(jsonPreview.stdout);
			assert.ok(isRecord(jsonPayload) && Array.isArray(jsonPayload.items));
			assert.strictEqual(jsonPayload.preview, true);
			assert.ok(
				jsonPayload.items.some(
					(item: unknown) => isRecord(item) && item.type === "local-cluster",
				),
			);
			assert.ok(existsSync(blueprintFile));
			assert.ok(existsSync(skillDirectory));

			const dryRun = await c8WithOptions(
				stub.options,
				"setup",
				"--remove",
				"--dry-run",
			);
			assert.strictEqual(dryRun.status, 0, dryRun.stderr);
			const dryRunPayload: unknown = JSON.parse(dryRun.stdout);
			assert.ok(isRecord(dryRunPayload));
			assert.strictEqual(dryRunPayload.dryRun, true);
			assert.strictEqual(dryRunPayload.preview, true);
			assert.ok(existsSync(blueprintFile));
			assert.ok(existsSync(skillDirectory));

			const stopPreview = await c8WithOptions(
				stub.options,
				"setup",
				"--remove",
				"--stop-cluster",
			);
			assert.strictEqual(
				stopPreview.status,
				0,
				stopPreview.stderr + stopPreview.stdout,
			);
			assert.match(
				stopPreview.stdout,
				/Run "c8ctl setup --remove --stop-cluster --yes" to confirm/,
			);
			assert.ok(existsSync(blueprintFile));
			assert.ok(existsSync(skillDirectory));

			const invalid = await c8WithOptions(
				stub.options,
				"setup",
				"--stop-cluster",
			);
			assert.strictEqual(invalid.status, 1);
			assert.match(
				invalid.stderr,
				/--stop-cluster can only be used with --remove/,
			);

			const removed = await c8WithOptions(
				stub.options,
				"setup",
				"--remove",
				"--stop-cluster",
				"--yes",
			);
			assert.strictEqual(removed.status, 0, removed.stderr + removed.stdout);
			assert.match(removed.stdout, /Stopped local Camunda 8 cluster/);
			assert.match(removed.stdout, /runtime data were kept/);
			assert.ok(!existsSync(blueprintFile));
			assert.ok(!existsSync(skillDirectory));
		} finally {
			stub.cleanup();
		}
	});

	test("interactive removal asks before changing setup artifacts", async () => {
		const stub = stubbedExecution();
		try {
			const installed = await c8WithOptions(stub.options, "setup", "--yes");
			assert.strictEqual(
				installed.status,
				0,
				installed.stderr + installed.stdout,
			);

			const blueprintFile = join(
				stub.cwd,
				"rocket-launch",
				"rocket-launch.bpmn",
			);
			const cancelled = await runInteractive(
				[
					{
						waitFor: "Remove the listed setup components?",
						keys: "\x1b",
					},
				],
				{
					args: ["--remove"],
					nodeArgs: stub.options.nodeArgs,
					env: stub.options.env,
					cwd: stub.cwd,
				},
			);
			assert.strictEqual(
				cancelled.status,
				0,
				cancelled.stderr + cancelled.stdout,
			);
			assert.match(cancelled.stdout, /Cancelled — nothing was removed/);
			assert.ok(existsSync(blueprintFile));

			const confirmed = await runInteractive(
				[
					{
						waitFor: "Remove the listed setup components?",
						keys: "\x1b[B\r",
					},
				],
				{
					args: ["--remove"],
					nodeArgs: stub.options.nodeArgs,
					env: stub.options.env,
					cwd: stub.cwd,
				},
			);
			assert.strictEqual(
				confirmed.status,
				0,
				confirmed.stderr + confirmed.stdout,
			);
			assert.match(confirmed.stdout, /Setup removal finished/);
			assert.ok(!existsSync(blueprintFile));
		} finally {
			stub.cleanup();
		}
	});

	test("keeps the empty blueprint directory when removal runs from that directory", async () => {
		const stub = stubbedExecution();
		try {
			const installed = await c8WithOptions(stub.options, "setup", "--yes");
			assert.strictEqual(
				installed.status,
				0,
				installed.stderr + installed.stdout,
			);

			const blueprintDirectory = join(stub.cwd, "rocket-launch");
			const removed = await c8WithOptions(
				{ ...stub.options, cwd: blueprintDirectory },
				"setup",
				"--remove",
				"--yes",
			);
			assert.strictEqual(removed.status, 0, removed.stderr + removed.stdout);
			assert.ok(existsSync(blueprintDirectory));
			assert.deepStrictEqual(readdirSync(blueprintDirectory), []);
			assert.match(
				removed.stdout,
				/because it is the current working directory/,
			);
		} finally {
			stub.cleanup();
		}
	});

	test("fails on marker-listed directories while continuing other cleanup", async () => {
		const stub = stubbedExecution();
		try {
			const installed = await c8WithOptions(stub.options, "setup", "--yes");
			assert.strictEqual(
				installed.status,
				0,
				installed.stderr + installed.stdout,
			);

			const blueprintFile = join(
				stub.cwd,
				"rocket-launch",
				"rocket-launch.bpmn",
			);
			rmSync(blueprintFile);
			mkdirSync(blueprintFile);

			const removal = await c8WithOptions(
				stub.options,
				"setup",
				"--remove",
				"--yes",
			);
			assert.strictEqual(removal.status, 1, removal.stderr + removal.stdout);
			assert.match(
				`${removal.stderr}\n${removal.stdout}`,
				/Could not remove the .* blueprint/,
			);
			assert.ok(existsSync(blueprintFile));
			assert.ok(
				existsSync(join(stub.cwd, "rocket-launch", ".c8ctl-blueprint.json")),
			);
			assert.ok(
				!existsSync(join(stub.home, ".claude", "skills", "camunda-c8ctl")),
			);
		} finally {
			stub.cleanup();
		}
	});

	test("does not prune directories reached through symlink ancestors", async () => {
		const stub = stubbedExecution();
		try {
			const installed = await c8WithOptions(stub.options, "setup", "--yes");
			assert.strictEqual(
				installed.status,
				0,
				installed.stderr + installed.stdout,
			);

			const blueprintDirectory = join(stub.cwd, "rocket-launch");
			const outsideDirectory = join(stub.cwd, "outside");
			const nestedDirectory = join(outsideDirectory, "nested");
			mkdirSync(nestedDirectory, { recursive: true });
			const markerPath = join(blueprintDirectory, ".c8ctl-blueprint.json");
			const marker: unknown = JSON.parse(readFileSync(markerPath, "utf-8"));
			assert.ok(isRecord(marker) && Array.isArray(marker.files));
			assert.ok(typeof marker.id === "string");
			const files = marker.files.filter(
				(file: unknown): file is string => typeof file === "string",
			);
			files.push("linked/nested/file.txt");
			writeFileSync(markerPath, JSON.stringify({ id: marker.id, files }));
			symlinkSync(
				outsideDirectory,
				join(blueprintDirectory, "linked"),
				process.platform === "win32" ? "junction" : "dir",
			);

			const removal = await c8WithOptions(
				stub.options,
				"setup",
				"--remove",
				"--yes",
			);
			assert.strictEqual(removal.status, 1, removal.stderr + removal.stdout);
			assert.match(
				`${removal.stderr}\n${removal.stdout}`,
				/Could not remove the .* blueprint/,
			);
			assert.ok(existsSync(nestedDirectory));
			assert.ok(existsSync(join(blueprintDirectory, "linked")));
			assert.ok(existsSync(markerPath));
			assert.ok(
				!existsSync(join(stub.home, ".claude", "skills", "camunda-c8ctl")),
			);
		} finally {
			stub.cleanup();
		}
	});

	test("preserves an out-of-scope skill while removing other setup artifacts", async () => {
		const stub = stubbedExecution();
		try {
			const installed = await c8WithOptions(stub.options, "setup", "--yes");
			assert.strictEqual(
				installed.status,
				0,
				installed.stderr + installed.stdout,
			);

			const outsideSkill = join(stub.cwd, "outside", "camunda-c8ctl");
			mkdirSync(outsideSkill, { recursive: true });
			const outsideFile = join(outsideSkill, "SKILL.md");
			writeFileSync(outsideFile, "preserve this file\n");
			stub.options.env.C8CTL_SETUP_STUB_SKILL_PATH = outsideSkill;

			const removal = await c8WithOptions(
				stub.options,
				"setup",
				"--remove",
				"--yes",
			);
			assert.strictEqual(removal.status, 1);
			assert.match(
				removal.stderr,
				/outside the claude-code user skills directory/,
			);
			assert.ok(existsSync(outsideFile));
			assert.ok(
				existsSync(join(stub.home, ".claude", "skills", "camunda-c8ctl")),
			);
			assert.ok(
				!existsSync(join(stub.cwd, "rocket-launch", "rocket-launch.bpmn")),
			);
			assert.ok(
				!existsSync(join(stub.cwd, "rocket-launch", ".c8ctl-blueprint.json")),
			);
		} finally {
			stub.cleanup();
		}
	});

	test("removal rejects blueprint markers that escape the project directory", async () => {
		const stub = stubbedExecution();
		try {
			const installed = await c8WithOptions(stub.options, "setup", "--yes");
			assert.strictEqual(
				installed.status,
				0,
				installed.stderr + installed.stdout,
			);

			const blueprintDirectory = join(stub.cwd, "rocket-launch");
			const outsideFile = join(stub.cwd, "keep.txt");
			writeFileSync(outsideFile, "preserve this file\n");
			writeFileSync(
				join(blueprintDirectory, ".c8ctl-blueprint.json"),
				JSON.stringify({
					id: "rocket-launch",
					files: ["../keep.txt"],
				}),
			);

			const removal = await c8WithOptions(
				stub.options,
				"setup",
				"--remove",
				"--yes",
			);
			const output = `${removal.stderr}\n${removal.stdout}`;
			assert.strictEqual(removal.status, 1, output);
			assert.match(output, /Could not inspect setup blueprint marker/);
			assert.match(output, /file list is invalid/);
			assert.ok(existsSync(outsideFile));
			assert.ok(existsSync(join(blueprintDirectory, "rocket-launch.bpmn")));
			assert.ok(existsSync(join(blueprintDirectory, ".c8ctl-blueprint.json")));
			assert.ok(
				!existsSync(join(stub.home, ".claude", "skills", "camunda-c8ctl")),
			);

			const remainingConfig: unknown = JSON.parse(
				readFileSync(join(stub.home, ".claude", ".claude.json"), "utf-8"),
			);
			assert.ok(
				isRecord(remainingConfig) && isRecord(remainingConfig.mcpServers),
			);
			assert.ok(!Object.hasOwn(remainingConfig.mcpServers, "camunda"));
		} finally {
			stub.cleanup();
		}
	});

	test("a rerun reuses the existing blueprint project instead of failing", async () => {
		const stub = stubbedExecution();
		const ghCapture = join(stub.cwd, "gh-calls.jsonl");
		stub.options.env.C8CTL_SETUP_STUB_GH_CAPTURE = ghCapture;
		try {
			const first = await c8WithOptions(stub.options, "setup", "--yes");
			assert.strictEqual(first.status, 0, first.stderr);
			assert.ok(
				existsSync(join(stub.cwd, "rocket-launch", "rocket-launch.bpmn")),
			);
			const mcpConfigPath = join(stub.home, ".claude", ".claude.json");
			const mcpConfig = readFileSync(mcpConfigPath, "utf-8");
			utimesSync(mcpConfigPath, 1, 1);

			const second = await c8WithOptions(stub.options, "setup", "--yes");
			assert.strictEqual(second.status, 0, second.stderr);
			const out = stripVTControlCharacters(second.stdout + second.stderr);
			stepLine(out, "Create the blueprint project", "SUCCESS");
			assert.match(out, /already set up/);
			assert.strictEqual(readFileSync(mcpConfigPath, "utf-8"), mcpConfig);
			assert.strictEqual(statSync(mcpConfigPath).mtimeMs, 1000);
			const ghCalls = readFileSync(ghCapture, "utf-8")
				.trim()
				.split("\n")
				.map((line) => {
					const parsed: unknown = JSON.parse(line);
					assert.ok(Array.isArray(parsed));
					return parsed.map(String);
				});
			assert.deepStrictEqual(
				ghCalls.map((args) => args.slice(0, 4)),
				[
					["skill", "list", "--agent", "claude-code"],
					["skill", "install", "camunda/skills", "--all"],
					["skill", "list", "--agent", "claude-code"],
					["skill", "install", "camunda/skills"],
					["skill", "update", "--all", "--dir"],
				],
			);
			// No suffixed copies, ever.
			assert.ok(!existsSync(join(stub.cwd, "rocket-launch-1")));
			assert.ok(!existsSync(join(stub.cwd, "rocket-launch-2")));
		} finally {
			stub.cleanup();
		}
	});

	test("a rerun updates a drifted cluster MCP entry and still deploys", async () => {
		const stub = stubbedExecution();
		try {
			const first = await c8WithOptions(stub.options, "setup", "--yes");
			assert.strictEqual(first.status, 0, first.stderr);

			// Drift the entry the way a moved install does — setup wrote it
			// from a different c8ctl location — and re-run.
			const mcpConfigPath = join(stub.home, ".claude", ".claude.json");
			const drifted: unknown = JSON.parse(readFileSync(mcpConfigPath, "utf-8"));
			assert.ok(isRecord(drifted) && isRecord(drifted.mcpServers));
			const camunda = drifted.mcpServers.camunda;
			assert.ok(isRecord(camunda) && Array.isArray(camunda.args));
			camunda.args[0] =
				"/usr/local/lib/node_modules/@camunda8/cli/dist/index.js";
			writeFileSync(mcpConfigPath, JSON.stringify(drifted));

			const second = await c8WithOptions(stub.options, "setup", "--yes");
			assert.strictEqual(second.status, 0, second.stderr);
			const out = stripVTControlCharacters(second.stdout + second.stderr);
			stepLine(out, "Configure the cluster MCP server", "SUCCESS");
			stepLine(out, "Deploy and start the process", "SUCCESS");
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
			const result = await c8WithOptions(stub.options, "setup", "--yes");
			assert.strictEqual(result.status, 1, result.stdout);
			const out = stripVTControlCharacters(result.stdout + result.stderr);
			stepLine(out, "Create the blueprint project", "ERROR");
			assert.match(out, /already exists and is not empty/);
			// The scaffold error's recovery hint is rendered, not swallowed.
			assert.match(out, /Choose an empty or new destination directory/);
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
			const result = await c8WithOptions(stub.options, "setup", "--yes");
			assert.strictEqual(result.status, 1, result.stdout);
			const out = stripVTControlCharacters(result.stdout + result.stderr);
			stepLine(out, "Deploy and start the process", "ERROR");
			// The deploy helper renders through the step's logger, so its
			// diagnostics close the title line instead of colliding with it.
			assert.match(out, /^ {2}Deploy and start the process$/m);
			assert.match(out, /✗ Deployment failed/);
			// SilentError: the helper rendered the failure — no summary reprint.
			assert.doesNotMatch(out, /^ {4}INVALID_ARGUMENT$/m);
			// No instance was started, so the box must not claim one is
			// running — only the Project/Guide references remain.
			assert.doesNotMatch(out, /already running/);
			assert.match(out, /Project: .*rocket-launch/);
		} finally {
			stub.cleanup();
		}
	});

	test("a failed skills install skips the deploy finale but not the independent MCP step", async () => {
		const capture = join(
			mkdtempSync(join(tmpdir(), "c8ctl-setup-capture-")),
			"capture.json",
		);
		const stub = stubbedExecution({ failStep: "install-skills", capture });
		try {
			const result = await c8WithOptions(stub.options, "setup", "--yes");
			assert.strictEqual(result.status, 1, result.stdout);
			const out = stripVTControlCharacters(result.stdout + result.stderr);
			stepLine(out, "Install AI assistant skills", "ERROR");
			assert.match(out, /GitHub CLI failed to install Camunda skills/);
			// The independent MCP step still runs…
			stepLine(out, "Configure the cluster MCP server", "SUCCESS");
			// …but the finale only runs on a clean setup.
			stepLine(out, "Deploy and start the process", "SKIPPED");
			assert.match(out, /needs: all previous steps to succeed/);
			assert.ok(
				!existsSync(capture),
				"an instance was started despite the failed step",
			);
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
			assert.strictEqual(result.status, 0, result.stderr + result.stdout);
			assert.ok(result.stderr.includes(PROMPT_TEXT), "prompt not rendered");
			assert.ok(
				!result.stderr.includes(BLUEPRINT_PROMPT_TEXT),
				"blueprint prompt should not render when the cluster is off",
			);
			assert.match(
				stripVTControlCharacters(result.stderr),
				/Starter blueprint.*— needs the local cluster/,
			);
			// The cluster MCP server depends on the cluster the same way.
			assert.match(
				stripVTControlCharacters(result.stderr),
				/Cluster MCP server.*— needs the local cluster/,
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
			assert.doesNotMatch(out, /^ {2}Start the local cluster/m);
			assert.doesNotMatch(out, /Create the blueprint project/);
			assert.doesNotMatch(out, /Configure the cluster MCP server/);
			stepLine(out, "Install Desktop Modeler", "SUCCESS");
			stepLine(out, "Install AI assistant skills", "SUCCESS");
			// No blueprint project without the cluster.
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
			assert.strictEqual(result.status, 0, result.stderr + result.stdout);
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
		assert.strictEqual(result.status, 0, result.stderr + result.stdout);
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
		assert.strictEqual(result.status, 0, result.stderr + result.stdout);
		assert.match(result.stdout, /Cancelled — nothing was changed\./);
		assert.doesNotMatch(result.stdout, /Check prerequisites/);
	});

	test("interactive: Escape at the blueprint choice cancels too", async () => {
		const result = await runInteractive([
			{ waitFor: "Docs MCP server", keys: "\r" },
			{ waitFor: BLUEPRINT_PROMPT_TEXT, keys: "\x1b" },
		]);
		assert.strictEqual(result.status, 0, result.stderr + result.stdout);
		assert.match(result.stdout, /Cancelled — nothing was changed\./);
		assert.doesNotMatch(result.stdout, /Setup finished\./);
	});

	test("interactive: the service worker blueprint ends with worker instructions", async () => {
		const stub = stubbedExecution();
		try {
			const result = await runInteractive(
				[
					{ waitFor: "Docs MCP server", keys: "\r" },
					// Down past "Rocket Launch" to "Service worker", then Enter.
					{ waitFor: BLUEPRINT_PROMPT_TEXT, keys: "\x1b[B\r" },
				],
				{
					nodeArgs: stub.options.nodeArgs,
					env: stub.options.env,
					cwd: stub.cwd,
				},
			);
			assert.strictEqual(result.status, 0, result.stderr + result.stdout);
			const out = stripVTControlCharacters(result.stdout + result.stderr);
			stepLine(out, "Create the blueprint project", "SUCCESS");
			stepLine(out, "Deploy and start the process", "SUCCESS");
			assert.ok(
				existsSync(
					join(stub.cwd, "service-worker", "bpmn", "order-process.bpmn"),
				),
				"service-worker blueprint was not scaffolded",
			);
			// The instance stalls at its service task until a worker connects —
			// the closing box must say so and hand over the commands.
			assert.match(out, /The order process waits for a worker/);
			// Quoted, so a working directory with spaces stays usable;
			// either path separator, so the Windows matrix sees its own.
			assert.match(out, /cd ".*service-worker[/\\]nodejs"/);
			// Separate lines: && is a syntax error in Windows
			// PowerShell 5.1.
			assert.match(out, /npm install/);
			assert.match(out, /npm start/);
			assert.doesNotMatch(out, /npm install && npm start/);
			assert.match(
				out,
				/Operate: http:\/\/localhost:8080\/operate \(demo\/demo\)/,
			);
		} finally {
			stub.cleanup();
		}
	});

	test("interactive: without a blueprint the box suggests the first run", async () => {
		const stub = stubbedExecution();
		try {
			const result = await runInteractive(
				// Down, down to "Starter blueprint", space to deselect, Enter.
				[{ waitFor: "Docs MCP server", keys: "\x1b[B\x1b[B \r" }],
				{
					nodeArgs: stub.options.nodeArgs,
					env: stub.options.env,
					cwd: stub.cwd,
				},
			);
			assert.strictEqual(result.status, 0, result.stderr + result.stdout);
			assert.ok(
				!result.stderr.includes(BLUEPRINT_PROMPT_TEXT),
				"blueprint prompt should not render when the blueprint is off",
			);
			const out = stripVTControlCharacters(result.stdout + result.stderr);
			stepLine(out, "Start the local cluster", "SUCCESS");
			assert.doesNotMatch(out, /Create the blueprint project/);
			// No blueprint, but the cluster runs: point at the first process
			// run instead of leaving the user at a bare Operate link.
			assert.match(out, /Run your first process:/);
			assert.match(out, /c8ctl use tenant "<default>"/);
			assert.match(out, /c8ctl run my-process\.bpmn --profile local/);
			assert.doesNotMatch(out, /&&/);
			assert.match(out, /re-run "c8ctl setup" and pick a starter blueprint/);
			assert.match(
				out,
				/Operate: http:\/\/localhost:8080\/operate \(demo\/demo\)/,
			);
		} finally {
			stub.cleanup();
		}
	});
});
