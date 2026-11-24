/**
 * `c8ctl setup` — guided first-run setup for local Camunda 8 development.
 *
 * Prints the welcome banner, asks what to set up (checkbox list with
 * dependencies plus a blueprint choice), then runs every selected step.
 * While a step runs on a terminal, a braille spinner ticks on its open
 * title line so long steps don't look frozen (piped and --quiet output
 * stays static). Each step ends in a `[SUCCESS]`, `[ERROR]` or
 * `[SKIPPED]` line in an aligned column (green, red and dim on a
 * terminal); a failed step
 * prints its error on the following lines and the remaining steps still
 * run. Steps whose dependencies failed are skipped with the unmet steps
 * named.
 *
 * The browser opens once: c8run itself opens it when the cluster
 * reports healthy, exactly as on a plain `c8ctl cluster start`.
 *
 * Execution needs a go-ahead: an interactive selection or `--yes`. A
 * piped run without `--yes` and JSON mode print the plan payload only,
 * so a script never installs software by accident.
 *
 * Streams: the banner, prompts and progress are UI chrome on stderr; the
 * step report and the JSON payload are the command's answer on stdout.
 *
 * Exit codes: 0 when every selected step succeeded, or when nothing
 * was installed for lack of a go-ahead (the wizard was cancelled with
 * Escape — Ctrl+C ends it by signal, 130 on POSIX shells — a piped,
 * --quiet or JSON-mode run had no --yes, or --json / --dry-run printed
 * the plan only). A re-run reuses finished work where possible; it
 * repeats the blueprint deploy and start by design, leaves correct MCP
 * entries untouched, updates out-of-date skills, and installs missing
 * skills.
 * 1 when arguments failed validation or any step failed — the
 * remaining eligible steps still ran, dependents of a failed step (and
 * the deploy finale after any failure) were skipped, and re-running
 * picks up where the failure left off.
 */

import { spawn } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	ProcessDefinitionId,
	type ProcessInstanceKey,
	TenantId,
} from "@camunda8/orchestration-cluster-api";
import {
	DEFAULT_PROFILE,
	isRecord,
	renderCommandFailure,
} from "../../src/core/index.ts";
import type {
	PluginCommands,
	PluginCtx,
	PluginMetadata,
} from "../../src/framework/plugins/plugin-loader.ts";
import { detectMcpHarnesses } from "../../src/utils/command-local/mcp-install-helpers.ts";
import { extractProcessId } from "../../src/utils/command-local/process-instance-helpers.ts";
import {
	CAMUNDA_SKILLS_REPOSITORY,
	detectInstalledHarnesses,
} from "../../src/utils/command-local/skills-install-helpers.ts";
import {
	removeSetupBlueprint,
	SETUP_BLUEPRINTS,
	scaffoldSetupBlueprint,
	setupBlueprintById,
} from "./blueprint-scaffold.ts";
import { checkLocalClusterHealth } from "./detectors.ts";
import {
	createLineForwarder,
	defaultSelection,
	enforceComponentDependencies,
	formatStepResult,
	formatStepStatusSuffix,
	isClusterProgressLine,
	renderNextSteps,
	renderWelcomeBanner,
	SETUP_COMPONENTS,
	SETUP_STEPS,
	type SetupComponentId,
	type SetupStepId,
	type StepSpinner,
	setupPlanPayload,
	startStepSpinner,
} from "./helpers.ts";
import { checkPrerequisites, MANUAL_SETUP_LINKS } from "./prerequisites.ts";
import {
	inspectSetupRemovalInventory,
	type SetupModelerRemoval,
	type SetupRemovalInventory,
} from "./removal.ts";

if (!globalThis.c8ctl) throw new Error("c8ctl runtime not initialised");
const c8ctl = globalThis.c8ctl;

/** Flags the setup handler reads, as declared in the plugin's flag table. */
interface SetupFlags {
	readonly modeler?: boolean;
	readonly "no-modeler"?: boolean;
	readonly "docs-mcp"?: boolean;
	readonly remove?: boolean;
	readonly "stop-cluster"?: boolean;
}

/**
 * The tenant of a fresh local C8Run cluster. Pinned explicitly: tenant
 * resolution otherwise prefers the session tenant and
 * CAMUNDA_DEFAULT_TENANT_ID, which could name a remote tenant the local
 * cluster does not know.
 */
const LOCAL_TENANT_ID = "<default>";

/** State one step hands to a later one. */
interface SetupRun {
	blueprintId: string | undefined;
	blueprintDir?: string;
	/** Set when the cluster step succeeded — drives the final Operate hint. */
	clusterStarted?: boolean;
	/** Set when the deploy step started the blueprint's process instance. */
	processInstanceKey?: ProcessInstanceKey;
}

/**
 * Explicit flags override the checkbox selection: --no-modeler wins.
 * Dependencies are then re-enforced, so a flag cannot resurrect a
 * component whose requirement is deselected.
 */
function applyComponentFlags(
	selected: ReadonlySet<SetupComponentId>,
	flags: SetupFlags,
): Set<SetupComponentId> {
	const next = new Set(selected);
	if (flags["no-modeler"]) next.delete("modeler");
	else if (flags.modeler) next.add("modeler");
	if (flags["docs-mcp"]) next.add("docs-mcp");
	return enforceComponentDependencies(next);
}

/**
 * The blueprint a non-interactive run installs: the first curated one.
 * Blueprints are deliberately not selectable via a CLI flag — the
 * wizard prompt is the only choice point.
 */
function effectiveBlueprint(
	selected: ReadonlySet<SetupComponentId>,
): string | undefined {
	if (!selected.has("blueprint")) return undefined;
	return SETUP_BLUEPRINTS[0].id;
}

// ── Step executors ─────────────────────────────────────────────────

type StepExecutor = (ctx: PluginCtx, run: SetupRun) => Promise<void> | void;

async function runPrerequisites(ctx: PluginCtx): Promise<void> {
	const results = await checkPrerequisites();
	for (const result of results) {
		ctx.logger.info(
			`  ${result.ok ? "✓" : "✗"} ${result.title}: ${result.detail}`,
		);
	}
	const failed = results.filter((result) => !result.ok);
	if (failed.length > 0) {
		throw new Error(
			[
				...failed.map(
					(result) =>
						`${result.title}: ${result.detail}${result.hint ? ` ${result.hint}` : ""}`,
				),
				"To set up Camunda by hand instead:",
				...MANUAL_SETUP_LINKS.map((link) => `${link.label}: ${link.url}`),
			].join("\n"),
		);
	}
}

