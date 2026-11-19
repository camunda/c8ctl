/**
 * c8ctl-plugin-skills
 *
 * Install Camunda AI coding skills into AI coding harnesses.
 *
 * Usage:
 *   c8ctl skills install [--harness <agent-id>]
 */

import { renderCommandFailure } from "../../src/core/index.ts";
import type {
	PluginCommands,
	PluginCtx,
	PluginMetadata,
} from "../../src/framework/plugins/plugin-loader.ts";
import {
	CAMUNDA_SKILLS_REPOSITORY,
	detectInstalledHarnesses,
	normalizeSkillHarness,
	runSkillInstall,
} from "../../src/utils/command-local/skills-install-helpers.ts";

const HARNESS_LABELS: Readonly<Record<string, string>> = {
	"claude-code": "Claude Code",
	"github-copilot": "GitHub Copilot CLI",
	cursor: "Cursor",
};

export const metadata: PluginMetadata = {
	name: "skills",
	description: "Install Camunda AI coding skills",
	commands: {
		skills: {
			description: "Install Camunda AI coding skills",
			helpDescription: `Install Camunda skills into AI coding harnesses.

Requires GitHub CLI 2.90 or later; its skill commands are in preview.
Re-run to update the same skill directories without duplicates when upstream changes. Local edits to up-to-date skills are preserved; upstream updates may replace edited files.
To restore one skill's upstream files, use \`gh skill update --force --dir <skills-root> <skill-name>\`; pass the parent skills directory (for example \`~/.claude/skills\`), not the listed skill directory. Find names with \`gh skill list --scope user --agent <agent-id>\`. Extra local files are retained.
Use a GitHub CLI agent ID for --harness. See \`gh skill install --help\` for supported IDs.`,
			subcommands: [
				{
					name: "install",
					description: "Install or update skills for detected harnesses",
				},
			],
			examples: [
				{
					command: "c8ctl skills install",
					description: "Install or update skills for detected harnesses",
				},
				{
					command: "c8ctl skills install --harness claude-code",
					description: "Install or update skills for Claude Code",
				},
				{
					command: "c8ctl skills install --harness github-copilot",
					description: "Install or update skills for GitHub Copilot CLI",
				},
			],
		},
	},
};

async function skillsHandler(
	args: string[],
	flags: Record<string, unknown> | undefined,
	ctx?: PluginCtx,
): Promise<void> {
	if (!ctx) throw new Error("skills requires the plugin host context");
	const { logger } = ctx;

	if (args[0] !== "install") {
		if (args[0] === undefined) {
			logger.info(
				"\nUsage: c8ctl skills install\n\nAvailable resources:\n  install",
				{
					essential: true,
				},
			);
		} else {
			logger.error(`Unknown command: skills ${args.join(" ")}`);
			logger.info('Run "c8 help" for usage information', { essential: true });
		}
		process.exitCode = 1;
		return;
	}

	try {
		const harnessFlag =
			typeof flags?.harness === "string" ? flags.harness : undefined;
		const requestedHarness = harnessFlag
			? normalizeSkillHarness(harnessFlag)
			: undefined;
		const harnesses = requestedHarness
			? [requestedHarness]
			: detectInstalledHarnesses();

		if (harnesses.length === 0) {
			throw new Error(
				"No supported AI coding harness was detected. Install Claude Code or GitHub Copilot CLI, or pass --harness <agent-id>.",
			);
		}

		if (ctx.dryRun) {
			logger.json({
				dryRun: true,
				command: "skills install",
				source: CAMUNDA_SKILLS_REPOSITORY,
				harnesses,
			});
			return;
		}

		for (const harness of harnesses) {
			await runSkillInstall(harness);
		}

		const labels = harnesses
			.map((harness) => HARNESS_LABELS[harness] ?? harness)
			.join(", ");
		logger.success(`Installed or updated Camunda skills for ${labels}.`);
	} catch (error) {
		renderCommandFailure(logger, "Failed to skills install", error, {
			verbose: ctx.verbose,
		});
		process.exitCode = 1;
	}
}

export const commands: PluginCommands = {
	skills: {
		flags: {
			harness: {
				type: "string",
				rejectEmpty: true,
				description:
					"GitHub CLI agent ID to target (auto-detects Claude Code and GitHub Copilot CLI when omitted)",
			},
		},
		handler: skillsHandler,
	},
};
