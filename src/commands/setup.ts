/**
 * `c8ctl setup` — guided first-run setup for local Camunda 8 development.
 *
 * Skeleton: prints the welcome banner and the ordered plan, offers an
 * interactive checkbox list of what to set up, and prints the tailored
 * plan. No step executes yet — each later issue wires its own step.
 *
 * Streams: the banner and prompts are UI chrome on stderr; the plan is
 * the command's answer on stdout (text or JSON). Non-interactive runs
 * (pipe, CI, --yes) skip the prompt and plan with the defaults.
 */

import {
	defineCommand,
	isInteractive,
	multiSelect,
} from "../framework/index.ts";
import {
	defaultSelection,
	renderSetupPlan,
	renderWelcomeBanner,
	SETUP_COMPONENTS,
	type SetupComponentId,
	setupPlanPayload,
} from "../utils/index.ts";

export const setupCommand = defineCommand("setup", "", async (ctx) => {
	const { logger } = ctx;

	// Custom dry-run payload: setup performs local installs, not one API call.
	if (ctx.isDryRun) {
		logger.json({
			dryRun: true,
			...setupPlanPayload(defaultSelection()),
		});
		return { kind: "none" };
	}

	const interactive = isInteractive() && !ctx.yes && !ctx.quiet;
	const color = interactive;
	const jsonMode = logger.mode === "json";

	// The banner is UI chrome: hidden by --quiet, omitted in JSON mode.
	if (!jsonMode && !ctx.quiet) {
		const banner = renderWelcomeBanner({ color });
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

	if (jsonMode) {
		logger.json(setupPlanPayload(selected));
	} else {
		logger.output(renderSetupPlan(selected, { color }));
		if (!interactive && !ctx.yes) {
			logger.info("Hint: run interactively to choose what gets installed.");
		}
	}
	return { kind: "none" };
});