/**
 * The CLI's own entry point, for self-invoking c8ctl commands. The plugin
 * sits at default-plugins/setup/ in development (entry: src/index.ts) and
 * at dist/default-plugins/setup/ once bundled (entry: dist/index.js) —
 * take the first candidate that exists.
 */
const CLI_ENTRY = (() => {
	const dir = realpathSync(fileURLToPath(new URL(".", import.meta.url)));
	const candidates = [
		resolve(dir, "..", "..", "index.js"),
		resolve(dir, "..", "..", "src", "index.ts"),
	];
	return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
})();

/**
 * Run a c8ctl command as a child process and map its exit code onto a
 * step result. Setup orchestrates the commands that own a capability —
 * the cluster plugin, the modeler installer — instead of importing their
 * internals, so a child failure surfaces as that command's own output
 * followed by a step error.
 *
 * The child's stdout is streamed through a line filter (`skipStdoutLine`
 * drops noise like the c8run download progress, `//> 42% …`) and feeds
 * the step's output buffer (via ctx.logger) — it surfaces only when the
 * step fails, except lines `promoteStdoutLine` marks essential. stderr
 * buffers the same way by default, so a step's failure diagnostics print
 * after its closed title line; `stderrPassthrough` opts into immediate
 * printing for the cluster children, whose warnings are actionable while
 * the cluster keeps starting, and `promoteStderrLine` does the same for
 * individual actionable lines. The child is pinned to text mode so its
 * lines stay plain and filterable no matter the session's output mode.
 */
function spawnC8ctl(
	ctx: PluginCtx,
	argv: string[],
	{
		skipStdoutLine,
		promoteStdoutLine,
		promoteStderrLine,
		stderrPassthrough = false,
		extraEnv,
	}: {
		skipStdoutLine?: (line: string) => boolean;
		promoteStdoutLine?: (line: string) => boolean;
		promoteStderrLine?: (line: string) => boolean;
		stderrPassthrough?: boolean;
		extraEnv?: Record<string, string>;
	} = {},
): Promise<void> {
	const label = `c8ctl ${argv.join(" ")}`;
	return new Promise((resolvePromise, rejectPromise) => {
		// process.execArgv carries the parent's `--experimental-strip-types`
		// and any `--import` preloads into the child, so a test preload (the
		// offline setup stub) governs the child's fetch/fs/child-process
		// seams the same way it governs this process. In production
		// execArgv is empty and the child runs plain.
		const child = spawn(
			process.execPath,
			[...process.execArgv, CLI_ENTRY, ...argv],
			{
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, C8CTL_OUTPUT_MODE: "text", ...extraEnv },
			},
		);
		const out = createLineForwarder({
			write: (line) =>
				ctx.logger.info(line, {
					stream: "stdout",
					essential: promoteStdoutLine?.(line) === true,
				}),
			skip: skipStdoutLine ?? (() => false),
		});
		const err = createLineForwarder({
			write: (line) =>
				ctx.logger.info(line, {
					stream: "stderr",
					essential: stderrPassthrough || promoteStderrLine?.(line) === true,
				}),
			skip: () => false,
		});
		child.stdout?.setEncoding("utf-8");
		child.stderr?.setEncoding("utf-8");
		child.stdout?.on("data", (chunk: string) => out.push(chunk));
		child.stderr?.on("data", (chunk: string) => err.push(chunk));
		child.on("error", (error) =>
			rejectPromise(new Error(`Could not run ${label}: ${error.message}`)),
		);
		child.on("close", (code) => {
			out.flush();
			err.flush();
			if (code === 0) {
				resolvePromise();
			} else {
				rejectPromise(new Error(`${label} failed (exit code ${code}).`));
			}
		});
	});
}

function spawnClusterStart(ctx: PluginCtx): Promise<void> {
	return spawnC8ctl(ctx, ["cluster", "start"], {
		skipStdoutLine: isClusterProgressLine,
		stderrPassthrough: true,
	});
}

function spawnClusterStop(ctx: PluginCtx): Promise<void> {
	// Removal reports every child line, matching the previous dedicated
	// spawner whose forwarders marked all lines essential.
	return spawnC8ctl(ctx, ["cluster", "stop"], {
		promoteStdoutLine: () => true,
		stderrPassthrough: true,
	});
}

/**
 * Run a c8ctl command as a silent child and parse its JSON stdout. Used
 * for read-only probes (`modeler uninstall --dry-run`) where spawnC8ctl's
 * line forwarding would leak the payload into the removal output. As in
 * spawnC8ctl, process.execArgv carries test preloads into the child.
 */
function captureC8ctlJson(argv: string[]): Promise<unknown> {
	const label = `c8ctl ${argv.join(" ")}`;
	return new Promise((resolvePromise, rejectPromise) => {
		const child = spawn(
			process.execPath,
			[...process.execArgv, CLI_ENTRY, ...argv],
			{
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, C8CTL_OUTPUT_MODE: "json" },
			},
		);
		let stdout = "";
		let stderr = "";
		child.stdout?.setEncoding("utf-8");
		child.stderr?.setEncoding("utf-8");
		child.stdout?.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr?.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", (error) =>
			rejectPromise(new Error(`Could not run ${label}: ${error.message}`)),
		);
		child.on("close", (code) => {
			if (code !== 0) {
				const detail = stderr.trim();
				rejectPromise(
					new Error(
						`${label} failed (exit code ${code}).${detail ? ` ${detail}` : ""}`,
					),
				);
				return;
			}
			try {
				resolvePromise(JSON.parse(stdout));
			} catch {
				rejectPromise(
					new Error(`${label} did not print a JSON payload: ${stdout.trim()}`),
				);
			}
		});
	});
}

/**
 * Probe the modeler plugin's own dry run: it decides whether a managed
 * Modeler installation exists and describes the removal in its own words,
 * so setup never duplicates platform-specific detection. A false
 * `wouldChange` value means there is nothing to remove.
 */
async function detectModelerRemoval(): Promise<
	SetupModelerRemoval | undefined
> {
	const payload: unknown = await captureC8ctlJson([
		"modeler",
		"uninstall",
		"--dry-run",
	]);
	if (!isRecord(payload) || typeof payload.wouldChange !== "boolean") {
		throw new Error(
			'modeler uninstall --dry-run returned an invalid response: expected a boolean "wouldChange" field.',
		);
	}
	if (!payload.wouldChange) return undefined;
	const removalTarget = payload.removalTarget;
	if (
		!isRecord(removalTarget) ||
		typeof removalTarget.method !== "string" ||
		removalTarget.method.length === 0 ||
		typeof removalTarget.path !== "string" ||
		removalTarget.path.length === 0
	) {
		throw new Error(
			'modeler uninstall --dry-run returned an invalid response: expected a "removalTarget" object with nonempty "method" and "path".',
		);
	}
	return {
		message:
			typeof payload.message === "string"
				? payload.message
				: "remove Camunda Desktop Modeler",
		target: {
			method: removalTarget.method,
			path: removalTarget.path,
		},
	};
}

