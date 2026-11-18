/**
 * `c8ctl setup` — guided first-run setup for local Camunda 8 development.
 *
 * Prints the welcome banner, asks what to set up (checkbox list with
 * dependencies plus a blueprint choice), then runs every selected step.
 * Each step ends in a `[SUCCESS]`, `[ERROR]` or `[SKIPPED]` line in an
 * aligned column (green, red and dim on a terminal); a failed step
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
 */

import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import {
	ProcessDefinitionId,
	TenantId,
} from "@camunda8/orchestration-cluster-api";
import { createClient, DEFAULT_PROFILE, SilentError } from "../core/index.ts";
import {
	type CommandContext,
	defineCommand,
	isInteractive,
	multiSelect,
	select,
} from "../framework/index.ts";
import {
	CAMUNDA_SKILLS_REPOSITORY,
	checkLocalClusterHealth,
	checkPrerequisites,
	createLineForwarder,
	defaultSelection,
	detectInstalledHarnesses,
	enforceComponentDependencies,
	formatStepResult,
	formatStepStatusSuffix,
	isClusterProgressLine,
	MANUAL_SETUP_LINKS,
	planMcpConfigs,
	renderWelcomeBanner,
	runSkillInstall,
	SETUP_BLUEPRINTS,
	SETUP_COMPONENTS,
	SETUP_STEPS,
	type SetupComponentId,
	type SetupStepId,
	scaffoldSetupBlueprint,
	setupBlueprintById,
	setupPlanPayload,
	writeMcpConfig,
} from "../utils/index.ts";
import { deployResources } from "./helpers/deploy-helpers.ts";
import { buildMcpConnection } from "./mcp.ts";
import { installDesktopModeler } from "./modeler.ts";
import { extractProcessId } from "./run.ts";

/** Flags the setup handler reads, as declared in the command registry. */
interface SetupFlags {
	readonly blueprint?: string;
	readonly modeler?: boolean;
	readonly "no-modeler"?: boolean;
	readonly "docs-mcp"?: boolean;
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
}

/**
 * Explicit flags override the checkbox selection: --no-modeler wins.
 * Dependencies are then re-enforced, so a flag cannot resurrect a
 * component whose requirement is deselected (e.g. --blueprint without
 * the local cluster).
 */
function applyComponentFlags(
	selected: ReadonlySet<SetupComponentId>,
	flags: SetupFlags,
): Set<SetupComponentId> {
	const next = new Set(selected);
	if (flags["no-modeler"]) next.delete("modeler");
	else if (flags.modeler) next.add("modeler");
	if (flags.blueprint !== undefined) next.add("blueprint");
	if (flags["docs-mcp"]) next.add("docs-mcp");
	return enforceComponentDependencies(next);
}

/** The blueprint a non-interactive run would install: the flag, else the first. */
function effectiveBlueprint(
	selected: ReadonlySet<SetupComponentId>,
	flags: SetupFlags,
): string | undefined {
	if (!selected.has("blueprint")) return undefined;
	return flags.blueprint ?? SETUP_BLUEPRINTS[0].id;
}

// ── Step executors ─────────────────────────────────────────────────

type StepExecutor = (
	ctx: CommandContext,
	run: SetupRun,
) => Promise<void> | void;

