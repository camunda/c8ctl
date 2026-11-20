/**
 * c8ctl-plugin-skills
 *
 * Manage Camunda AI coding skills in AI coding harnesses.
 *
 * Usage:
 *   c8ctl skills install [--harness <agent-id>]
 *   c8ctl skills list [--harness <agent-id>]
 *   c8ctl skills remove [--harness <agent-id>]
 */

import { renderCommandFailure } from "../../src/core/index.ts";
import type {
	PluginCommands,
	PluginCtx,
	PluginMetadata,
} from "../../src/framework/plugins/plugin-loader.ts";
import {
	CAMUNDA_SKILLS_REPOSITORY,
	type CamundaSkillInstallation,
	camundaSkillRemovalPath,
	detectInstalledHarnesses,
	listCamundaSkills,
	normalizeSkillHarness,
	removeCamundaSkill,
	runSkillInstall,
} from "../../src/utils/command-local/skills-install-helpers.ts";

const HARNESS_LABELS: Readonly<Record<string, string>> = {
	"claude-code": "Claude Code",
	"github-copilot": "GitHub Copilot CLI",
	cursor: "Cursor",
};

export const metadata: PluginMetadata = {
	name: "skills",
	description: "Manage Camunda AI coding skills",
	commands: {
		skills: {
			description: "Manage Camunda AI coding skills",
			helpDescription: `Manage Camunda skills installed in AI coding harnesses.

Requires GitHub CLI 2.90 or later; its skill commands are in preview.
Re-run to update the same skill directories without duplicates when upstream changes. Local edits to up-to-date skills are preserved; upstream updates may replace edited files.
To restore one skill's upstream files, use \`gh skill update --force --dir <skills-root> <skill-name>\`; pass the parent skills directory (for example \`~/.claude/skills\`), not the listed skill directory. Find names with \`gh skill list --scope user --agent <agent-id>\`. Extra local files are retained.
Use \`skills list\` to inspect installed skills and \`skills remove\` to remove them. Removal deletes the full skill directories, including local edits. Use a GitHub CLI agent ID for --harness; see \`gh skill install --help\` for supported IDs. Pass \`--yes\` for non-interactive removal; \`--dry-run\` previews without deleting.`,
			subcommands: [
				{
					name: "install",
					description: "Install or update skills for detected harnesses",
				},
				{
					name: "list",
					description: "List installed Camunda skills by harness",
				},
				{
					name: "remove",
					description: "Remove installed Camunda skills",
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
				{
					command: "c8ctl skills list",
					description: "List installed Camunda skills by harness",
				},
				{
					command: "c8ctl skills remove --dry-run",
					description: "Preview Camunda skills removal",
				},
				{
					command: "c8ctl skills remove --harness claude-code --yes",
					description: "Remove Camunda skills from Claude Code",
				},
			],
		},
	},
};

function resolveHarnesses(rawHarness: unknown): {
	harnesses: string[];
	requestedHarness: string | undefined;
} {
	if (
		rawHarness !== undefined &&
		(typeof rawHarness !== "string" || rawHarness === "")
	) {
		throw new Error("Invalid --harness: value must not be empty");
	}

	const requestedHarness =
		typeof rawHarness === "string"
			? normalizeSkillHarness(rawHarness)
			: undefined;
	const harnesses = requestedHarness
		? [requestedHarness]
		: detectInstalledHarnesses();
	if (harnesses.length === 0) {
		throw new Error(
			"No supported AI coding harness was detected. Install Claude Code or GitHub Copilot CLI, or pass --harness <agent-id>.",
		);
	}
	return { harnesses, requestedHarness };
}

async function inspectSkills(
	harnesses: string[],
): Promise<CamundaSkillInstallation[]> {
	const skills: CamundaSkillInstallation[] = [];
	for (const harness of harnesses) {
		skills.push(...(await listCamundaSkills(harness)));
	}
	return skills;
}

function skillRows(skills: CamundaSkillInstallation[]) {
	return skills.map(({ name, harness, path }) => ({ name, harness, path }));
}

async function listSkills(rawHarness: unknown, ctx: PluginCtx): Promise<void> {
	const { logger } = ctx;
	try {
		const { harnesses } = resolveHarnesses(rawHarness);
		const skills = await inspectSkills(harnesses);
		const rows = skillRows(skills);
		if (ctx.outputMode === "json") {
			logger.json({ command: "skills list", harnesses, skills: rows });
		} else if (rows.length === 0) {
			const labels = harnesses
				.map((harness) => HARNESS_LABELS[harness] ?? harness)
				.join(", ");
			logger.info(`No Camunda skills are installed for ${labels}.`, {
				essential: true,
			});
		} else {
			logger.table(rows);
		}
	} catch (error) {
		renderCommandFailure(logger, "Failed to skills list", error, {
			verbose: ctx.verbose,
		});
		process.exitCode = 1;
	}
}

async function removeSkills(
	rawHarness: unknown,
	ctx: PluginCtx,
): Promise<void> {
	const { logger } = ctx;
	try {
		const { harnesses, requestedHarness } = resolveHarnesses(rawHarness);
		const skills = await inspectSkills(harnesses);
		for (const skill of skills) camundaSkillRemovalPath(skill);

		const items = skills.map(({ name, harness, path }) => ({
			type: "skill",
			harness,
			name,
			path,
		}));
		const preview = {
			command: "skills remove",
			action: "remove",
			preview: true,
			items,
		};

		if (ctx.dryRun) {
			logger.json({ dryRun: true, ...preview });
			return;
		}

		if (skills.length === 0) {
			if (ctx.outputMode === "json") {
				logger.json({ command: "skills remove", harnesses, removed: [] });
			} else {
				const labels = harnesses
					.map((harness) => HARNESS_LABELS[harness] ?? harness)
					.join(", ");
				logger.info(`No Camunda skills are installed for ${labels}.`, {
					essential: true,
				});
			}
			return;
		}

		if (ctx.outputMode === "text") {
			logger.output(
				[
					"Skills removal preview:",
					...skills.map(
						({ name, harness, path }) =>
							`  Remove Camunda skill "${name}" for ${HARNESS_LABELS[harness] ?? harness} (${path}; all contents will be removed)`,
					),
				].join("\n"),
			);
		} else if (!ctx.yes) {
			logger.json(preview);
			return;
		}

		if (!ctx.yes) {
			if (!ctx.quiet && ctx.prompt.isInteractive()) {
				const confirmation = await ctx.prompt.select({
					message: "Remove the listed Camunda skills?",
					options: [
						{ label: "Keep these skills", value: false },
						{ label: "Remove the listed skills", value: true },
					],
				});
				if (confirmation.cancelled || !confirmation.value) {
					logger.info("Cancelled — nothing was removed.", {
						essential: true,
					});
					return;
				}
			} else {
				const command = [
					"c8ctl",
					"skills",
					"remove",
					...(requestedHarness ? ["--harness", requestedHarness] : []),
					"--yes",
				].join(" ");
				logger.info(`Nothing was removed. Run "${command}" to confirm.`, {
					essential: true,
				});
				return;
			}
		}

		const removed: CamundaSkillInstallation[] = [];
		const failures: Array<{
			skill: CamundaSkillInstallation;
			error: unknown;
		}> = [];
		for (const skill of skills) {
			try {
				removeCamundaSkill(skill);
				removed.push(skill);
			} catch (error) {
				failures.push({ skill, error });
			}
		}

		if (ctx.outputMode === "json") {
			logger.json({
				command: "skills remove",
				removed: skillRows(removed),
			});
		} else {
			for (const skill of removed) {
				logger.info(
					`Removed Camunda skill "${skill.name}" for ${HARNESS_LABELS[skill.harness] ?? skill.harness} (${skill.path}).`,
					{ essential: true },
				);
			}
			logger.info(
				failures.length === 0
					? "Skills removal finished."
					: `Skills removal finished with ${failures.length} failed action(s).`,
				{ essential: true },
			);
		}

		for (const { skill, error } of failures) {
			renderCommandFailure(
				logger,
				`Could not remove Camunda skill "${skill.name}" for ${skill.harness}`,
				error,
				{ verbose: ctx.verbose },
			);
		}
		if (failures.length > 0) process.exitCode = 1;
	} catch (error) {
		renderCommandFailure(logger, "Failed to skills remove", error, {
			verbose: ctx.verbose,
		});
		process.exitCode = 1;
	}
}

async function skillsHandler(
	args: string[],
	flags: Record<string, unknown> | undefined,
	ctx?: PluginCtx,
): Promise<void> {
	if (!ctx) throw new Error("skills requires the plugin host context");
	const { logger } = ctx;

	if (args[0] === "list") {
		await listSkills(flags?.harness, ctx);
		return;
	}
	if (args[0] === "remove") {
		await removeSkills(flags?.harness, ctx);
		return;
	}

	if (args[0] !== "install") {
		if (args[0] === undefined) {
			logger.info(
				"\nUsage: c8ctl skills <install|list|remove> [--harness <agent-id>]\n\nAvailable commands:\n  install\n  list\n  remove",
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
		// Plugin flag dispatch does not enforce `rejectEmpty`: a valueless
		// --harness arrives as a non-string and --harness= as an empty
		// string. Both are validation errors, as for the built-in command —
		// never a silent fallback to auto-detection.
		const rawHarness = flags?.harness;
		if (
			rawHarness !== undefined &&
			(typeof rawHarness !== "string" || rawHarness === "")
		) {
			logger.error("Invalid --harness: value must not be empty");
			process.exitCode = 1;
			return;
		}
		const requestedHarness =
			typeof rawHarness === "string"
				? normalizeSkillHarness(rawHarness)
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