/** c8run's launcher exits before the services report healthy — poll for it. */
const CLUSTER_HEALTH_TIMEOUT_MS = 120_000;
const CLUSTER_HEALTH_POLL_MS = 2_000;

async function runClusterStart(ctx: PluginCtx, run: SetupRun): Promise<void> {
	await spawnClusterStart(ctx);
	const deadline = Date.now() + CLUSTER_HEALTH_TIMEOUT_MS;
	for (;;) {
		const health = await checkLocalClusterHealth();
		if (health.healthy) {
			run.clusterStarted = true;
			return;
		}
		if (Date.now() >= deadline) {
			throw new Error(
				`The cluster did not become healthy within ${CLUSTER_HEALTH_TIMEOUT_MS / 1000}s (${health.detail}). Check: c8ctl cluster status`,
			);
		}
		ctx.logger.info("  Waiting for the cluster to become healthy…");
		await new Promise((resolveWait) =>
			setTimeout(resolveWait, CLUSTER_HEALTH_POLL_MS),
		);
	}
}

async function runModelerInstall(ctx: PluginCtx): Promise<void> {
	// The modeler plugin owns the installation; setup runs it as a child
	// process. Always quiet: the installer's progress chatter is noise next
	// to the step report — the step's status line is the signal. Failures
	// still surface with the child's diagnostics. An outdated existing
	// installation is the exception: its update advice is actionable.
	await spawnC8ctl(ctx, ["modeler", "install", "--quiet"], {
		promoteStderrLine: (line) => line.includes("c8ctl modeler update"),
	});
}

async function runBlueprintScaffold(
	ctx: PluginCtx,
	run: SetupRun,
): Promise<void> {
	const id = run.blueprintId ?? SETUP_BLUEPRINTS[0].id;
	const scaffolded = await scaffoldSetupBlueprint({
		id,
		// The completion line is the step's takeaway — fresh or reused —
		// so it survives the success collapse; progress chatter does not.
		onProgress: (event) =>
			ctx.logger.info(event.message, {
				essential: event.phase === "complete",
			}),
	});
	run.blueprintDir = scaffolded.directory;
}

async function runBlueprintDeploy(
	ctx: PluginCtx,
	run: SetupRun,
): Promise<void> {
	const { logger } = ctx;
	const blueprint = setupBlueprintById(
		run.blueprintId ?? SETUP_BLUEPRINTS[0].id,
	);
	const directory = run.blueprintDir;
	if (!directory) {
		throw new Error("The blueprint project was not created.");
	}
	const deployDir = join(directory, blueprint.deployPath ?? ".");

	// The cluster was started moments ago; re-check so a cluster that
	// died in between gets a next action instead of a connection dump.
	const health = await checkLocalClusterHealth();
	if (!health.healthy) {
		throw new Error(
			[
				`Could not reach the local cluster (${health.detail}).`,
				"Start it with: c8ctl cluster start",
				// Pin the same local profile the healthy path deploys to, so the
				// recovery cannot land on a remote cluster from the session or env.
				`Then deploy the project with: c8ctl deploy "${deployDir}" --profile local`,
			].join("\n"),
		);
	}

	// Both mutations target the cluster the health check just probed: the
	// built-in local profile and its default tenant. The deploy runs as a
	// `c8ctl deploy` child process — deploy-helpers is command-private, so
	// the plugin orchestrates the command that owns it. The child runs with
	// a throwaway data dir so a session's preselected tenant cannot
	// redirect the first-run deployment; --profile local likewise wins over
	// CAMUNDA_* env vars.
	const deployDataDir = mkdtempSync(join(tmpdir(), "c8ctl-setup-deploy-"));
	stageLocalProfile(deployDataDir);
	try {
		await spawnC8ctl(
			ctx,
			[
				"deploy",
				deployDir,
				"--profile",
				DEFAULT_PROFILE,
				"--quiet",
				...(ctx.verbose ? ["--verbose"] : []),
			],
			{
				extraEnv: {
					CAMUNDA_DEFAULT_TENANT_ID: LOCAL_TENANT_ID,
					C8CTL_DATA_DIR: deployDataDir,
				},
			},
		);
	} finally {
		rmSync(deployDataDir, { recursive: true, force: true });
	}

	const processFile = join(directory, blueprint.processFile);
	const processId = extractProcessId(readFileSync(processFile, "utf-8"));
	if (!processId) {
		throw new Error(`Could not find a process id in ${blueprint.processFile}.`);
	}
	logger.info(`Starting a ${blueprint.name} process instance...`);
	const created = await c8ctl
		.createClient(DEFAULT_PROFILE)
		.createProcessInstance({
			processDefinitionId: ProcessDefinitionId.assumeExists(processId),
			tenantId: TenantId.assumeExists(LOCAL_TENANT_ID),
			...(blueprint.startVariables !== undefined && {
				variables: blueprint.startVariables,
			}),
		});
	logger.info(`Process instance created: ${created.processInstanceKey}`);
	run.processInstanceKey = created.processInstanceKey;
}

/**
 * Stage the saved `local` profile into the deploy child's isolated data
 * dir. A throwaway data dir would otherwise reduce the child to the
 * localhost/demo defaults while the in-process process start below uses
 * the saved profile — with a customized local profile (URL, credentials,
 * headers) deployment and process creation would target different
 * clusters. The tenant is pinned to `<default>` because tenant resolution
 * prefers a profile's defaultTenantId over the CAMUNDA_DEFAULT_TENANT_ID
 * env pin. Without a saved profile the child synthesizes the same
 * localhost default the in-process start would use.
 */
function stageLocalProfile(deployDataDir: string): void {
	const profilesPath = join(c8ctl.getUserDataDir(), "profiles.json");
	if (!existsSync(profilesPath)) return;
	const parsed: unknown = JSON.parse(readFileSync(profilesPath, "utf-8"));
	const profiles =
		isRecord(parsed) && Array.isArray(parsed.profiles) ? parsed.profiles : [];
	const local = profiles
		.filter(isRecord)
		.find((profile) => profile.name === DEFAULT_PROFILE);
	if (!local) return;
	// Credentials may live in this file — keep it owner-only.
	writeFileSync(
		join(deployDataDir, "profiles.json"),
		JSON.stringify({
			profiles: [{ ...local, defaultTenantId: LOCAL_TENANT_ID }],
		}),
		{ mode: 0o600 },
	);
}