async function runPrerequisites(ctx: CommandContext): Promise<void> {
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

/** The CLI's own entry point, for self-invoking plugin commands. */
const CLI_ENTRY = realpathSync(
	resolve(import.meta.dirname, `../index${extname(import.meta.filename)}`),
);

/**
 * The cluster command lives in the built-in cluster plugin, which owns
 * process exit on failure — so setup runs it as a child process and maps
 * the exit code onto the step result. `cluster start` downloads Camunda 8
 * Run on first run, so this one step covers install and start.
 *
 * The child's stdout is streamed through a line filter that drops the
 * download progress lines (`//> 42% …`) and feeds the step's output
 * buffer (via ctx.logger) — it surfaces only when the step fails.
 * stderr passes through immediately: the plugin's warnings and failure
 * diagnostics are actionable either way. The child is pinned to text
 * mode so its lines stay plain and filterable no matter the session's
 * output mode.
 */
function spawnClusterStart(ctx: CommandContext): Promise<void> {
	return new Promise((resolvePromise, rejectPromise) => {
		const child = spawn(process.execPath, [CLI_ENTRY, "cluster", "start"], {
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, C8CTL_OUTPUT_MODE: "text" },
		});
		const forward = (stream: "stdout" | "stderr", essential: boolean) =>
			createLineForwarder({
				write: (line) => ctx.logger.info(line, { stream, essential }),
				skip: isClusterProgressLine,
			});
		const out = forward("stdout", false);
		const err = forward("stderr", true);
		child.stdout?.setEncoding("utf-8");
		child.stderr?.setEncoding("utf-8");
		child.stdout?.on("data", (chunk: string) => out.push(chunk));
		child.stderr?.on("data", (chunk: string) => err.push(chunk));
		child.on("error", (error) =>
			rejectPromise(
				new Error(`Could not run c8ctl cluster start: ${error.message}`),
			),
		);
		child.on("close", (code) => {
			out.flush();
			err.flush();
			if (code === 0) {
				resolvePromise();
			} else {
				rejectPromise(
					new Error(`c8ctl cluster start failed (exit code ${code}).`),
				);
			}
		});
	});
}

/** c8run's launcher exits before the services report healthy — poll for it. */
const CLUSTER_HEALTH_TIMEOUT_MS = 120_000;
const CLUSTER_HEALTH_POLL_MS = 2_000;

async function runClusterStart(
	ctx: CommandContext,
	run: SetupRun,
): Promise<void> {
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

async function runModelerInstall(ctx: CommandContext): Promise<void> {
	// Always quiet: the installer's progress chatter is noise next to the
	// step report — the step's status line is the signal. Failures still
	// throw with diagnostics.
	await installDesktopModeler({
		isDryRun: false,
		logger: ctx.logger,
		quiet: true,
	});
}

async function runBlueprintScaffold(
	ctx: CommandContext,
	run: SetupRun,
): Promise<void> {
	const id = run.blueprintId ?? SETUP_BLUEPRINTS[0].id;
	const scaffolded = await scaffoldSetupBlueprint({
		id,
		onProgress: (event) => ctx.logger.info(event.message),
	});
	run.blueprintDir = scaffolded.directory;
	ctx.logger.info(`Project ready at ${scaffolded.directory}`);
}

async function runBlueprintDeploy(
	ctx: CommandContext,
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
	// built-in local profile and its default tenant. An explicit profile
	// and tenant win over the session and CAMUNDA_* env vars, so neither
	// a remote active profile nor a preselected tenant can redirect the
	// first-run deployment.
	await deployResources([deployDir], {
		profile: DEFAULT_PROFILE,
		basePath: directory,
		verbose: ctx.verbose,
		tenantId: LOCAL_TENANT_ID,
		// The step report is the signal; its progress render is noise here.
		// The step's buffered logger routes failure diagnostics through the
		// title-closing hook instead of colliding with the open title line.
		quiet: true,
		suppressSkippedLog: true,
		logger: ctx.logger,
	});

	if (blueprint.startNote) {
		logger.info(
			`The ${blueprint.name} process is deployed but not started: it ${blueprint.startNote}`,
			{ essential: true },
		);
		logger.info(`Guide: ${blueprint.guideUrl}`, { essential: true });
		return;
	}

	const processFile = join(directory, blueprint.processFile);
	const processId = extractProcessId(readFileSync(processFile, "utf-8"));
	if (!processId) {
		throw new Error(`Could not find a process id in ${blueprint.processFile}.`);
	}
	logger.info(`Starting a ${blueprint.name} process instance...`);
	const created = await createClient(DEFAULT_PROFILE).createProcessInstance({
		processDefinitionId: ProcessDefinitionId.assumeExists(processId),
		tenantId: TenantId.assumeExists(LOCAL_TENANT_ID),
		...(blueprint.startVariables !== undefined && {
			variables: blueprint.startVariables,
		}),
	});
	logger.info(`Process instance created: ${created.processInstanceKey}`);
}

const NO_HARNESS_HINT =
	"Install Claude Code, GitHub Copilot CLI or Cursor, then re-run c8ctl setup.";

async function runSkillsInstall(ctx: CommandContext): Promise<void> {
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
			`Installing Camunda skills (${CAMUNDA_SKILLS_REPOSITORY}) for ${harness}…`,
			{ essential: true },
		);
		runSkillInstall(harness);
	}
}

