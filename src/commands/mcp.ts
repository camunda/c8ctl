import { realpathSync } from "node:fs";
import { extname, resolve } from "node:path";
import {
	c8ctl,
	DEFAULT_PROFILE,
	getModelerDataDir,
	getProfileOrModeler,
	getUserDataDir,
	resolveEnvBaseUrl,
} from "../core/index.ts";
import {
	type CommandContext,
	type CommandResult,
	defineCommand,
} from "../framework/index.ts";
import {
	type McpConfigPlan,
	planMcpConfigs,
	writeMcpConfig,
} from "../utils/index.ts";

function targets(flags: {
	docs?: boolean;
	orchestration?: boolean;
	alias?: string;
}) {
	const docs = flags.docs === true;
	const orchestration = flags.orchestration === true || !docs;
	const alias = flags.alias ?? "camunda";
	if (flags.alias !== undefined && !orchestration) {
		throw new Error(
			"--alias applies to orchestration. Add --orchestration or omit --alias.",
		);
	}
	if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(alias) || alias === "camunda-docs") {
		throw new Error(
			"Use an orchestration alias containing letters, digits, underscores or hyphens, starting with a letter or digit. 'camunda-docs' is reserved.",
		);
	}
	return { docs, orchestration, alias };
}

/**
 * The harness connection entry pointing at `c8ctl mcp-proxy` for a
 * profile. Exported so `c8ctl setup` can wire the cluster MCP server to
 * the local profile without going through the command wrapper.
 */
export function buildMcpConnection(
	profileFlag?: string,
): Record<string, unknown> {
	const selected = profileFlag ?? c8ctl.activeProfile;
	if (selected === undefined && resolveEnvBaseUrl()) {
		throw new Error(
			"MCP installation requires a saved profile. Save your environment with 'c8ctl add profile <name> --from-env', then pass --profile <name>.",
		);
	}
	const name = selected ?? DEFAULT_PROFILE;
	const profile = getProfileOrModeler(name);
	if (!profile) {
		throw new Error(
			`Profile '${name}' not found. Run 'c8ctl list profiles' and select one with --profile.`,
		);
	}
	const entry = {
		command: process.execPath,
		args: [
			realpathSync(
				resolve(
					import.meta.dirname,
					`../index${extname(import.meta.filename)}`,
				),
			),
			"mcp-proxy",
			"--profile",
			profile.name,
		],
		env: {
			C8CTL_DATA_DIR: resolve(getUserDataDir()),
			...(profile.name.startsWith("modeler:")
				? { C8CTL_MODELER_DIR: resolve(getModelerDataDir()) }
				: {}),
		},
	};
	if (
		[entry.command, ...entry.args, ...Object.values(entry.env)].some((value) =>
			value.includes("${"),
		)
	) {
		throw new Error(
			`MCP harnesses expand \${...} placeholders. Use a profile name and Node.js, c8ctl, and data-directory paths without that syntax.`,
		);
	}
	return entry;
}

function applyPlans({
	ctx,
	plans,
	operation,
}: {
	ctx: CommandContext;
	plans: McpConfigPlan[];
	operation: "install" | "uninstall";
}): CommandResult {
	if (ctx.isDryRun) {
		return {
			kind: "dryRun",
			info: {
				dryRun: true,
				command: `mcp ${operation}`,
				changes: plans.flatMap((plan) =>
					plan.changes.map((change) => ({
						harness: plan.harness,
						path: plan.path,
						...change,
					})),
				),
			},
		};
	}
	for (const plan of plans) {
		writeMcpConfig(plan);
		ctx.logger.info(`MCP configuration: ${plan.harness} (${plan.path})`);
	}
	if (operation === "install") {
		ctx.logger.info(
			"Restart or reload the selected harnesses to activate MCP.",
		);
		if (
			plans.some((plan) =>
				plan.changes.some((change) => change.server === "camunda-docs"),
			)
		) {
			ctx.logger.info("The docs server requires sign-in on first use.");
		}
	}
	return {
		kind: "list",
		items: plans.flatMap((plan) =>
			plan.changes.map(({ server, status }) => ({
				harness: plan.harness,
				server,
				status,
				path: plan.path,
			})),
		),
		emptyMessage: "No MCP entries selected.",
	};
}

export const installMcpCommand = defineCommand(
	"mcp",
	"install",
	async (ctx, flags) => {
		const selected = targets(flags);
		const plans = planMcpConfigs({
			requested: ctx.positionals,
			operation: "install",
			...selected,
			connection: selected.orchestration
				? buildMcpConnection(ctx.profile)
				: undefined,
		});
		return applyPlans({ ctx, plans, operation: "install" });
	},
);

export const uninstallMcpCommand = defineCommand(
	"mcp",
	"uninstall",
	async (ctx, flags) => {
		const plans = planMcpConfigs({
			requested: ctx.positionals,
			operation: "uninstall",
			...targets(flags),
		});
		return applyPlans({ ctx, plans, operation: "uninstall" });
	},
);