const NO_HARNESS_HINT =
	"Install Claude Code, GitHub Copilot CLI or Cursor, then re-run c8ctl setup.";

async function runSkillsInstall(ctx: PluginCtx): Promise<void> {
	const harnesses = detectInstalledHarnesses();
	if (harnesses.length === 0) {
		ctx.logger.info(
			`No supported AI coding harness detected — nothing to install into. ${NO_HARNESS_HINT}`,
			{ essential: true },
		);
		return;
	}
	for (const harness of harnesses) {
		ctx.logger.info(
			`Checking Camunda skills (${CAMUNDA_SKILLS_REPOSITORY}) for ${harness}…`,
			{ essential: true },
		);
		// The skills plugin owns the install; one child per harness keeps
		// per-harness failure granularity.
		await spawnC8ctl(ctx, ["skills", "install", "--harness", harness]);
	}
}

/**
 * The `mcp install` command (mcp plugin) owns MCP configuration; setup runs it as
 * a child process pinned to the local profile (the docs server needs no
 * profile). The child's "MCP configuration: …" lines are the step's
 * takeaway, so they are promoted to essential output while its remaining
 * chatter stays buffered.
 */
function runMcpInstall(docs: boolean): StepExecutor {
	return async (ctx) => {
		// Pre-flight with the same detection rules the installer uses, so
		// a machine without a known harness soft-skips instead of failing
		// the step on the child's "no harness" error.
		if (detectMcpHarnesses().length === 0) {
			ctx.logger.info(
				`No supported AI coding harness detected — nothing to configure. ${NO_HARNESS_HINT}`,
				{ essential: true },
			);
			return;
		}
		await spawnC8ctl(
			ctx,
			docs
				? ["mcp", "install", "--docs"]
				: ["mcp", "install", "--profile", DEFAULT_PROFILE],
			{
				promoteStdoutLine: (line) => line.startsWith("MCP configuration: "),
			},
		);
		if (docs) {
			ctx.logger.info(
				"The docs server asks you to sign in in a browser on first use.",
				{
					essential: true,
				},
			);
		}
	};
}

const STEP_EXECUTORS: Record<SetupStepId, StepExecutor> = {
	prerequisites: runPrerequisites,
	"start-cluster": runClusterStart,
	"install-modeler": runModelerInstall,
	"scaffold-blueprint": runBlueprintScaffold,
	"deploy-blueprint": runBlueprintDeploy,
	"install-skills": runSkillsInstall,
	"cluster-mcp": runMcpInstall(false),
	"docs-mcp": runMcpInstall(true),
};

// ── The step runner ────────────────────────────────────────────────

/** A step's non-essential progress output, held back until it fails. */
interface BufferedLine {
	readonly message: string;
	readonly stream?: "stdout" | "stderr" | undefined;
}

/**
 * A ctx whose logger buffers non-essential info output: on success the
 * buffer is dropped and the step collapses to its status line; on
 * failure the buffer is flushed above the error. Essential lines,
 * warnings and errors pass through wrapped in `aroundPassthrough`, so
 * the step's title line closes before they print and — except for
 * errors, which precede a failing step's diagnostics — reopens after.
 */
function withBufferedOutput(
	ctx: PluginCtx,
	buffer: BufferedLine[],
	aroundPassthrough: (emit: () => void, options?: { resume: boolean }) => void,
): PluginCtx {
	const { logger } = ctx;
	const bufferedLogger = Object.create(logger, {
		info: {
			value: (
				message: string,
				options?: { stream?: "stdout" | "stderr"; essential?: boolean },
			) => {
				if (options?.essential) {
					aroundPassthrough(() => logger.info(message, options));
				} else {
					buffer.push({ message, stream: options?.stream });
				}
			},
		},
		warn: {
			value: (message: string) => {
				aroundPassthrough(() => logger.warn(message));
			},
		},
		error: {
			value: (message: string, error?: Error) => {
				// A step that logs an error is failing, and its diagnostics
				// may follow outside the wrapped logger (deploy-helpers
				// writes them straight to stderr) — close the title for
				// good instead of stranding a reopened frame among them.
				aroundPassthrough(() => logger.error(message, error), {
					resume: false,
				});
			},
		},
		success: {
			value: (message: string, key?: string | number) => {
				aroundPassthrough(() => logger.success(message, key));
			},
		},
	});
	// Prototype-chain override, not a spread: spreading PluginCtx would
	// evaluate its lazy `client` getter and resolve credentials for a step
	// that may never talk to a cluster.
	return Object.create(ctx, { logger: { value: bufferedLogger } });
}

/**
 * Run every selected step in plan order. Each step announces its title
 * and the status tag completes the same line — unless the step printed
 * essential output in between, in which case the status gets its own
 * line. Step output is buffered and shown only when the step fails,
 * followed by the error. Steps whose dependencies did not succeed are
 * skipped with the unmet steps named. Returns the failed-step count and
 * the state steps handed along (e.g. the scaffolded project directory).
 */
