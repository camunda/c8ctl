/**
 * `c8ctl setup` — guided first-run setup for local Camunda 8 development.
 *
 * Prints the welcome banner, asks what to set up (checkbox list plus a
 * blueprint choice), shows the tailored plan, then executes it. Steps
 * that are not wired up yet are reported as skipped.
 *
 * Execution needs a go-ahead: an interactive selection or `--yes`. A
 * piped run without `--yes` and JSON mode print the plan only, so a
 * script never installs software by accident.
 *
 * Streams: the banner, prompts and progress are UI chrome on stderr; the
 * plan and the JSON payload are the command's answer on stdout.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	ProcessDefinitionId,
	TenantId,
} from "@camunda8/orchestration-cluster-api";
import {
	createClient,
	DEFAULT_PROFILE,
	resolveTenantId,
	SilentError,
} from "../core/index.ts";
import {
	type CommandContext,
	defineCommand,
	isInteractive,
	multiSelect,
	select,
} from "../framework/index.ts";
import {
	checkLocalClusterHealth,
	checkPrerequisites,
	defaultSelection,
	formatPrerequisiteFailures,
	renderSetupPlan,
	renderWelcomeBanner,
	SETUP_BLUEPRINTS,
	SETUP_COMPONENTS,
	SETUP_STEPS,
	type SetupComponentId,
	type SetupStepId,
	scaffoldSetupBlueprint,
	setupBlueprintById,
	setupPlanPayload,
} from "../utils/index.ts";
import { deployResources } from "./helpers/deploy-helpers.ts";
import { installDesktopModeler } from "./modeler.ts";
import { extractProcessId } from "./run.ts";

/** Flags the setup handler reads, as declared in the command registry. */
interface SetupFlags {
	readonly blueprint?: string;
	readonly modeler?: boolean;
	readonly "no-modeler"?: boolean;
}

/** State one step hands to a later one. */
interface SetupRun {
	blueprintId: string | undefined;
	blueprintDir?: string;
}

/** Explicit flags override the checkbox selection: --no-modeler wins. */
function applyComponentFlags(
	selected: ReadonlySet<SetupComponentId>,
	flags: SetupFlags,
): Set<SetupComponentId> {
	const next = new Set(selected);
	if (flags["no-modeler"]) next.delete("modeler");
	else if (flags.modeler) next.add("modeler");
	if (flags.blueprint !== undefined) next.add("blueprint");
	return next;
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

type StepExecutor = (ctx: CommandContext, run: SetupRun) => Promise<void>;

async function runPrerequisites(ctx: CommandContext): Promise<void> {
	const results = await checkPrerequisites();
	for (const result of results) {
		ctx.logger.info(
			`  ${result.ok ? "✓" : "✗"} ${result.title}: ${result.detail}`,
		);
	}
	if (results.some((result) => !result.ok)) {
		ctx.logger.error(formatPrerequisiteFailures(results));
		throw new SilentError("c8ctl setup prerequisites are not met");
	}
}

async function runModelerInstall(ctx: CommandContext): Promise<void> {
	const result = await installDesktopModeler({
		isDryRun: false,
		logger: ctx.logger,
		quiet: ctx.quiet,
	});
	if (result.kind === "success") {
		ctx.logger.success(result.message);
	} else if (result.kind === "info") {
		ctx.logger.info(result.message);
	}
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
	ctx.logger.success(`Project ready at ${scaffolded.directory}`);
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

	// Deploying needs a running cluster. Rather than failing on a
	// connection error, say what to do and leave the project in place.
	const health = await checkLocalClusterHealth();
	if (!health.healthy) {
		logger.warn(
			`Could not reach the local cluster (${health.detail}) — the blueprint was not deployed.`,
		);
		logger.info("Start the cluster with: c8ctl cluster start");
		// Pin the same local profile the healthy path deploys to, so the
		// recovery cannot land on a remote cluster from the session or env.
		logger.info(
			`Then deploy the project with: c8ctl deploy "${deployDir}" --profile local`,
		);
		return;
	}

	// Both mutations target the cluster the health check just probed: the
	// built-in local profile. An explicit profile name wins over the
	// session profile and CAMUNDA_* env vars, so a remote active profile
	// cannot redirect the first-run deployment.
	await deployResources([deployDir], {
		profile: DEFAULT_PROFILE,
		basePath: directory,
		verbose: ctx.verbose,
	});

	const processFile = join(directory, blueprint.processFile);
	const processId = extractProcessId(readFileSync(processFile, "utf-8"));
	if (!processId) {
		throw new Error(`Could not find a process id in ${blueprint.processFile}.`);
	}
	logger.info(`Starting a ${blueprint.name} process instance...`);
	const created = await createClient(DEFAULT_PROFILE).createProcessInstance({
		processDefinitionId: ProcessDefinitionId.assumeExists(processId),
		tenantId: TenantId.assumeExists(resolveTenantId(DEFAULT_PROFILE)),
		...(blueprint.startVariables !== undefined && {
			variables: blueprint.startVariables,
		}),
	});
	logger.success("Process instance created", created.processInstanceKey);
}

const STEP_EXECUTORS: Partial<Record<SetupStepId, StepExecutor>> = {
	prerequisites: runPrerequisites,
	"install-modeler": runModelerInstall,
	"scaffold-blueprint": runBlueprintScaffold,
	"deploy-blueprint": runBlueprintDeploy,
};

async function executePlan(
	ctx: CommandContext,
	selected: ReadonlySet<SetupComponentId>,
	blueprintId: string | undefined,
): Promise<void> {
	const { logger } = ctx;
	const run: SetupRun = { blueprintId };
	for (const step of SETUP_STEPS) {
		if (step.component !== null && !selected.has(step.component)) continue;
		const executor = STEP_EXECUTORS[step.id];
		if (!executor) {
			logger.info(`${step.title} — setup can't do this step yet; skipped.`);
			continue;
		}
		logger.info(`▸ ${step.title}`);
		await executor(ctx, run);
	}

	logger.success("Setup finished.");
	if (run.blueprintDir) {
		const blueprint = setupBlueprintById(
			run.blueprintId ?? SETUP_BLUEPRINTS[0].id,
		);
		logger.info(
			`Your project is at ${run.blueprintDir} — follow the guide: ${blueprint.guideUrl}`,
		);
	}
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
	// The plan goes to stdout — color it only when stdout is a terminal,
	// so `c8ctl setup > plan.txt` stays plain text.
	const planColor = process.stdout.isTTY === true;

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
	logger.output(renderSetupPlan(selected, { color: planColor }));

	// Without an interactive selection or --yes there is no go-ahead:
	// print the plan and stop, so a piped run never installs anything.
	if (!interactive && !ctx.yes) {
		logger.info(
			'Nothing was installed. Run "c8ctl setup --yes" to execute this plan, or run interactively to choose what gets installed.',
		);
		return { kind: "none" };
	}

	await executePlan(ctx, selected, blueprintId);
	return { kind: "none" };
});
