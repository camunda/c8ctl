/**
 * c8ctl-plugin-mcp
 *
 * Install or uninstall Camunda MCP connections in AI harnesses.
 *
 * Usage:
 *   c8ctl mcp install [harness...] [--docs] [--orchestration] [--alias <name>]
 *   c8ctl mcp uninstall [harness...] [--docs] [--orchestration]
 */

import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	DEFAULT_PROFILE,
	getModelerDataDir,
	getProfileOrModeler,
	getUserDataDir,
	renderCommandFailure,
	resolveEnvBaseUrl,
} from "../../src/core/index.ts";
import type {
	PluginCommands,
	PluginCtx,
	PluginMetadata,
} from "../../src/framework/plugins/plugin-loader.ts";
import {
	type McpConfigPlan,
	planMcpConfigs,
	writeMcpConfig,
} from "../../src/utils/command-local/mcp-install-helpers.ts";

export const metadata: PluginMetadata = {
	name: "mcp",
	description: "Install or uninstall Camunda MCP connections in AI harnesses",
	commands: {
		mcp: {
			description:
				"Install or uninstall Camunda MCP connections in AI harnesses",
			helpDescription: `Configure user-scoped Camunda orchestration and docs MCP servers.

Harnesses: claude-code, github-copilot, cursor, vscode, claude-desktop (macOS/Windows).
Omit harness names to configure all detected supported harnesses.
Aliases: claude = claude-code, copilot = github-copilot, code = vscode.
Targets: orchestration by default; --docs selects only docs; --docs --orchestration selects both.
Orchestration references --profile, the active saved profile, or the default local profile; credentials are not copied.
Docs uses camunda-docs, needs no cluster profile, and requires sign-in on first use.
Claude Desktop docs uses npx mcp-remote; other harnesses connect over HTTP.
VS Code's editor-managed config uses servers. For the newer Copilot harness, select github-copilot.
On uninstall, --preserve-conflicts leaves entries that no longer match the c8ctl-managed shape untouched instead of failing.
--dry-run previews selected entries without writing or exposing unrelated config values.`,
			subcommands: [
				{
					name: "install",
					description:
						"Install MCP connections for detected or named harnesses",
				},
				{
					name: "uninstall",
					description:
						"Remove MCP connections from detected or named harnesses",
				},
			],
			examples: [
				{
					command: "c8ctl mcp install",
					description: "Install orchestration MCP for detected harnesses",
				},
				{
					command: "c8ctl mcp install --docs",
					description: "Install only docs MCP for detected harnesses",
				},
				{
					command:
						"c8ctl mcp install claude-code cursor --docs --orchestration",
					description: "Install both MCP servers for selected harnesses",
				},
				{
					command: "c8ctl mcp uninstall claude-code --docs",
					description: "Remove only the docs MCP entry",
				},
			],
		},
	},
};

/**
 * The CLI's own entry point, for pointing harness configs at
 * `c8ctl mcp-proxy`. The plugin sits at default-plugins/mcp/ in development
 * (entry: src/index.ts) and at dist/default-plugins/mcp/ once bundled
 * (entry: dist/index.js) — take the first candidate that exists.
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
 * The harness connection entry pointing at `c8ctl mcp-proxy` for a profile.
 * `profile` is the host-resolved active profile (`--profile` flag or
 * session), so the plugin never reads profile state off the runtime global.
 */