async function executePlan(
	ctx: PluginCtx,
	selected: ReadonlySet<SetupComponentId>,
	blueprintId: string | undefined,
	{ color }: { color: boolean },
): Promise<{ failures: number; run: SetupRun }> {
	const { logger } = ctx;
	const run: SetupRun = { blueprintId };
	const succeeded = new Set<SetupStepId>();
	let failures = 0;
	const width = Math.max(...SETUP_STEPS.map((step) => step.title.length));

	for (const step of SETUP_STEPS) {
		if (step.component !== null && !selected.has(step.component)) continue;

		const unmet = (step.dependsOn ?? []).filter((dep) => !succeeded.has(dep));
		// A clean-run step (the deploy finale) also waits for every earlier
		// step to have succeeded — no first process on a broken setup.
		const needsCleanRun = step.requiresCleanRun === true && failures > 0;
		if (unmet.length > 0 || needsCleanRun) {
			logger.info(formatStepResult(step.title, "skipped", width, { color }), {
				essential: true,
			});
			const names = unmet
				.map((dep) => SETUP_STEPS.find((s) => s.id === dep)?.title ?? dep)
				.join(", ");
			logger.info(
				unmet.length > 0
					? `    needs: ${names}`
					: "    needs: all previous steps to succeed",
				{ essential: true },
			);
			continue;
		}

		// The title line stays open: the status tag completes it. Essential
		// step output closes it first, so it never garbles mid-line — and
		// on a terminal the line reopens below the printed output with a
		// fresh spinner, so a chatty long step (the skills install prints
		// one line per harness, then downloads) keeps its activity
		// indicator. Piped and --quiet runs keep the plain, static line.
		let titleOpen = false;
		let spinner: StepSpinner | null = null;
		let stepActive = true;
		// Animate only when the spinning line fits the terminal: a wrapped
		// line would redraw on its continuation row, adding rows instead
		// of spinning in place.
		const canAnimate =
			color &&
			step.title.length + 4 <=
				(process.stdout.columns ?? Number.POSITIVE_INFINITY);
		const openTitle = () => {
			process.stdout.write(`  ${step.title}`);
			titleOpen = true;
			if (canAnimate) {
				spinner = startStepSpinner({
					title: step.title,
					write: (text) => process.stdout.write(text),
				});
			}
		};
		if (!ctx.quiet) openTitle();
		// Returns true when a spinning line was closed — the passthrough
		// wrapper then reopens it after the essential output, below what
		// was printed.
		const closeTitle = () => {
			if (!titleOpen) return false;
			const hadSpinner = spinner !== null;
			spinner?.stop();
			spinner = null;
			// With a spinner the line ends in a frame glyph and this rewrite
			// is shorter — erase to end of line so the glyph doesn't linger.
			process.stdout.write(hadSpinner ? `\r  ${step.title}\x1b[K\n` : "\n");
			titleOpen = false;
			return hadSpinner;
		};
		const aroundPassthrough = (
			emit: () => void,
			{ resume = true }: { resume?: boolean } = {},
		) => {
			const reopen = closeTitle();
			emit();
			if (reopen && resume && stepActive) openTitle();
		};
		const reportStatus = (status: "success" | "error") => {
			stepActive = false;
			if (titleOpen) {
				spinner?.stop();
				const suffix = formatStepStatusSuffix(step.title, status, width, {
					color,
				});
				process.stdout.write(
					spinner ? `\r  ${step.title}${suffix}\n` : `${suffix}\n`,
				);
				titleOpen = false;
			} else {
				logger.info(formatStepResult(step.title, status, width, { color }), {
					essential: true,
				});
			}
		};

		const buffered: BufferedLine[] = [];
		try {
			await STEP_EXECUTORS[step.id](
				withBufferedOutput(ctx, buffered, aroundPassthrough),
				run,
			);
			succeeded.add(step.id);
			reportStatus("success");
			// A child's stderr carries actionable warnings (a failed Start Menu
			// registration, a skipped version check) that the in-process
			// commands used to show even on success — surface those below the
			// status line while routine stdout progress stays collapsed.
			for (const line of buffered) {
				if (line.stream !== "stderr") continue;
				logger.info(`    ${line.message}`, {
					stream: line.stream,
					essential: true,
				});
			}
		} catch (error) {
			failures += 1;
			reportStatus("error");
			// The step failed — its buffered progress is now the diagnostics.
			for (const line of buffered) {
				logger.info(`    ${line.message}`, {
					stream: line.stream,
					essential: true,
				});
			}
			const message = error instanceof Error ? error.message : String(error);
			for (const line of message.split("\n")) {
				logger.info(`    ${line}`, { essential: true });
			}
			// Errors may carry a recovery hint (e.g. scaffold errors) — the
			// message alone is not actionable without it.
			const hint =
				error instanceof Error &&
				"hint" in error &&
				typeof error.hint === "string"
					? error.hint
					: undefined;
			if (hint) {
				for (const line of hint.split("\n")) {
					logger.info(`    ${line}`, { essential: true });
				}
			}
		}
	}
	return { failures, run };
}

/**
 * Turn the modeler plugin's dry-run message ("Dry run: would remove …")
 * into a preview line. The plugin owns the wording; setup only rephrases
 * the tense. An unrecognized shape is quoted instead of rewritten.
 */
function modelerRemovalLine(message: string): string {
	const match = /^Dry run: would remove (.+)$/.exec(message);
	if (match) return `Remove ${match[1]}`;
	return `Remove Camunda Desktop Modeler with \`c8ctl modeler uninstall\` (${message})`;
}

function setupRemovalPreview(
	inventory: SetupRemovalInventory,
	stopCluster: boolean,
): {
	text: string;
	payload: {
		command: "setup";
		action: "remove";
		preview: true;
		items: Record<string, unknown>[];
		warnings?: string[];
	};
} {
	const items: Record<string, unknown>[] = [];
	const warnings: string[] = [];
	const lines = ["Setup removal preview:"];

	for (const { plan, servers, preservedServers } of inventory.mcp) {
		for (const server of servers) {
			items.push({
				type: "mcp-server",
				harness: plan.harness,
				server,
				path: plan.path,
			});
			lines.push(
				`  Remove MCP server "${server}" for ${plan.harness} from ${plan.path}`,
			);
		}
		for (const server of preservedServers) {
			const warning = `Preserved foreign MCP server "${server}" for ${plan.harness} in ${plan.path}; it does not match setup-managed configuration.`;
			warnings.push(warning);
			lines.push(`  ${warning}`);
		}
	}

	for (const failure of inventory.mcpPlanningFailures) {
		const warning = `Could not inspect MCP configuration for ${failure.harness}: ${failure.message}. That configuration was left untouched.`;
		warnings.push(warning);
		lines.push(`  Warning: ${warning}`);
	}

	for (const failure of inventory.skillDiscoveryFailures) {
		const warning = `Could not inspect Camunda skills for ${failure.harness}: ${failure.message}. Those skills were left untouched.`;
		warnings.push(warning);
		lines.push(`  Warning: ${warning}`);
	}

	if (inventory.modelerInspectionFailure) {
		const warning = `Could not inspect the Camunda Desktop Modeler installation: ${inventory.modelerInspectionFailure.message}. Modeler was left untouched.`;
		warnings.push(warning);
		lines.push(`  Warning: ${warning}`);
	}

	for (const failure of inventory.blueprintPlanningFailures) {
		const warning = `Could not inspect setup blueprint marker in ${failure.directory}: ${failure.message}. That project was left untouched.`;
		warnings.push(warning);
		lines.push(`  Warning: ${warning}`);
	}

	for (const skill of inventory.skills) {
		items.push({
			type: "skill",
			harness: skill.harness,
			name: skill.name,
			path: skill.path,
		});
		lines.push(
			`  Remove Camunda skill "${skill.name}" for ${skill.harness} (${skill.path}; all contents will be removed)`,
		);
	}

	if (inventory.modeler) {
		items.push({
			type: "modeler",
			action: "remove",
			message: inventory.modeler.message,
		});
		lines.push(`  ${modelerRemovalLine(inventory.modeler.message)}`);
	}

	for (const blueprint of inventory.blueprints) {
		const files = [...new Set([...blueprint.files, ".c8ctl-blueprint.json"])];
		items.push({
			type: "blueprint",
			id: blueprint.blueprint.id,
			name: blueprint.blueprint.name,
			directory: blueprint.directory,
			files,
		});
		lines.push(
			`  Remove ${blueprint.blueprint.name} blueprint files from ${blueprint.directory}:`,
		);
		for (const file of files) lines.push(`    ${file}`);
	}

	if (stopCluster) {
		items.push({ type: "local-cluster", action: "stop" });
		lines.push(
			"  Stop the local cluster with `c8ctl cluster stop` (downloaded binaries and runtime data will be kept)",
		);
	}

	if (items.length === 0)
		lines.push("  No setup-managed components were found.");
	lines.push(
		"  Listed skill directories and blueprint files may contain local edits; those contents will be removed. Untracked blueprint files are kept.",
	);
	lines.push("Nothing was removed.");

	return {
		text: lines.join("\n"),
		payload: {
			command: "setup",
			action: "remove",
			preview: true,
			items,
			...(warnings.length > 0 ? { warnings } : {}),
		},
	};
}

