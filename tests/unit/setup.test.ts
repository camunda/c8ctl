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
	closeSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
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
	/** Runs after the marker renders, before the keys are sent. */
	beforeKeys?: () => void;
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
			stages[stageIndex].beforeKeys?.();
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
 *   macOS/Windows detection is patched in the stub, which the `c8ctl
 *   modeler install` child loads as well)
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
	c8runCache: string;
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
	const c8runCache = join(cwd, "c8run-cache");
	mkdirSync(join(home, ".claude"), { recursive: true });
	mkdirSync(bin);
	const fakeModeler = join(bin, "camunda-modeler");
	writeFileSync(fakeModeler, "#!/bin/sh\n");
	chmodSync(fakeModeler, 0o755);
	return {
		cwd,
		home,
		c8runCache,
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
				// Pin the c8run cache into the fixture, or the removal
				// inventory would scan (and the faked children would delete)
				// a developer's real Camunda 8 Run installation.
				C8RUN_CACHE_DIR: c8runCache,
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

/**
 * Plant a fake Camunda 8 Run install the removal inventory detects: the
 * binary the install check looks for plus runtime data next to it
 * (camunda-data and the camunda-zeebe journal), mirroring the real layout
 * the cluster plugin's purge deletes.
 */
function plantC8RunInstall(cache: string, ...versions: string[]): void {
	const binary = process.platform === "win32" ? "c8run.exe" : "c8run";
	for (const version of versions) {
		const installDir = join(cache, `c8run-${version}`);
		mkdirSync(join(installDir, "camunda-data"), { recursive: true });
		writeFileSync(join(installDir, binary), "");
		writeFileSync(join(installDir, "camunda-data", "state.json"), "{}");
		mkdirSync(join(installDir, `camunda-zeebe-${version}`, "data"), {
			recursive: true,
		});
		writeFileSync(
			join(installDir, `camunda-zeebe-${version}`, "data", "raft.json"),
			"{}",
		);
	}
}

/**
 * Spawn `c8ctl` with both streams sharing one file descriptor so their
 * write order is preserved in the captured output.
 */
function runWithOrderedOutput(
	options: { cwd: string; nodeArgs: string[]; env: Record<string, string> },
	...args: string[]
): Promise<{ status: number | null; output: string }> {
	const forwardedDataDir = process.env.C8CTL_DATA_DIR;
	return new Promise((resolveRun, rejectRun) => {
		const tempDir = mkdtempSync(join(tmpdir(), "c8ctl-setup-test-"));
		const outputPath = join(tempDir, "ordered-output.txt");
		let outputFd: number;
		try {
			outputFd = openSync(outputPath, "w");
		} catch (error) {
			rmSync(tempDir, { recursive: true, force: true });
			rejectRun(error);
			return;
		}
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(
				process.execPath,
				["--experimental-strip-types", ...options.nodeArgs, CLI, ...args],
				{
					stdio: ["ignore", outputFd, outputFd],
					cwd: options.cwd,
					env: {
						PATH: process.env.PATH,
						HOME: "/tmp/c8ctl-test-nonexistent-home",
						C8CTL_DATA_DIR: forwardedDataDir ?? tempDir,
						...options.env,
					},
				},
			);
		} catch (error) {
			try {
				closeSync(outputFd);
			} finally {
				rmSync(tempDir, { recursive: true, force: true });
			}
			rejectRun(error);
			return;
		}
		let spawnError: Error | undefined;
		// Safety net only: a stuck child must not hang the test runner.
		const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
		child.once("error", (error) => {
			spawnError = error;
		});
		child.once("close", (status) => {
			clearTimeout(timer);
			try {
				closeSync(outputFd);
				const output = readFileSync(outputPath, "utf-8");
				if (spawnError) {
					rejectRun(spawnError);
				} else {
					resolveRun({ status, output });
				}
			} catch (error) {
				rejectRun(error);
			} finally {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});
	});
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
		assert.strictEqual(docsMcp.group, "AI-assisted development");
		const cluster = payload.components.find(
			(c: { id: string }) => c.id === "cluster",
		);
		assert.strictEqual(cluster.group, "Essentials");
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
		assert.match(result.stdout, /Welcome to Camunda 8/);
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
		// setup is a default plugin: the host renders the plugin help shape.
		assert.match(result.stdout, /c8ctl setup — Guided first-run setup/);
		assert.match(result.stdout, /\(plugin: c8ctl-plugin-setup /);
		assert.match(result.stdout, /Nothing is installed without your say\./);
		assert.match(result.stdout, /\[SUCCESS\]/);
		assert.match(result.stdout, /--no-modeler/);
		assert.match(result.stdout, /--remove/);
		// The stop-only opt-in is retired: --remove tears the cluster down.
		assert.doesNotMatch(result.stdout, /--stop-cluster/);
		assert.match(result.stdout, /runtime data and downloaded binaries/);
		// Removal delegates to the owning commands; Modeler is now included.
		assert.match(
			result.stdout,
			/mcp uninstall, skills uninstall, and modeler uninstall/,
		);
		assert.doesNotMatch(result.stdout, /Desktop Modeler is not removed/);
		// The documented exit-code contract.
		assert.match(result.stdout, /Exit code 0/);
		assert.match(result.stdout, /Exit code 1: arguments failed validation/);
		assert.match(result.stdout, /Setup always uses the Rocket Launch example/);
		// The setup blueprint has no standalone CLI flag.
		assert.doesNotMatch(result.stdout, /--blueprint/);
	});

	test("top-level help lists setup with its example", async () => {
		const result = await c8WithOptions(
			{ env: { C8CTL_OUTPUT_MODE: "text" } },
			"--help",
		);
		assert.strictEqual(result.status, 0, result.stderr + result.stdout);
		// setup moved to a default plugin: it is listed under Plugin
		// Commands, and its examples are aggregated into the Examples section.
		assert.match(
			result.stdout,
			/Plugin Commands:[\s\S]*setup\s+Guided first-run setup for local Camunda 8 development/,
		);
		assert.match(result.stdout, /c8ctl setup --yes/);
		assert.match(result.stdout, /c8ctl setup --remove/);
	});

	test("completion lists the setup verb", async () => {
		const result = await c8("completion", "bash");
		assert.strictEqual(result.status, 0, result.stderr + result.stdout);
		assert.match(result.stdout, /setup/);
		assert.match(result.stdout, /--remove/);
		assert.doesNotMatch(result.stdout, /--stop-cluster/);
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
			// A successful child's stderr warnings stay actionable — the
			// deploy child's failed version check warns even on success.
			assert.match(out, /Could not reach the server to check its version/);
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
			// the box deeplinks it in Operate (naming the local credentials)
			// and gives the CLI commands that inspect it and start another.
			assert.match(out, /Process instance is running on the local cluster\./);
			assert.match(
				out,
				/Watch it:\s+http:\/\/localhost:8080\/operate\/processes\/2251799813686751/,
			);
			assert.match(out, /\(login using demo \/ demo as username \/ password\)/);
			// The profile and tenant are pinned: the session or environment
			// may otherwise select a remote cluster or tenant.
			assert.match(
				out,
				/Inspect it:\s+c8ctl get process-instance 2251799813686751 --profile local/,
			);
			assert.match(out, /Use tenant:\s+c8ctl use tenant "<default>"/);
			assert.ok(
				out.indexOf('Use tenant: c8ctl use tenant "<default>"') <
					out.indexOf("Run again:"),
				"the tenant must be pinned before the follow-up run command",
			);
			// The run path is quoted — the working directory may contain
			// spaces — and the rerun carries the same start variables
			// setup used, so the mission decision cannot incident.
			assert.match(
				out,
				/Run again:\s+c8ctl run ".*rocket-launch[/\\]rocket-launch\.bpmn" --profile local --variables '\{"missionName":"Apollo","fuelLevel":80\}'/,
			);
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

	test("failed-deploy recovery hints pin the default tenant over session state", async () => {
		const stub = stubbedExecution();
		stub.options.env.C8CTL_DATA_DIR = join(stub.home, "data");
		stub.options.env.C8CTL_SETUP_STUB_CLUSTER_DIES_BEFORE_DEPLOY = "1";
		try {
			const tenant = await c8WithOptions(
				stub.options,
				"use",
				"tenant",
				"remote-tenant",
			);
			assert.strictEqual(tenant.status, 0, tenant.stderr + tenant.stdout);

			const result = await c8WithOptions(stub.options, "setup", "--yes");
			const output = stripVTControlCharacters(result.stdout + result.stderr);
			assert.strictEqual(result.status, 1, output);
			assert.match(output, /Could not reach the local cluster/);
			const tenantPinAt = output.indexOf(
				'Use tenant: c8ctl use tenant "<default>"',
			);
			const deployHintAt = output.indexOf(
				"Then deploy the project with: c8ctl deploy",
			);
			assert.ok(tenantPinAt >= 0, output);
			assert.ok(deployHintAt > tenantPinAt, output);
			assert.doesNotMatch(output, /&&/);
		} finally {
			stub.cleanup();
		}
	});

	test("the deploy child keeps a customized local profile but pins its tenant", async () => {
		// A saved local profile with custom credentials and a remote tenant:
		// the deployment must keep the connection settings (the in-process
		// process start reads the same profile) while the tenant stays
		// pinned to the fresh cluster's <default>.
		const stub = stubbedExecution();
		const deployCapture = join(stub.cwd, "deploy-capture.json");
		stub.options.env.C8CTL_SETUP_STUB_DEPLOY_CAPTURE = deployCapture;
		const dataDir = mkdtempSync(join(tmpdir(), "c8ctl-setup-profile-"));
		writeFileSync(
			join(dataDir, "profiles.json"),
			JSON.stringify({
				profiles: [
					{
						name: "local",
						baseUrl: "http://localhost:8080/v2",
						username: "marker-user",
						password: "marker-pass",
						defaultTenantId: "remote-tenant",
					},
				],
			}),
		);
		stub.options.env.C8CTL_DATA_DIR = dataDir;
		try {
			const result = await c8WithOptions(stub.options, "setup", "--yes");
			assert.strictEqual(result.status, 0, result.stderr + result.stdout);
			const captured: unknown = JSON.parse(
				readFileSync(deployCapture, "utf-8"),
			);
			assert.ok(isRecord(captured), "deploy capture is not an object");
			assert.strictEqual(
				captured.authorization,
				`Basic ${Buffer.from("marker-user:marker-pass").toString("base64")}`,
				"the deploy child did not use the saved local profile",
			);
			assert.ok(
				typeof captured.body === "string" &&
					captured.body.includes('"tenantId"\r\n\r\n<default>'),
				"the deploy child's tenant was not pinned to <default>",
			);
		} finally {
			stub.cleanup();
			rmSync(dataDir, { recursive: true, force: true });
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

	for (const quiet of [false, true]) {
		test(`a Modeler update warning prints as it happens, not replayed under the step${quiet ? " with --quiet" : ""}`, async () => {
			const stub = stubbedExecution();
			stub.options.env.C8CTL_SETUP_STUB_MODELER_WARN = "1";
			try {
				const result = await c8WithOptions(
					stub.options,
					"setup",
					"--yes",
					...(quiet ? ["--quiet"] : []),
				);
				assert.strictEqual(result.status, 0, result.stderr + result.stdout);
				const err = stripVTControlCharacters(result.stderr);
				stepLine(
					stripVTControlCharacters(result.stdout + result.stderr),
					"Install Desktop Modeler",
					"SUCCESS",
				);
				const warnings = err.match(/^.*Run `c8ctl modeler update`.*$/gm);
				assert.deepStrictEqual(warnings, [
					"Camunda Modeler 5.51.0 is installed, but 5.52.0 is available. Run `c8ctl modeler update` to update it.",
				]);
				// Routine child stderr is still replayed below the status line.
				assert.match(err, /^ {4}routine modeler stderr$/m);
			} finally {
				stub.cleanup();
			}
		});
	}

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

		test("a failed deploy buffers the child diagnostics until the step closes", async () => {
			// The deploy runs as a `c8ctl deploy` child whose diagnostics are
			// buffered and printed after the step's status line, so no spinner
			// frame can be stranded among them on a shared terminal. (The
			// previous count-based assertion encoded "the in-process deploy
			// fails before the spinner's first tick"; a child process
			// legitimately outlives one tick on slow runners, so the count is
			// timing-dependent. The diagnostics' position relative to the
			// spinner is not observable across the separately captured streams,
			// so the stranded-frame guard carries the invariant.)
			const stub = stubbedExecution({ failStep: "deploy-blueprint" });
			try {
				const result = await runOnTty(stub);
				assert.strictEqual(result.status, 1, result.stdout);
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

	test("passes the probed Homebrew Modeler target to delegated removal", async () => {
		const stub = stubbedExecution();
		try {
			stub.options.env.C8CTL_SETUP_STUB_MODELER = "homebrew";
			const removal = await c8WithOptions(
				stub.options,
				"setup",
				"--remove",
				"--yes",
			);
			assert.strictEqual(removal.status, 0, removal.stderr + removal.stdout);
			assert.match(removal.stdout, /Removed Camunda Modeler with Homebrew/);
		} finally {
			stub.cleanup();
		}
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
			assert.match(
				preview.stdout,
				/Remove the Camunda Modeler app bundle at \/Applications\/Camunda Modeler\.app/,
			);
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
			assert.doesNotMatch(removed.stdout, /nothing was removed/i);
			assert.match(removed.stdout, /Removed Camunda Modeler from/);
			assert.match(removed.stdout, /Removed Camunda skill "camunda-c8ctl"/);
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

	test("--remove keeps a same-named skill path added after the preview", async () => {
		const stub = stubbedExecution();
		try {
			const skillRoot = join(stub.home, ".claude", "skills");
			const firstSkillPath = join(skillRoot, "camunda-c8ctl");
			const alternateConfig = join(stub.home, ".claude-alt");
			const secondSkillPath = join(alternateConfig, "skills", "camunda-c8ctl");
			const lateSkillPath = join(
				alternateConfig,
				"skills",
				"later",
				"camunda-c8ctl",
			);
			for (const skillPath of [
				firstSkillPath,
				secondSkillPath,
				lateSkillPath,
			]) {
				mkdirSync(skillPath, { recursive: true });
				writeFileSync(join(skillPath, "SKILL.md"), "# Camunda c8ctl\n");
			}
			writeFileSync(join(skillRoot, ".c8ctl-installed"), "camunda-c8ctl\n");
			stub.options.env.CLAUDE_CONFIG_DIR = alternateConfig;
			stub.options.env.C8CTL_SETUP_STUB_SKILL_SECOND_PATH = secondSkillPath;
			stub.options.env.C8CTL_SETUP_STUB_SKILL_APPEAR_AFTER_FIRST_LIST =
				lateSkillPath;
			stub.options.env.C8CTL_SETUP_STUB_SKILL_APPEAR_STATE = join(
				stub.cwd,
				"skill-appeared.state",
			);
			stub.options.env.C8CTL_SETUP_STUB_MODELER = "absent";

			const result = await c8WithOptions(
				stub.options,
				"setup",
				"--remove",
				"--yes",
			);
			assert.equal(result.status, 0, result.stderr + result.stdout);
			assert.ok(!result.stdout.includes(lateSkillPath));
			assert.ok(!existsSync(firstSkillPath));
			assert.ok(!existsSync(secondSkillPath));
			assert.ok(existsSync(lateSkillPath));
		} finally {
			stub.cleanup();
		}
	});

	test("--remove does not report an MCP conflict as removed after the preview", async () => {
		const stub = stubbedExecution();
		try {
			const installed = await c8WithOptions(stub.options, "setup", "--yes");
			assert.strictEqual(
				installed.status,
				0,
				installed.stderr + installed.stdout,
			);
			const mcpConfigPath = join(stub.home, ".claude", ".claude.json");
			stub.options.env.C8CTL_SETUP_STUB_MCP_CONFLICT_PATH = mcpConfigPath;

			const removal = await c8WithOptions(
				stub.options,
				"setup",
				"--remove",
				"--yes",
			);
			const output = `${removal.stderr}\n${removal.stdout}`;
			assert.strictEqual(removal.status, 1, output);
			assert.match(output, /Could not remove MCP configuration/);
			assert.doesNotMatch(output, /Removed MCP server "camunda"/);

			const remaining: unknown = JSON.parse(
				readFileSync(mcpConfigPath, "utf-8"),
			);
			assert.ok(
				isRecord(remaining) &&
					isRecord(remaining.mcpServers) &&
					isRecord(remaining.mcpServers.camunda),
			);
			assert.deepStrictEqual(remaining.mcpServers.camunda, {
				url: "https://foreign.example.invalid/mcp",
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
				"--yes",
			);
			const output = `${removal.stderr}\n${removal.stdout}`;
			assert.strictEqual(removal.status, 1, output);
			assert.match(output, /Could not inspect MCP configuration for cursor/);
			assert.match(output, /Could not inspect MCP configuration for vscode/);
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

	test("ignores EACCES and EPERM for child blueprint markers", async () => {
		for (const errorCode of ["EACCES", "EPERM"]) {
			const stub = stubbedExecution();
			try {
				stub.options.env.C8CTL_SETUP_STUB_MODELER = "absent";
				const blueprintDirectory = join(stub.cwd, "rocket-launch");
				mkdirSync(blueprintDirectory);
				writeFileSync(
					join(blueprintDirectory, ".c8ctl-blueprint.json"),
					JSON.stringify({
						id: "rocket-launch",
						files: ["rocket-launch.bpmn"],
					}),
				);
				writeFileSync(
					join(blueprintDirectory, "rocket-launch.bpmn"),
					"<definitions />\n",
				);

				const unreadableDirectory = join(stub.cwd, "locked");
				mkdirSync(unreadableDirectory);
				stub.options.env.C8CTL_SETUP_STUB_MARKER_PATH = join(
					"locked",
					".c8ctl-blueprint.json",
				);
				stub.options.env.C8CTL_SETUP_STUB_MARKER_ERROR = errorCode;

				const removal = await c8WithOptions(
					stub.options,
					"setup",
					"--remove",
					"--yes",
				);
				const output = `${removal.stderr}\n${removal.stdout}`;
				assert.strictEqual(removal.status, 0, output);
				assert.match(output, /Removed Rocket Launch blueprint files/);
				assert.doesNotMatch(output, /Could not inspect setup blueprint marker/);
				assert.ok(existsSync(unreadableDirectory));
				assert.ok(!existsSync(join(blueprintDirectory, "rocket-launch.bpmn")));
				assert.ok(
					!existsSync(join(blueprintDirectory, ".c8ctl-blueprint.json")),
				);
			} finally {
				stub.cleanup();
			}
		}
	});

	test("reports EACCES and EPERM for the current-directory blueprint marker", async () => {
		for (const errorCode of ["EACCES", "EPERM"]) {
			const stub = stubbedExecution();
			try {
				stub.options.env.C8CTL_SETUP_STUB_MODELER = "absent";
				const markerPath = join(stub.cwd, ".c8ctl-blueprint.json");
				const marker = JSON.stringify({
					id: "rocket-launch",
					files: ["rocket-launch.bpmn"],
				});
				writeFileSync(markerPath, marker);
				stub.options.env.C8CTL_SETUP_STUB_MARKER_PATH = ".c8ctl-blueprint.json";
				stub.options.env.C8CTL_SETUP_STUB_MARKER_ERROR = errorCode;

				const removal = await c8WithOptions(
					stub.options,
					"setup",
					"--remove",
					"--yes",
				);
				const output = `${removal.stderr}\n${removal.stdout}`;
				assert.strictEqual(removal.status, 1, output);
				assert.match(
					output,
					/Warning: Could not inspect setup blueprint marker/,
				);
				assert.strictEqual(readFileSync(markerPath, "utf-8"), marker);
			} finally {
				stub.cleanup();
			}
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
			const retiredDirectory = join(stub.cwd, "retired-blueprint");
			mkdirSync(retiredDirectory);
			writeFileSync(join(retiredDirectory, "README.md"), "# Retired\n");
			writeFileSync(
				join(retiredDirectory, ".c8ctl-blueprint.json"),
				JSON.stringify({ id: "retired-blueprint", files: ["README.md"] }),
			);

			const removal = await c8WithOptions(
				stub.options,
				"setup",
				"--remove",
				"--yes",
			);
			const output = `${removal.stderr}\n${removal.stdout}`;
			assert.strictEqual(removal.status, 1, output);
			assert.strictEqual(
				(
					output.match(/Warning: Could not inspect setup blueprint marker/g) ??
					[]
				).length,
				1,
				output,
			);
			assert.match(output, /Removed MCP server "camunda"/);
			assert.match(output, /Removed Camunda skill "camunda-c8ctl"/);
			assert.match(output, /Removed retired-blueprint blueprint files/);
			assert.strictEqual(readFileSync(malformedMarkerPath, "utf-8"), "{");
			assert.ok(!existsSync(join(retiredDirectory, "README.md")));
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

	test("continues cleanup when blueprint directory enumeration fails", async () => {
		const stub = stubbedExecution();
		try {
			const installed = await c8WithOptions(stub.options, "setup", "--yes");
			assert.strictEqual(
				installed.status,
				0,
				installed.stderr + installed.stdout,
			);

			const blueprintDirectory = join(stub.cwd, "rocket-launch");
			const removal = await c8WithOptions(
				{
					...stub.options,
					cwd: blueprintDirectory,
					env: {
						...stub.options.env,
						C8CTL_SETUP_STUB_FAIL: "list-blueprint-directories",
					},
				},
				"setup",
				"--remove",
				"--yes",
			);
			const output = `${removal.stderr}\n${removal.stdout}`;
			assert.strictEqual(removal.status, 1, output);
			assert.match(output, /stubbed blueprint directory listing failure/);
			assert.match(output, /Removed MCP server "camunda"/);
			assert.match(output, /Removed Rocket Launch blueprint files/);
			assert.ok(!existsSync(join(blueprintDirectory, "rocket-launch.bpmn")));
			assert.ok(!existsSync(join(blueprintDirectory, ".c8ctl-blueprint.json")));
		} finally {
			stub.cleanup();
		}
	});

	test("reports blueprint inspection failures when no artifacts are removable", async () => {
		const stub = stubbedExecution();
		try {
			const malformedMarkerPath = join(stub.cwd, ".c8ctl-blueprint.json");
			writeFileSync(malformedMarkerPath, "{");
			// Without a managed Modeler installation there is nothing to
			// remove at all — the empty-preview path stays reachable.
			stub.options.env.C8CTL_SETUP_STUB_MODELER = "absent";

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
			assert.doesNotMatch(output, /Camunda Modeler/);
			assert.strictEqual(readFileSync(malformedMarkerPath, "utf-8"), "{");
		} finally {
			stub.cleanup();
		}
	});

	test("omits Modeler from the preview when no managed installation exists", async () => {
		const stub = stubbedExecution();
		try {
			const installed = await c8WithOptions(stub.options, "setup", "--yes");
			assert.strictEqual(
				installed.status,
				0,
				installed.stderr + installed.stdout,
			);
			stub.options.env.C8CTL_SETUP_STUB_MODELER = "absent";

			const removal = await c8WithOptions(
				stub.options,
				"setup",
				"--remove",
				"--yes",
			);
			const output = `${removal.stderr}\n${removal.stdout}`;
			assert.strictEqual(removal.status, 0, output);
			assert.doesNotMatch(output, /Modeler/);
			assert.ok(
				!existsSync(join(stub.home, ".claude", "skills", "camunda-c8ctl")),
			);
		} finally {
			stub.cleanup();
		}
	});

	test("continues the remaining removals when the modeler removal child fails", async () => {
		const stub = stubbedExecution();
		try {
			const installed = await c8WithOptions(stub.options, "setup", "--yes");
			assert.strictEqual(
				installed.status,
				0,
				installed.stderr + installed.stdout,
			);
			stub.options.env.C8CTL_SETUP_STUB_FAIL = "remove-modeler";

			const removal = await c8WithOptions(
				stub.options,
				"setup",
				"--remove",
				"--yes",
			);
			const output = `${removal.stderr}\n${removal.stdout}`;
			assert.strictEqual(removal.status, 1, output);
			assert.match(output, /Could not remove Camunda Desktop Modeler/);
			// The other removals still ran.
			assert.match(output, /Removed Camunda skill "camunda-c8ctl"/);
			assert.ok(
				!existsSync(join(stub.home, ".claude", "skills", "camunda-c8ctl")),
			);
			assert.ok(
				!existsSync(join(stub.cwd, "rocket-launch", "rocket-launch.bpmn")),
			);
		} finally {
			stub.cleanup();
		}
	});

	test("fails an otherwise empty removal when the Modeler probe fails", async () => {
		const stub = stubbedExecution();
		try {
			stub.options.env.C8CTL_SETUP_STUB_FAIL = "probe-modeler";

			const removal = await c8WithOptions(
				stub.options,
				"setup",
				"--remove",
				"--yes",
			);
			const output = `${removal.stderr}\n${removal.stdout}`;
			assert.strictEqual(removal.status, 1, output);
			assert.match(
				output,
				/Warning: Could not inspect the Camunda Desktop Modeler installation/,
			);
			assert.match(output, /No setup-managed components were found/);
		} finally {
			stub.cleanup();
		}
	});

	test("fails an otherwise empty removal when the Modeler probe response is malformed", async () => {
		const stub = stubbedExecution();
		try {
			stub.options.env.C8CTL_SETUP_STUB_MODELER = "malformed";

			const removal = await c8WithOptions(
				stub.options,
				"setup",
				"--remove",
				"--yes",
			);
			const output = `${removal.stderr}\n${removal.stdout}`;
			assert.strictEqual(removal.status, 1, output);
			assert.match(
				output,
				/Warning: Could not inspect the Camunda Desktop Modeler installation:.*invalid response/,
			);
			assert.match(output, /No setup-managed components were found/);
		} finally {
			stub.cleanup();
		}
	});

	test("fails removal when the Modeler probe omits its target", async () => {
		const stub = stubbedExecution();
		try {
			stub.options.env.C8CTL_SETUP_STUB_MODELER = "malformed-target";

			const removal = await c8WithOptions(
				stub.options,
				"setup",
				"--remove",
				"--yes",
			);
			const output = `${removal.stderr}\n${removal.stdout}`;
			assert.strictEqual(removal.status, 1, output);
			assert.match(
				output,
				/invalid response: expected a "removalTarget" object with nonempty "method" and "path"/,
			);
			assert.doesNotMatch(output, /Removed Camunda Modeler/);
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

	test("removal JSON and dry-run only preview, and the retired --stop-cluster flag errors", async () => {
		const stub = stubbedExecution();
		try {
			const installed = await c8WithOptions(stub.options, "setup", "--yes");
			assert.strictEqual(
				installed.status,
				0,
				installed.stderr + installed.stdout,
			);

			plantC8RunInstall(stub.c8runCache, "8.10.0");
			const installDir = join(stub.c8runCache, "c8run-8.10.0");
			const dataDir = join(stub.c8runCache, "c8run-8.10.0", "camunda-data");

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
				"--json",
			);
			assert.strictEqual(jsonPreview.status, 0, jsonPreview.stderr);
			const jsonPayload: unknown = JSON.parse(jsonPreview.stdout);
			assert.ok(isRecord(jsonPayload) && Array.isArray(jsonPayload.items));
			assert.strictEqual(jsonPayload.preview, true);
			const clusterItem = jsonPayload.items.find(
				(item: unknown) => isRecord(item) && item.type === "local-cluster",
			);
			assert.ok(isRecord(clusterItem));
			assert.strictEqual(clusterItem.action, "remove");
			assert.deepStrictEqual(clusterItem.versions, ["8.10.0"]);
			assert.ok(existsSync(blueprintFile));
			assert.ok(existsSync(skillDirectory));
			assert.ok(existsSync(installDir));
			assert.ok(existsSync(dataDir));

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
			assert.ok(existsSync(installDir));

			const preview = await c8WithOptions(stub.options, "setup", "--remove");
			assert.strictEqual(preview.status, 0, preview.stderr + preview.stdout);
			assert.match(
				preview.stdout,
				/Stop the local cluster and remove Camunda 8 Run 8\.10\.0/,
			);
			assert.match(
				preview.stdout,
				/Run "c8ctl setup --remove --yes" to confirm/,
			);
			assert.ok(existsSync(blueprintFile));
			assert.ok(existsSync(skillDirectory));
			assert.ok(existsSync(installDir));

			const retired = await c8WithOptions(
				stub.options,
				"setup",
				"--remove",
				"--stop-cluster",
				"--yes",
			);
			assert.strictEqual(retired.status, 1);
			assert.match(`${retired.stderr}\n${retired.stdout}`, /--stop-cluster/);
			assert.ok(existsSync(blueprintFile));
			assert.ok(existsSync(installDir));

			const retiredAlone = await c8WithOptions(
				stub.options,
				"setup",
				"--stop-cluster",
			);
			assert.strictEqual(retiredAlone.status, 1);
			assert.match(
				`${retiredAlone.stderr}\n${retiredAlone.stdout}`,
				/--stop-cluster/,
			);

			const removed = await c8WithOptions(
				stub.options,
				"setup",
				"--remove",
				"--yes",
			);
			assert.strictEqual(removed.status, 0, removed.stderr + removed.stdout);
			assert.match(removed.stdout, /Stopped local Camunda 8 cluster/);
			assert.match(removed.stdout, /deleted: camunda-data/);
			assert.match(removed.stdout, /Version 8\.10\.0 has been deleted/);
			assert.ok(!existsSync(blueprintFile));
			assert.ok(!existsSync(skillDirectory));
			assert.ok(!existsSync(installDir));
			assert.ok(!existsSync(dataDir));
		} finally {
			stub.cleanup();
		}
	});

	test("continues the remaining removals when cluster teardown fails", async () => {
		const stub = stubbedExecution({ failStep: "delete-cluster" });
		try {
			const installed = await c8WithOptions(stub.options, "setup", "--yes");
			assert.strictEqual(
				installed.status,
				0,
				installed.stderr + installed.stdout,
			);

			plantC8RunInstall(stub.c8runCache, "8.10.0");
			const installDir = join(stub.c8runCache, "c8run-8.10.0");

			const removal = await c8WithOptions(
				stub.options,
				"setup",
				"--remove",
				"--yes",
			);
			const output = `${removal.stderr}\n${removal.stdout}`;
			assert.strictEqual(removal.status, 1, output);
			assert.match(output, /Stopped local Camunda 8 cluster/);
			assert.match(output, /deleted: camunda-data/);
			assert.match(output, /Could not remove Camunda 8 Run 8\.10\.0/);
			// The binary survives its failed delete; the other teardowns ran.
			assert.ok(existsSync(installDir));
			assert.ok(!existsSync(join(installDir, "camunda-data")));
			assert.ok(
				!existsSync(join(stub.cwd, "rocket-launch", "rocket-launch.bpmn")),
			);
			assert.ok(
				!existsSync(join(stub.home, ".claude", "skills", "camunda-c8ctl")),
			);
		} finally {
			stub.cleanup();
		}
	});

	test("removes a partial cluster installation whose binary is missing", async () => {
		const stub = stubbedExecution();
		try {
			stub.options.env.C8CTL_SETUP_STUB_MODELER = "absent";
			// A launcher deleted while runtime data remains: the install dir
			// survives without a c8run binary.
			const installDir = join(stub.c8runCache, "c8run-8.10.0");
			mkdirSync(join(installDir, "camunda-data"), { recursive: true });
			writeFileSync(join(installDir, "camunda-data", "state.json"), "{}");

			const removal = await c8WithOptions(
				stub.options,
				"setup",
				"--remove",
				"--yes",
			);
			const output = `${removal.stderr}\n${removal.stdout}`;
			assert.strictEqual(removal.status, 0, output);
			assert.match(
				output,
				/Stop the local cluster and remove Camunda 8 Run 8\.10\.0/,
			);
			assert.match(output, /deleted: camunda-data/);
			assert.ok(!existsSync(installDir));
		} finally {
			stub.cleanup();
		}
	});

	test("stops a running cluster whose install directory is gone", async () => {
		const stub = stubbedExecution({ clusterUp: true });
		try {
			stub.options.env.C8CTL_SETUP_STUB_MODELER = "absent";
			// Nothing planted: the install dir was deleted out from under a
			// running cluster, so only the owner's status still sees it.

			const preview = await c8WithOptions(stub.options, "setup", "--remove");
			assert.strictEqual(preview.status, 0, preview.stderr + preview.stdout);
			assert.match(preview.stdout, /Stop the local cluster/);
			assert.doesNotMatch(preview.stdout, /remove Camunda 8 Run/);

			const removal = await c8WithOptions(
				stub.options,
				"setup",
				"--remove",
				"--yes",
			);
			const output = `${removal.stderr}\n${removal.stdout}`;
			assert.strictEqual(removal.status, 0, output);
			assert.match(output, /Stopped local Camunda 8 cluster/);
			assert.match(output, /Setup removal finished/);
		} finally {
			stub.cleanup();
		}
	});

	test("stops the confirmed running version after its install directory is gone", async () => {
		const stub = stubbedExecution();
		try {
			stub.options.env.C8CTL_SETUP_STUB_MODELER = "absent";
			const installed = await c8WithOptions(stub.options, "setup", "--yes");
			assert.strictEqual(
				installed.status,
				0,
				installed.stderr + installed.stdout,
			);
			// The fake start never creates an install dir, so the owner's
			// durable record (the marker) is the only trace of the running
			// 8.10 — the status probe still attributes the version.

			const preview = await c8WithOptions(stub.options, "setup", "--remove");
			assert.strictEqual(preview.status, 0, preview.stderr + preview.stdout);
			assert.match(preview.stdout, /Stop the local cluster/);

			const removal = await c8WithOptions(
				stub.options,
				"setup",
				"--remove",
				"--yes",
			);
			const output = `${removal.stderr}\n${removal.stdout}`;
			assert.strictEqual(removal.status, 0, output);
			assert.match(output, /Stopped local Camunda 8 cluster/);
			assert.match(output, /Setup removal finished/);
		} finally {
			stub.cleanup();
		}
	});

	test("stops an orphaned running cluster when another version is installed", async () => {
		const stub = stubbedExecution();
		try {
			stub.options.env.C8CTL_SETUP_STUB_MODELER = "absent";
			const installed = await c8WithOptions(stub.options, "setup", "--yes");
			assert.strictEqual(
				installed.status,
				0,
				installed.stderr + installed.stdout,
			);
			plantC8RunInstall(stub.c8runCache, "8.9.0");

			const preview = await c8WithOptions(stub.options, "setup", "--remove");
			assert.strictEqual(preview.status, 0, preview.stderr + preview.stdout);
			assert.match(
				preview.stdout,
				/Stop the local cluster and remove Camunda 8 Run 8\.9\.0/,
			);

			const removal = await c8WithOptions(
				stub.options,
				"setup",
				"--remove",
				"--yes",
			);
			const output = `${removal.stderr}\n${removal.stdout}`;
			assert.strictEqual(removal.status, 0, output);
			assert.match(output, /Stopped local Camunda 8 cluster/);
			assert.doesNotMatch(output, /was not in the removal preview/);
			assert.ok(!existsSync(join(stub.c8runCache, "c8run-8.9.0")));
			assert.ok(!existsSync(join(stub.c8runCache, "cluster.running")));
		} finally {
			stub.cleanup();
		}
	});

	test("purges the durable-marker version before deleting multiple installs", async () => {
		const stub = stubbedExecution({
			clusterUp: true,
			failStep: "delete-cluster",
		});
		try {
			stub.options.env.C8CTL_SETUP_STUB_MODELER = "absent";
			plantC8RunInstall(stub.c8runCache, "8.9.0", "8.10.0");
			writeFileSync(join(stub.c8runCache, "cluster.running"), "8.9.0");

			const removal = await c8WithOptions(
				stub.options,
				"setup",
				"--remove",
				"--yes",
			);
			const output = `${removal.stderr}\n${removal.stdout}`;
			assert.strictEqual(removal.status, 1, output);
			assert.match(output, /Stopped local Camunda 8 cluster/);
			assert.match(output, /Purged runtime data for 8\.9\.0/);
			assert.match(output, /Could not remove Camunda 8 Run 8\.9\.0/);
			assert.ok(existsSync(join(stub.c8runCache, "c8run-8.9.0")));
			assert.ok(
				!existsSync(join(stub.c8runCache, "c8run-8.9.0", "camunda-data")),
			);
			assert.ok(
				!existsSync(
					join(stub.c8runCache, "c8run-8.9.0", "camunda-zeebe-8.9.0", "data"),
				),
			);
			assert.ok(
				!existsSync(join(stub.c8runCache, "c8run-8.10.0", "camunda-data")),
			);
		} finally {
			stub.cleanup();
		}
	});

	test("preserves the cluster installation when its preview status probe fails", async () => {
		const stub = stubbedExecution();
		try {
			stub.options.env.C8CTL_SETUP_STUB_MODELER = "absent";
			const installed = await c8WithOptions(stub.options, "setup", "--yes");
			assert.strictEqual(
				installed.status,
				0,
				installed.stderr + installed.stdout,
			);
			plantC8RunInstall(stub.c8runCache, "8.10.0");
			const installDir = join(stub.c8runCache, "c8run-8.10.0");
			const dataDir = join(installDir, "camunda-data");

			stub.options.env.C8CTL_SETUP_STUB_FAIL = "probe-cluster-status";
			const removal = await c8WithOptions(
				stub.options,
				"setup",
				"--remove",
				"--yes",
			);
			const output = `${removal.stderr}\n${removal.stdout}`;
			assert.strictEqual(removal.status, 1, output);
			assert.match(output, /stubbed cluster status failure diagnostics/);
			// A failed preview cannot promise teardown of a potentially
			// running cluster, including its runtime data and binary.
			assert.doesNotMatch(
				output,
				/Stop the local cluster and remove Camunda 8 Run/,
			);
			assert.doesNotMatch(output, /Stopped local Camunda 8 cluster/);
			assert.doesNotMatch(output, /Purged runtime data for 8\.10\.0/);
			assert.ok(existsSync(installDir));
			assert.ok(existsSync(join(dataDir, "state.json")));
			assert.ok(
				existsSync(
					join(installDir, "camunda-zeebe-8.10.0", "data", "raft.json"),
				),
			);
		} finally {
			stub.cleanup();
		}
	});

	test("continues version cleanup when the post-confirmation status probe fails", async () => {
		const stub = stubbedExecution();
		try {
			stub.options.env.C8CTL_SETUP_STUB_MODELER = "absent";
			const installed = await c8WithOptions(stub.options, "setup", "--yes");
			assert.strictEqual(
				installed.status,
				0,
				installed.stderr + installed.stdout,
			);
			plantC8RunInstall(stub.c8runCache, "8.10.0");

			stub.options.env.C8CTL_SETUP_STUB_FAIL =
				"probe-cluster-status-after-first-probe";
			const removal = await c8WithOptions(
				stub.options,
				"setup",
				"--remove",
				"--yes",
			);
			const output = `${removal.stderr}\n${removal.stdout}`;
			assert.strictEqual(removal.status, 1, output);
			assert.match(output, /cluster status probe failed/);
			// The initial probe confirmed the preview. If the second probe
			// fails, stop is refused but cleanup of the confirmed version
			// remains independent.
			assert.doesNotMatch(output, /Stopped local Camunda 8 cluster/);
			assert.match(output, /Purged runtime data for 8\.10\.0/);
			assert.ok(!existsSync(join(stub.c8runCache, "c8run-8.10.0")));
		} finally {
			stub.cleanup();
		}
	});

	test("keeps a cluster version installed and started after the preview", async () => {
		const stub = stubbedExecution({ clusterUp: true });
		try {
			stub.options.env.C8CTL_SETUP_STUB_MODELER = "absent";
			plantC8RunInstall(stub.c8runCache, "8.10.0");

			// The preview covers 8.10.0; while the confirmation prompt is open,
			// 8.11.0 appears and is the version now running.
			const result = await runInteractive(
				[
					{
						waitFor: "Remove the listed setup components?",
						beforeKeys: () => plantC8RunInstall(stub.c8runCache, "8.11.0"),
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
			const output = `${result.stderr}\n${result.stdout}`;
			assert.strictEqual(result.status, 1, output);
			assert.match(
				output,
				/Camunda 8 Run 8\.11\.0 is running but was not in the removal preview/,
			);
			// The unpreviewed running version keeps its binary and its data…
			const unpreviewed = join(stub.c8runCache, "c8run-8.11.0");
			assert.ok(existsSync(unpreviewed));
			assert.ok(existsSync(join(unpreviewed, "camunda-data")));
			// …while the previewed one is purged and deleted.
			assert.ok(!existsSync(join(stub.c8runCache, "c8run-8.10.0")));
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
			assert.doesNotMatch(confirmed.stdout, /nothing was removed/i);
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

	test("a failed deploy prints the child diagnostics below its status line", async () => {
		const stub = stubbedExecution({ failStep: "deploy-blueprint" });
		try {
			const result = await runWithOrderedOutput(stub.options, "setup", "--yes");
			assert.strictEqual(result.status, 1, result.output);
			const out = stripVTControlCharacters(result.output);
			stepLine(out, "Deploy and start the process", "ERROR");
			// The deploy runs as a `c8ctl deploy` child whose diagnostics are
			// buffered and printed after the step's status line — they never
			// collide with the open title line or its spinner. Compared
			// against the completed [ERROR] line in the arrival-ordered
			// capture: the opening title also contains the step name.
			const statusAt = out.search(/Deploy and start the process \.+ \[ERROR\]/);
			assert.ok(statusAt !== -1, "completed status line missing");
			const diagnosticsAt = out.indexOf("✗ Deployment failed");
			assert.ok(
				diagnosticsAt > statusAt,
				"diagnostics must follow the status line",
			);
			// The child rendered the failure with its own indentation — the
			// step's dump re-indents those lines, so the child's two-space
			// problem detail never surfaces as a four-space summary line.
			assert.doesNotMatch(out, /^ {4}INVALID_ARGUMENT$/m);
			// No instance was started, so the box must not claim one is
			// running or deeplink one — only the Project/Guide references
			// remain.
			assert.doesNotMatch(out, /Process instance is running/);
			assert.doesNotMatch(out, /operate\/processes\//);
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

	test("Camunda skills installed by another tool do not fail the skills step or skip the deploy", async () => {
		const stub = stubbedExecution();
		stub.options.env.C8CTL_SETUP_STUB_UNMANAGED_SKILLS = "1";
		mkdirSync(join(stub.home, ".claude", "skills", "camunda-c8ctl"), {
			recursive: true,
		});
		try {
			const result = await c8WithOptions(stub.options, "setup", "--yes");
			assert.strictEqual(result.status, 0, result.stderr + result.stdout);
			const out = stripVTControlCharacters(result.stdout + result.stderr);
			stepLine(out, "Install AI assistant skills", "SUCCESS");
			stepLine(out, "Deploy and start the process", "SUCCESS");
			// The keep-notice is actionable, so it is not buffered away.
			assert.match(
				stripVTControlCharacters(result.stderr),
				/Kept 1 Camunda skill for Claude Code that another tool installed/,
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
				[{ waitFor: "Docs MCP server", keys: " \t\r" }],
				{
					nodeArgs: stub.options.nodeArgs,
					env: stub.options.env,
					cwd: stub.cwd,
				},
			);
			assert.strictEqual(result.status, 0, result.stderr + result.stdout);
			assert.ok(result.stderr.includes(PROMPT_TEXT), "prompt not rendered");
			// Components are grouped: section headers precede their options.
			const menu = stripVTControlCharacters(result.stderr);
			assert.match(menu, /^ {2}Essentials$/m);
			assert.match(menu, /^ {2}AI-assisted development$/m);
			assert.ok(
				menu.indexOf("Essentials") < menu.indexOf("Local cluster"),
				"the Essentials header does not precede its options",
			);
			assert.ok(
				menu.indexOf("AI-assisted development") <
					menu.indexOf("AI assistant skills"),
				"the AI-assisted development header does not precede its options",
			);
			assert.ok(
				!result.stderr.includes(BLUEPRINT_PROMPT_TEXT),
				"blueprint prompt should not render when the cluster is off",
			);
			assert.match(
				stripVTControlCharacters(result.stderr),
				/Example project.*⚠ requires the local cluster/,
			);
			// The cluster MCP server depends on the cluster the same way.
			assert.match(
				stripVTControlCharacters(result.stderr),
				/Cluster MCP server.*⚠ requires the local cluster/,
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
				[{ waitFor: "Docs MCP server", keys: "\t\r" }],
				{
					nodeArgs: stub.options.nodeArgs,
					env: stub.options.env,
					cwd: stub.cwd,
				},
			);
			assert.strictEqual(result.status, 0, result.stderr + result.stdout);
			assert.ok(result.stderr.includes(PROMPT_TEXT), "prompt not rendered");
			assert.doesNotMatch(
				result.stderr,
				new RegExp(BLUEPRINT_PROMPT_TEXT),
				"setup should not ask a second blueprint question",
			);
			const out = stripVTControlCharacters(result.stdout + result.stderr);
			stepLine(out, "Check prerequisites", "SUCCESS");
			stepLine(out, "Deploy and start the process", "SUCCESS");
			assert.match(out, /Setup finished\./);
			assert.ok(
				existsSync(join(stub.cwd, "rocket-launch", "rocket-launch.bpmn")),
			);
			assert.strictEqual((out.match(/What's next/g) ?? []).length, 1);
			assert.match(
				out,
				/Watch it:\s+http:\/\/localhost:8080\/operate\/processes\/2251799813686751/,
			);
			assert.doesNotMatch(out, /Start a worker in your language/);
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

	test("interactive: without a blueprint the box suggests the first run", async () => {
		const stub = stubbedExecution();
		try {
			const result = await runInteractive(
				// Down, down to "Example project", space to deselect, then
				// Tab to the submit button and Enter to confirm.
				[{ waitFor: "Docs MCP server", keys: "\x1b[B\x1b[B \t\r" }],
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
			assert.match(out, /re-run "c8ctl setup" and include the example project/);
			assert.match(
				out,
				/Operate: http:\/\/localhost:8080\/operate \(demo\/demo\)/,
			);
		} finally {
			stub.cleanup();
		}
	});
});