function runMcpInstall(docs: boolean): StepExecutor {
	return (ctx) => {
		const plans = planMcpConfigs({
			requested: [],
			operation: "install",
			docs,
			orchestration: !docs,
			alias: "camunda",
			connection: docs ? undefined : buildMcpConnection(DEFAULT_PROFILE),
		});
		for (const plan of plans) {
			writeMcpConfig(plan);
			ctx.logger.info(`MCP configuration: ${plan.harness} (${plan.path})`, {
				essential: true,
			});
		}
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

/** planMcpConfigs throws this when the machine has no known harness. */
function isNoHarnessError(error: unknown): boolean {
	return (
		error instanceof Error &&
		error.message.startsWith("No supported MCP harness was detected")
	);
}

function guardedMcpInstall(docs: boolean): StepExecutor {
	const executor = runMcpInstall(docs);
	return async (ctx, run) => {
		try {
			await executor(ctx, run);
		} catch (error) {
			if (isNoHarnessError(error)) {
				ctx.logger.info(
					`No supported AI coding harness detected — nothing to configure. ${NO_HARNESS_HINT}`,
					{ essential: true },
				);
				return;
			}
			throw error;
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
	"cluster-mcp": guardedMcpInstall(false),
	"docs-mcp": guardedMcpInstall(true),
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
 * warnings and errors pass through immediately — `onPassthrough` runs
 * first, so the step's title line can be closed before they print.
 */
function withBufferedOutput(
	ctx: CommandContext,
	buffer: BufferedLine[],
	onPassthrough: () => void,
): CommandContext {
	const { logger } = ctx;
	const bufferedLogger = Object.create(logger, {
		info: {
			value: (
				message: string,
				options?: { stream?: "stdout" | "stderr"; essential?: boolean },
			) => {
				if (options?.essential) {
					onPassthrough();
					logger.info(message, options);
				} else {
					buffer.push({ message, stream: options?.stream });
				}
			},
		},
		warn: {
			value: (message: string) => {
				onPassthrough();
				logger.warn(message);
			},
		},
		error: {
			value: (message: string, error?: Error) => {
				onPassthrough();
				logger.error(message, error);
			},
		},
		success: {
			value: (message: string, key?: string | number) => {
				onPassthrough();
				logger.success(message, key);
			},
		},
	});
	return { ...ctx, logger: bufferedLogger };
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
	ctx: CommandContext,
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
		if (unmet.length > 0) {
			logger.info(formatStepResult(step.title, "skipped", width, { color }), {
				essential: true,
			});
			const names = unmet
				.map((dep) => SETUP_STEPS.find((s) => s.id === dep)?.title ?? dep)
				.join(", ");
			logger.info(`    needs: ${names}`, { essential: true });
			continue;
		}

		// The title line stays open: the status tag completes it. Essential
		// step output closes it first, so it never garbles mid-line.
		let titleOpen = false;
		if (!ctx.quiet) {
			process.stdout.write(`  ${step.title}`);
			titleOpen = true;
		}
		const closeTitle = () => {
			if (titleOpen) {
				process.stdout.write("\n");
				titleOpen = false;
			}
		};
		const reportStatus = (status: "success" | "error") => {
			if (titleOpen) {
				process.stdout.write(
					`${formatStepStatusSuffix(step.title, status, width, { color })}\n`,
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
				withBufferedOutput(ctx, buffered, closeTitle),
				run,
			);
			succeeded.add(step.id);
			reportStatus("success");
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
			// A SilentError was already rendered in full by its helper
			// (e.g. the deploy diagnostics) — don't print the summary again.
			if (!(error instanceof SilentError)) {
				const message = error instanceof Error ? error.message : String(error);
				for (const line of message.split("\n")) {
					logger.info(`    ${line}`, { essential: true });
				}
			}
		}
	}
	return { failures, run };
}

// ── The command ────────────────────────────────────────────────────

export const setupCommand = defineCommand("setup", "", async (ctx, flags) => {
	const { logger } = ctx;

	// Validate --blueprint up front, in every mode: an unknown id fails
	// identically in preview, JSON and execution runs.
	if (flags.blueprint !== undefined) setupBlueprintById(flags.blueprint);

	// Custom dry-run payload: setup performs local installs, not one API call.
	if (ctx.isDryRun) {
		const selected = applyComponentFlags(defaultSelection(), flags);
		logger.json({
			dryRun: true,
			...setupPlanPayload(selected, {
				blueprint: effectiveBlueprint(selected, flags),
			}),
		});
		return { kind: "none" };
	}

	const jsonMode = logger.mode === "json";
	// JSON mode never prompts: the plan payload must not block on a TTY menu.
	const interactive = !jsonMode && isInteractive() && !ctx.yes && !ctx.quiet;
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
		const result = await multiSelect({
			message: "What should we set up for you?",
			options: SETUP_COMPONENTS.map((c) => ({
				label: c.label,
				description: c.why,
				value: c.id,
				checked: c.defaultSelected,
				requires: c.requires?.map((r) => ({ value: r.id, reason: r.reason })),
			})),
		});
		if (result.cancelled) {
			logger.info("Cancelled — nothing was changed.");
			return { kind: "none" };
		}
		selected = new Set(result.values);
	} else {
		selected = defaultSelection();
	}
	selected = applyComponentFlags(selected, flags);
	if (flags.blueprint !== undefined && !selected.has("blueprint")) {
		// The flag asked for a blueprint but its dependency was deselected.
		logger.info("--blueprint is ignored: the local cluster is not selected.", {
			essential: true,
		});
	}

	// Every question comes before any work: pick the blueprint next.
	let blueprintId = effectiveBlueprint(selected, flags);
	if (
		selected.has("blueprint") &&
		flags.blueprint === undefined &&
		interactive
	) {
		const choice = await select({
			message: "Which starter blueprint should we install?",
			options: SETUP_BLUEPRINTS.map((b) => ({
				label: b.name,
				description: `${b.description} — guide: ${b.guideUrl}`,
				value: b.id,
			})),
		});
		if (choice.cancelled) {
			logger.info("Cancelled — nothing was changed.");
			return { kind: "none" };
		}
		blueprintId = choice.value;
	}

	if (jsonMode) {
		logger.json(setupPlanPayload(selected, { blueprint: blueprintId }));
		return { kind: "none" };
	}

	// Without an interactive selection or --yes there is no go-ahead:
	// stop before any work, so a piped run never installs anything.
	if (!interactive && !ctx.yes) {
		logger.info(
			'Nothing was installed. Run "c8ctl setup --yes" to set everything up, or run interactively to choose what gets installed.',
		);
		return { kind: "none" };
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
	if (run.blueprintDir) {
		const blueprint = setupBlueprintById(
			run.blueprintId ?? SETUP_BLUEPRINTS[0].id,
		);
		logger.info(
			`Your project is at ${run.blueprintDir} — follow the guide: ${blueprint.guideUrl}`,
			{ essential: true },
		);
	}
	if (run.clusterStarted) {
		logger.info(
			"Operate: http://localhost:8080/operate — log in with demo/demo",
			{
				essential: true,
			},
		);
	}
	if (failures > 0) {
		logger.info(
			`Setup finished with ${failures} failed step(s). Fix the cause and re-run c8ctl setup.`,
			{ essential: true },
		);
		logger.info(
			"Note: an existing blueprint project directory is kept as-is and blocks re-scaffolding — remove it to scaffold again, or deploy it directly with c8ctl deploy.",
			{ essential: true },
		);
		process.exitCode = 1;
		return { kind: "none" };
	}

	logger.success("Setup finished.");
	return { kind: "none" };
});