function removalFailure(ctx: PluginCtx, action: string, error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	ctx.logger.error(`Could not ${action}: ${message}`);
}

async function applySetupRemoval(
	ctx: PluginCtx,
	inventory: SetupRemovalInventory,
	stopCluster: boolean,
): Promise<void> {
	const { logger } = ctx;
	let failures =
		inventory.mcpPlanningFailures.length +
		inventory.skillDiscoveryFailures.length +
		inventory.blueprintPlanningFailures.length +
		(inventory.modelerInspectionFailure ? 1 : 0);
	for (const failure of inventory.mcpPlanningFailures) {
		logger.error(
			`Could not inspect MCP configuration for ${failure.harness}: ${failure.message}. That configuration was left untouched.`,
		);
	}
	for (const failure of inventory.skillDiscoveryFailures) {
		logger.error(
			`Could not inspect Camunda skills for ${failure.harness}: ${failure.message}. Those skills were left untouched.`,
		);
	}
	for (const failure of inventory.blueprintPlanningFailures) {
		logger.error(
			`Could not inspect setup blueprint marker in ${failure.directory}: ${failure.message}. That project was left untouched.`,
		);
	}
	if (inventory.modelerInspectionFailure) {
		logger.error(
			`Could not inspect the Camunda Desktop Modeler installation: ${inventory.modelerInspectionFailure.message}. Modeler was left untouched.`,
		);
	}

	if (stopCluster) {
		try {
			await spawnClusterStop(ctx);
			logger.info(
				"Stopped the local cluster; downloaded binaries and runtime data were kept.",
				{ essential: true },
			);
		} catch (error) {
			failures += 1;
			removalFailure(ctx, "stop the local cluster", error);
		}
	}

	// The mcp plugin owns MCP teardown. One child per harness keeps a
	// single unreadable config from blocking the other harnesses; the
	// child's own output is redundant next to the per-server lines below,
	// which mirror the previewed inventory. The child is scoped to the
	// previewed targets: a managed entry added while the confirmation was
	// open belongs to a target the user never confirmed, so --docs or
	// --orchestration is omitted accordingly. A selected entry that becomes
	// foreign after the preview makes the child fail instead of being
	// preserved silently and reported as removed.
	for (const { plan, servers } of inventory.mcp) {
		if (servers.length === 0) continue; // preserved-only: nothing to remove
		const targets = [
			servers.includes("camunda-docs") ? "--docs" : undefined,
			servers.some((server) => server !== "camunda-docs")
				? "--orchestration"
				: undefined,
		].filter((flag) => flag !== undefined);
		try {
			await spawnC8ctl(
				ctx,
				["mcp", "uninstall", plan.harness, ...targets],
				// stderr stays visible: a failing child's diagnostics are
				// otherwise suppressed with the rest of the quiet output.
				{ skipStdoutLine: () => true, stderrPassthrough: true },
			);
			for (const server of servers) {
				logger.info(
					`Removed MCP server "${server}" for ${plan.harness} from ${plan.path}.`,
					{ essential: true },
				);
			}
		} catch (error) {
			failures += 1;
			removalFailure(
				ctx,
				`remove MCP configuration for ${plan.harness} (${plan.path})`,
				error,
			);
		}
	}

	// The skills plugin owns skill removal — including its
	// revalidation-before-delete check. One child per harness, mirroring
	// the install step's failure granularity. Pass every confirmed
	// name/path pair: a same-named skill installed while confirmation was
	// open is outside the preview and must remain untouched.
	for (const harness of new Set(
		inventory.skills.map((skill) => skill.harness),
	)) {
		const skills = inventory.skills.filter(
			(skill) => skill.harness === harness,
		);
		const names = skills.map((skill) => skill.name);
		const skillPaths = skills.flatMap((skill) => ["--skill-path", skill.path]);
		try {
			await spawnC8ctl(
				ctx,
				[
					"skills",
					"uninstall",
					...names,
					"--harness",
					harness,
					...skillPaths,
					"--yes",
				],
				{
					skipStdoutLine: (line) =>
						line === "Skills removal preview:" ||
						line.startsWith("  Remove Camunda skill") ||
						line === "Skills removal finished.",
					promoteStdoutLine: (line) => line.startsWith("Removed Camunda skill"),
					stderrPassthrough: true,
				},
			);
		} catch (error) {
			failures += 1;
			removalFailure(ctx, `remove Camunda skills for ${harness}`, error);
		}
	}

	// The modeler plugin owns Modeler teardown. The inventory probe ran
	// its dry run, so a child that now finds nothing reports a no-op
	// instead of failing.
	if (inventory.modeler) {
		try {
			await spawnC8ctl(ctx, ["modeler", "uninstall"], {
				promoteStdoutLine: (line) => line.includes("Modeler"),
				// Registration-cleanup warnings and failure diagnostics ride
				// stderr — keep them visible in quiet removal runs.
				stderrPassthrough: true,
				extraEnv: {
					C8CTL_SETUP_MODELER_REMOVAL_TARGET: JSON.stringify(
						inventory.modeler.target,
					),
				},
			});
		} catch (error) {
			failures += 1;
			removalFailure(ctx, "remove Camunda Desktop Modeler", error);
		}
	}

	for (const blueprint of inventory.blueprints) {
		try {
			const result = removeSetupBlueprint(blueprint);
			if (result.remainingFiles.length > 0) {
				throw new Error(
					`Marker-listed files could not be removed: ${result.remainingFiles.join(", ")}.`,
				);
			}
			logger.info(
				`Removed ${blueprint.blueprint.name} blueprint files from ${blueprint.directory}.`,
				{ essential: true },
			);
			if (result.directoryExists) {
				const message =
					resolve(blueprint.directory) === resolve(process.cwd())
						? `Kept ${blueprint.directory} because it is the current working directory.`
						: `Kept untracked files in ${blueprint.directory}; remove them manually if desired.`;
				logger.info(message, { essential: true });
			}
		} catch (error) {
			failures += 1;
			removalFailure(
				ctx,
				`remove the ${blueprint.blueprint.name} blueprint from ${blueprint.directory}`,
				error,
			);
		}
	}

	if (failures > 0) {
		process.exitCode = 1;
		logger.info(`Setup removal finished with ${failures} failed action(s).`, {
			essential: true,
		});
	} else {
		logger.info("Setup removal finished.", { essential: true });
	}
}