function buildMcpConnection(profile?: string): Record<string, unknown> {
	if (profile === undefined && resolveEnvBaseUrl()) {
		throw new Error(
			"MCP installation requires a saved profile. Save your environment with 'c8ctl add profile <name> --from-env', then pass --profile <name>.",
		);
	}
	const name = profile ?? DEFAULT_PROFILE;
	const resolved = getProfileOrModeler(name);
	if (!resolved) {
		throw new Error(
			`Profile '${name}' not found. Run 'c8ctl list profiles' and select one with --profile.`,
		);
	}
	const entry = {
		command: process.execPath,
		args: [CLI_ENTRY, "mcp-proxy", "--profile", resolved.name],
		env: {
			C8CTL_DATA_DIR: resolve(getUserDataDir()),
			...(resolved.name.startsWith("modeler:")
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

function targets({
	docs,
	orchestration,
	alias,
	aliasProvided,
}: {
	docs: boolean;
	orchestration: boolean;
	alias: string;
	aliasProvided: boolean;
}) {
	const selectedDocs = docs;
	const selectedOrchestration = orchestration || !docs;
	if (aliasProvided && !selectedOrchestration) {
		throw new Error(
			"--alias applies to orchestration. Add --orchestration or omit --alias.",
		);
	}
	if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(alias) || alias === "camunda-docs") {
		throw new Error(
			"Use an orchestration alias containing letters, digits, underscores or hyphens, starting with a letter or digit. 'camunda-docs' is reserved.",
		);
	}
	return { docs: selectedDocs, orchestration: selectedOrchestration, alias };
}

function applyPlans({
	ctx,
	plans,
	operation,
}: {
	ctx: PluginCtx;
	plans: McpConfigPlan[];
	operation: "install" | "uninstall";
}): void {
	const { logger } = ctx;
	if (ctx.dryRun) {
		logger.json({
			dryRun: true,
			command: `mcp ${operation}`,
			changes: plans.flatMap((plan) =>
				plan.changes.map((change) => ({
					harness: plan.harness,
					path: plan.path,
					...change,
				})),
			),
		});
		return;
	}
	for (const plan of plans) {
		writeMcpConfig(plan);
		logger.info(`MCP configuration: ${plan.harness} (${plan.path})`);
	}
	if (operation === "install") {
		logger.info("Restart or reload the selected harnesses to activate MCP.");
		if (
			plans.some((plan) =>
				plan.changes.some((change) => change.server === "camunda-docs"),
			)
		) {
			logger.info("The docs server requires sign-in on first use.");
		}
	}
	const items = plans.flatMap((plan) =>
		plan.changes.map(({ server, status }) => ({
			harness: plan.harness,
			server,
			status,
			path: plan.path,
		})),
	);
	if (items.length > 0) {
		logger.table(items);
	} else {
		logger.info("No MCP entries selected.", { essential: true });
	}
}

async function mcpHandler(
	args: string[],
	flags: Record<string, unknown> | undefined,
	ctx?: PluginCtx,
): Promise<void> {
	if (!ctx) throw new Error("mcp requires the plugin host context");
	const { logger } = ctx;

	const operation = args[0];
	if (operation !== "install" && operation !== "uninstall") {
		if (operation === undefined) {
			logger.info(
				"\nUsage: c8ctl mcp install|uninstall [harness...]\n\nAvailable resources:\n  install\n  uninstall",
				{ essential: true },
			);
		} else {
			logger.error(`Unknown command: mcp ${args.join(" ")}`);
			logger.info('Run "c8 help" for usage information', { essential: true });
		}
		process.exitCode = 1;
		return;
	}

	try {
		// Plugin flag dispatch does not enforce `rejectEmpty`: a valueless
		// --alias arrives as a non-string and --alias= as an empty string.
		// Both are validation errors, as for the built-in command — never a
		// silent fallback to the default alias.
		const rawAlias = flags?.alias;
		if (
			rawAlias !== undefined &&
			(typeof rawAlias !== "string" || rawAlias === "")
		) {
			logger.error("Invalid --alias: value must not be empty");
			process.exitCode = 1;
			return;
		}
		const selected = targets({
			docs: flags?.docs === true,
			orchestration: flags?.orchestration === true,
			alias: rawAlias ?? "camunda",
			aliasProvided: rawAlias !== undefined,
		});
		const plans = planMcpConfigs({
			requested: args.slice(1),
			operation,
			...selected,
			preserveConflicts: flags?.["preserve-conflicts"] === true,
			connection:
				operation === "install" && selected.orchestration
					? buildMcpConnection(ctx.profile)
					: undefined,
		});
		applyPlans({ ctx, plans, operation });
	} catch (error) {
		renderCommandFailure(logger, `Failed to mcp ${operation}`, error, {
			verbose: ctx.verbose,
		});
		process.exitCode = 1;
	}
}

export const commands: PluginCommands = {
	mcp: {
		flags: {
			orchestration: {
				type: "boolean",
				description:
					"Select the orchestration MCP server (default when --docs is absent)",
			},
			docs: {
				type: "boolean",
				description:
					"Select the Camunda docs MCP server; combine with --orchestration for both",
			},
			alias: {
				type: "string",
				rejectEmpty: true,
				description: "Orchestration server entry name (default: camunda)",
			},
			"preserve-conflicts": {
				type: "boolean",
				description:
					"On uninstall, leave conflicting foreign entries untouched instead of failing",
			},
		},
		handler: mcpHandler,
	},
};