async function runSetupRemoval(
	ctx: PluginCtx,
	stopCluster: boolean,
): Promise<void> {
	const { logger } = ctx;
	const inventory = await inspectSetupRemovalInventory({
		detectModeler: detectModelerRemoval,
	});
	const preview = setupRemovalPreview(inventory, stopCluster);
	const jsonMode = logger.mode === "json";

	if (ctx.dryRun || jsonMode) {
		logger.json({
			...(ctx.dryRun ? { dryRun: true } : {}),
			...preview.payload,
		});
		return;
	}

	logger.output(preview.text);
	if (preview.payload.items.length === 0) {
		if (
			inventory.mcpPlanningFailures.length > 0 ||
			inventory.skillDiscoveryFailures.length > 0 ||
			inventory.blueprintPlanningFailures.length > 0 ||
			inventory.modelerInspectionFailure
		) {
			process.exitCode = 1;
		}
		return;
	}

	const interactive = !ctx.quiet && ctx.prompt.isInteractive() && !ctx.yes;
	if (interactive) {
		const confirmation = await ctx.prompt.select({
			message: "Remove the listed setup components?",
			options: [
				{ label: "Keep these components", value: false },
				{ label: "Remove the listed components", value: true },
			],
		});
		if (confirmation.cancelled || !confirmation.value) {
			logger.info("Cancelled — nothing was removed.", { essential: true });
			return;
		}
	} else if (!ctx.yes) {
		const command = [
			"c8ctl",
			"setup",
			"--remove",
			...(stopCluster ? ["--stop-cluster"] : []),
			"--yes",
		].join(" ");
		logger.info(`Nothing was removed. Run "${command}" to confirm.`, {
			essential: true,
		});
		return;
	}

	await applySetupRemoval(ctx, inventory, stopCluster);
}

// ── The command ────────────────────────────────────────────────────

async function runSetup(ctx: PluginCtx, flags: SetupFlags): Promise<void> {
	const { logger } = ctx;

	if (flags["stop-cluster"] && !flags.remove) {
		throw new Error("--stop-cluster can only be used with --remove.");
	}
	if (flags.remove) {
		if (flags.modeler || flags["no-modeler"] || flags["docs-mcp"]) {
			throw new Error(
				"--remove cannot be combined with --modeler, --no-modeler, or --docs-mcp.",
			);
		}
		await runSetupRemoval(ctx, flags["stop-cluster"] === true);
		return;
	}

	// Custom dry-run payload: setup performs local installs, not one API call.
	if (ctx.dryRun) {
		const selected = applyComponentFlags(defaultSelection(), flags);
		logger.json({
			dryRun: true,
			...setupPlanPayload(selected, {
				blueprint: effectiveBlueprint(selected),
			}),
		});
		return;
	}

	const jsonMode = logger.mode === "json";
	// JSON mode never prompts: the plan payload must not block on a TTY menu.
	const interactive =
		!jsonMode && ctx.prompt.isInteractive() && !ctx.yes && !ctx.quiet;
	// The step report goes to stdout — color its status tags only when
	// stdout is a terminal, so piped output stays plain text.
	const color = process.stdout.isTTY === true;

	// The banner is UI chrome: hidden by --quiet, omitted in JSON mode.
	if (!jsonMode && !ctx.quiet) {
		const banner = renderWelcomeBanner({ color: interactive });
		if (interactive) {
			process.stderr.write(`${banner}\n`);
		} else {
			logger.output(banner);
		}
	}

	let selected: ReadonlySet<SetupComponentId>;
	if (interactive) {
		const result = await ctx.prompt.multiSelect({
			message: "What should we set up for you?",
			options: SETUP_COMPONENTS.map((c) => ({
				label: c.label,
				description: c.why,
				value: c.id,
				checked: c.defaultSelected,
				group: c.group,
				requires: c.requires?.map((r) => ({ value: r.id, reason: r.reason })),
			})),
		});
		if (result.cancelled) {
			logger.info("Cancelled — nothing was changed.");
			return;
		}
		selected = new Set(result.values);
	} else {
		selected = defaultSelection();
	}
	selected = applyComponentFlags(selected, flags);

	// Every question comes before any work: pick the blueprint next.
	let blueprintId = effectiveBlueprint(selected);
	if (selected.has("blueprint") && interactive) {
		const choice = await ctx.prompt.select({
			message: "Which starter blueprint should we install?",
			options: SETUP_BLUEPRINTS.map((b) => ({
				label: b.name,
				description: `${b.description} — guide: ${b.guideUrl}`,
				value: b.id,
			})),
		});
		if (choice.cancelled) {
			logger.info("Cancelled — nothing was changed.");
			return;
		}
		blueprintId = choice.value;
	}

	if (jsonMode) {
		logger.json(setupPlanPayload(selected, { blueprint: blueprintId }));
		return;
	}

	// Without an interactive selection or --yes there is no go-ahead:
	// stop before any work, so a piped run never installs anything.
	if (!interactive && !ctx.yes) {
		logger.info(
			'Nothing was installed. Run "c8ctl setup --yes" to set everything up, or run interactively to choose what gets installed.',
		);
		return;
	}

	// No surprise browser windows: the docs MCP sign-in opens one when
	// the assistant first connects, so say so before the first step runs.
	// (The cluster start opens Operate the same way a plain "c8ctl
	// cluster start" does.)
	if (selected.has("docs-mcp")) {
		logger.info(
			"Heads up: the docs MCP server needs you to sign in — your AI assistant will open a browser window for it when it connects.",
			{ essential: true },
		);
	}

	const { failures, run } = await executePlan(ctx, selected, blueprintId, {
		color,
	});

	// The takeaway of the whole run, boxed so it stands apart from the
	// step report above it. A blueprint owns its actionable lines (what
	// the run left behind, what to do with it); without one but with a
	// running cluster, point at the first process run instead.
	const nextSteps: string[] = [];
	if (run.blueprintDir) {
		const blueprint = setupBlueprintById(
			run.blueprintId ?? SETUP_BLUEPRINTS[0].id,
		);
		// Outcome lines describe the started instance — claim them only
		// when the deploy step actually started one. On a failed deploy
		// the Project/Guide references below still apply.
		if (run.processInstanceKey !== undefined) {
			nextSteps.push(
				...blueprint.nextSteps({
					projectDir: run.blueprintDir,
					processInstanceKey: run.processInstanceKey,
				}),
			);
		}
		nextSteps.push(`Project: ${run.blueprintDir}`);
		nextSteps.push(`Guide: ${blueprint.guideUrl}`);
	} else if (run.clusterStarted) {
		// Both suggestions pin the local profile and its <default> tenant —
		// the session's active profile and tenant may point at a remote
		// cluster. Two lines: && is a syntax error in Windows
		// PowerShell 5.1.
		nextSteps.push("Run your first process:");
		nextSteps.push('  c8ctl use tenant "<default>"');
		nextSteps.push("  c8ctl run my-process.bpmn --profile local");
		nextSteps.push('Or re-run "c8ctl setup" and pick a starter blueprint.');
	}
	if (run.clusterStarted) {
		nextSteps.push("Operate: http://localhost:8080/operate (demo/demo)");
	}
	if (nextSteps.length > 0) {
		logger.info(
			`\n${renderNextSteps(nextSteps, { color, maxWidth: process.stdout.columns || undefined })}`,
			{ essential: true },
		);
	}

	if (failures > 0) {
		logger.info(
			`Setup finished with ${failures} failed step(s). Fix the cause and re-run c8ctl setup — finished work is picked up, not repeated.`,
			{ essential: true },
		);
		process.exitCode = 1;
		return;
	}

	logger.success("Setup finished.");
}

async function setupHandler(
	_args: string[],
	flagsRecord: Record<string, unknown> | undefined,
	ctx?: PluginCtx,
): Promise<void> {
	if (!ctx) throw new Error("setup requires the plugin host context");
	const flags: SetupFlags = {
		modeler: flagsRecord?.modeler === true,
		"no-modeler": flagsRecord?.["no-modeler"] === true,
		"docs-mcp": flagsRecord?.["docs-mcp"] === true,
		remove: flagsRecord?.remove === true,
		"stop-cluster": flagsRecord?.["stop-cluster"] === true,
	};
	try {
		await runSetup(ctx, flags);
	} catch (error) {
		renderCommandFailure(ctx.logger, "Failed to setup", error, {
			verbose: ctx.verbose,
		});
		process.exitCode = 1;
	}
}

const SETUP_HELP_DESCRIPTION = `Guided first-run setup: install a local cluster, a starter blueprint project, and AI assistant tooling.

The wizard offers to start a local cluster (downloading Camunda 8 Run on first run), install Desktop Modeler, create a starter project from a blueprint, deploy and run it, and set up AI assistant tooling. Nothing is installed without your say.

Each step announces its title and ends in [SUCCESS], [ERROR] or [SKIPPED]; a step's own output is shown only when it fails, and a failed step does not stop the rest. The blueprint and the cluster MCP server need the local cluster — deselect the cluster and both options are disabled.

A browser window opens when the local cluster reports healthy; the docs MCP server asks you to sign in in a browser on first use — announced up front.

A run without a selection (piped output, CI) installs nothing unless you pass --yes; --json prints the plan without executing. The starter blueprint is chosen in the wizard; a non-interactive --yes run uses Rocket Launch.

Exit code 0: every selected setup step succeeded, or nothing was installed for lack of a go-ahead (wizard cancelled with Escape; a piped, --quiet or JSON-mode run without --yes; --json or --dry-run printing the plan). Ctrl+C ends the wizard by signal (130 on POSIX shells). A re-run reuses finished work where possible; the deploy, process start and skills install repeat by design. Exit code 1: arguments failed validation, or a step failed — other eligible steps still ran, while dependents (and the deploy finale after any failure) were skipped.

--remove shows setup-managed MCP entries, Camunda skills, a c8ctl-managed Desktop Modeler installation, and marker-listed blueprint files before removing them. Confirm in the interactive prompt or pass --yes in non-interactive use. --json and --dry-run print only the removal preview. Removal runs the owning commands: mcp uninstall, skills uninstall, and modeler uninstall. Local edits in skill folders and listed blueprint files are removed; untracked blueprint files are kept. --remove cannot be combined with --modeler, --no-modeler, or --docs-mcp.

--stop-cluster is available only with --remove. It stops the local cluster without purging runtime data or deleting downloaded binaries.

Removal exits 0 when every requested action succeeds, and 1 if any action fails; the other removal actions still run.`;

export const metadata: PluginMetadata = {
	name: "setup",
	description: "Guided first-run setup for local Camunda 8 development",
	commands: {
		setup: {
			description: "Guided first-run setup for local Camunda 8 development",
			helpDescription: SETUP_HELP_DESCRIPTION,
			examples: [
				{
					command: "c8ctl setup",
					description: "Run the guided setup wizard",
				},
				{
					command: "c8ctl setup --yes",
					description: "Set up the defaults, without prompting",
				},
				{
					command: "c8ctl setup --remove",
					description: "Preview setup-managed components to remove",
				},
				{
					command: "c8ctl setup --remove --yes",
					description: "Remove the previewed setup-managed components",
				},
				{
					command: "c8ctl setup --remove --stop-cluster --yes",
					description: "Also stop the local cluster without purging its data",
				},
			],
		},
	},
};

export const commands: PluginCommands = {
	setup: {
		flags: {
			modeler: {
				type: "boolean",
				description: "Install Desktop Modeler, whatever the selection",
			},
			"no-modeler": {
				type: "boolean",
				description: "Do not install Desktop Modeler",
			},
			"docs-mcp": {
				type: "boolean",
				description:
					"Also configure the docs MCP server (off unless selected or flagged)",
			},
			remove: {
				type: "boolean",
				description:
					"Preview and remove setup-managed MCP entries, skills, Modeler, and blueprint files",
			},
			"stop-cluster": {
				type: "boolean",
				description:
					"With --remove, stop the local cluster without purging its data",
			},
		},
		handler: setupHandler,
	},
};
