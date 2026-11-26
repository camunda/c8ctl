/**
 * c8ctl-plugin-skills
 *
 * Manage Camunda AI coding skills in AI coding harnesses.
 *
 * Usage:
 *   c8ctl skills install [--harness <agent-id>]
 *   c8ctl skills list [--harness <agent-id>]
 *   c8ctl skills uninstall [name...] [--harness <agent-id>]
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

Requires GitHub CLI 2.95 or later; its skill commands are in preview.
Re-run to update the same skill directories without duplicates when upstream changes. Local edits to up-to-date skills are preserved; upstream updates may replace edited files.
To restore one skill's upstream files, use \`gh skill update --force --dir <skills-root> <skill-name>\`; pass the parent skills directory (for example \`~/.claude/skills\`), not the listed skill directory. Find names with \`gh skill list --scope user --agent <agent-id>\`. Extra local files are retained.
Use \`skills list\` to inspect installed skills and \`skills uninstall\` to remove them (\`skills remove\` remains a compatibility alias). Removal deletes the full skill directories, including local edits. Name one or more skills to remove only those; unknown names fail before anything is deleted. When a name is installed at multiple paths, pair each positional name with a matching \`--skill-path\` value to remove only that installation. Use a GitHub CLI agent ID for --harness; see \`gh skill install --help\` for supported IDs. Pass \`--yes\` for non-interactive removal; \`--dry-run\` previews without deleting.`,
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
					name: "uninstall",
					description: "Remove installed Camunda skills",
				},
				{
					name: "remove",
					description: "Alias for uninstall",
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
					command: "c8ctl skills uninstall --dry-run",
					description: "Preview Camunda skills removal",
				},
				{
					command: "c8ctl skills uninstall camunda-c8ctl --yes",
					description: "Remove only the named Camunda skills",
				},
				{
					command: "c8ctl skills uninstall --harness claude-code --yes",
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

function parseSkillPaths(rawSkillPaths: unknown): string[] | undefined {
	if (rawSkillPaths === undefined) return undefined;
	const values: Iterable<unknown> = Array.isArray(rawSkillPaths)
		? rawSkillPaths
		: [rawSkillPaths];
	const paths: string[] = [];
	for (const value of values) {
		if (typeof value !== "string" || value.length === 0) {
			throw new Error(
				"Invalid --skill-path: provide one non-empty path for each named skill.",
			);
		}
		paths.push(value);
	}
	if (paths.length === 0) {
		throw new Error(
			"Invalid --skill-path: provide one non-empty path for each named skill.",
		);
	}
	return paths;
}

/**
 * Emit JSON for a rows payload. With `--fields`, emit the rows directly
 * so logger.json filters each row's keys; the envelope would swallow
 * requested fields such as `name,path`.
 */
function emitRowsJson(
	ctx: PluginCtx,
	envelope: Record<string, unknown>,
	rows: Array<Record<string, string>>,
): void {
	if (ctx.fields && ctx.fields.length > 0) {
		ctx.logger.json(rows);
	} else {
		ctx.logger.json(envelope);
	}
}

async function listSkills(rawHarness: unknown, ctx: PluginCtx): Promise<void> {
	const { logger } = ctx;
	try {
		const { harnesses } = resolveHarnesses(rawHarness);
		const skills = await inspectSkills(harnesses);
		const rows = skillRows(skills);
		if (ctx.outputMode === "json") {
			emitRowsJson(
				ctx,
				{ command: "skills list", harnesses, skills: rows },
				rows,
			);
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
	extraArgs: string[],
	rawSkillPaths: unknown,
	ctx: PluginCtx,
): Promise<void> {
	const { logger } = ctx;
	try {
		if (ctx.unrecognizedFlags && ctx.unrecognizedFlags.length > 0) {
			throw new Error(
				`Unknown flag${ctx.unrecognizedFlags.length === 1 ? "" : "s"} ${ctx.unrecognizedFlags.join(", ")} for 'skills uninstall'. Only --harness and --skill-path are supported removal selectors; fix or remove the flag before deleting skills.`,
			);
		}
		// A mistyped flag can also be swallowed as the value of a string
		// global (`skills uninstall --fields --harnes=cursor`); the host exposes
		// every occurrence, and option-like values are never legitimate here.
		const swallowed = ctx.suspiciousFlagValues?.[0];
		if (swallowed) {
			throw new Error(
				`"${swallowed}" looks like a flag but was passed as a value. Fix the invocation before deleting skills.`,
			);
		}
		const skillPaths = parseSkillPaths(rawSkillPaths);
		if (skillPaths !== undefined && skillPaths.length !== extraArgs.length) {
			throw new Error(
				"Provide --skill-path once for each positional skill name, in the same order; nothing was removed.",
			);
		}
		// Positional names without paths select every matching installation.
		// With paths, each pair selects one exact installation.
		const requestedNames =
			skillPaths === undefined ? [...new Set(extraArgs)] : extraArgs;
		let requestedTargets: Array<{ name: string; path: string }> | undefined;
		if (skillPaths !== undefined) {
			requestedTargets = [];
			for (const [index, path] of skillPaths.entries()) {
				const name = requestedNames[index];
				if (name === undefined) {
					throw new Error(
						"Provide --skill-path once for each positional skill name, in the same order; nothing was removed.",
					);
				}
				requestedTargets.push({ name, path });
			}
		}
		const { harnesses, requestedHarness } = resolveHarnesses(rawHarness);
		const discovered = await inspectSkills(harnesses);
		if (requestedTargets !== undefined) {
			const unknown = requestedTargets.filter(
				(target) =>
					!discovered.some(
						(skill) => skill.name === target.name && skill.path === target.path,
					),
			);
			if (unknown.length > 0) {
				throw new Error(
					`Unknown Camunda skill target${unknown.length === 1 ? "" : "s"} ${unknown
						.map(({ name, path }) => `"${name}" (${path})`)
						.join(
							", ",
						)} — not installed for ${harnesses.join(", ")}. Run "c8ctl skills list" for the installed set; nothing was removed.`,
				);
			}
		} else if (requestedNames.length > 0) {
			const installedNames = new Set(discovered.map((skill) => skill.name));
			const unknown = requestedNames.filter(
				(name) => !installedNames.has(name),
			);
			if (unknown.length > 0) {
				throw new Error(
					`Unknown Camunda skill${unknown.length === 1 ? "" : "s"} ${unknown
						.map((name) => `"${name}"`)
						.join(
							", ",
						)} — not installed for ${harnesses.join(", ")}. Run "c8ctl skills list" for the installed set; nothing was removed.`,
				);
			}
		}
		const skills =
			requestedTargets !== undefined
				? discovered.filter((skill) =>
						requestedTargets.some(
							(target) =>
								skill.name === target.name && skill.path === target.path,
						),
					)
				: requestedNames.length === 0
					? discovered
					: discovered.filter((skill) => requestedNames.includes(skill.name));
		for (const skill of skills) camundaSkillRemovalPath(skill);
		const items = skills.map(({ name, harness, path }) => ({
			type: "skill",
			harness,
			name,
			path,
		}));
		const preview = {
			command: "skills uninstall",
			action: "remove",
			preview: true,
			items,
		};

		if (ctx.dryRun) {
			emitRowsJson(ctx, { dryRun: true, ...preview }, items);
			return;
		}

		if (skills.length === 0) {
			if (ctx.outputMode === "json") {
				emitRowsJson(
					ctx,
					{ command: "skills uninstall", harnesses, removed: [] },
					[],
				);
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
			emitRowsJson(ctx, preview, items);
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
				if (skillPaths !== undefined) {
					logger.info(
						"Nothing was removed. Re-run the same command with --yes to confirm.",
						{ essential: true },
					);
				} else {
					const command = [
						"c8ctl",
						"skills",
						"uninstall",
						...requestedNames,
						...(requestedHarness ? ["--harness", requestedHarness] : []),
						"--yes",
					].join(" ");
					logger.info(`Nothing was removed. Run "${command}" to confirm.`, {
						essential: true,
					});
				}
				return;
			}
		}

		// Revalidate identity and source immediately before deletion: another
		// process may have replaced a listed directory while the confirmation
		// was open. Refuse changed entries and require a fresh preview.
		const revalidated = await inspectSkills(harnesses);
		const listedKeys = new Set(
			revalidated.map((skill) =>
				JSON.stringify([skill.harness, skill.name, skill.path]),
			),
		);
		const stale = skills.filter(
			(skill) =>
				!listedKeys.has(
					JSON.stringify([skill.harness, skill.name, skill.path]),
				),
		);
		if (stale.length > 0) {
			throw new Error(
				`The installed-skills inventory changed after the preview: ${stale
					.map((skill) => `"${skill.name}" (${skill.path})`)
					.join(
						", ",
					)}. Run "c8ctl skills uninstall" again for a fresh preview before deleting.`,
			);
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
			emitRowsJson(
				ctx,
				{ command: "skills uninstall", removed: skillRows(removed) },
				skillRows(removed),
			);
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
		renderCommandFailure(logger, "Failed to skills uninstall", error, {
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

	const subcommand = args[0];
	// `remove` is the pre-uninstall spelling, kept as a compatibility alias.
	const isUninstall = subcommand === "uninstall" || subcommand === "remove";

	if (!isUninstall && flags?.["skill-path"] !== undefined) {
		logger.error("--skill-path can only be used with 'skills uninstall'.");
		process.exitCode = 1;
		return;
	}

	if (subcommand === "list") {
		await listSkills(flags?.harness, ctx);
		return;
	}
	if (isUninstall) {
		await removeSkills(
			flags?.harness,
			args.slice(1),
			flags?.["skill-path"],
			ctx,
		);
		return;
	}

	if (subcommand !== "install") {
		if (subcommand === undefined) {
			logger.info(
				"\nUsage: c8ctl skills <install|list|uninstall> [--harness <agent-id>]\n\nAvailable commands:\n  install\n  list\n  uninstall",
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

		let hasSkippedSkills = false;
		for (const harness of harnesses) {
			const skipped = await runSkillInstall(harness);
			if (skipped.length > 0) {
				hasSkippedSkills = true;
				const label = HARNESS_LABELS[harness] ?? harness;
				logger.warn(
					`Skipped Camunda skill${skipped.length === 1 ? "" : "s"} for ${label} (${harness}): ${skipped.map((name) => `"${name}"`).join(", ")}. These target directories already exist without \`camunda/skills\` source attribution; existing user files were left untouched. To install Camunda's versions, inspect the ${label} user skills directory and move or rename the conflicting directories, then rerun \`c8ctl skills install --harness ${harness}\`. Directories without a readable \`SKILL.md\` may not appear in \`gh skill list\`.`,
				);
			}
		}

		const labels = harnesses
			.map((harness) => HARNESS_LABELS[harness] ?? harness)
			.join(", ");
		const completionMessage = hasSkippedSkills
			? "Camunda skills installation check completed"
			: "Installed or updated Camunda skills";
		logger.success(`${completionMessage} for ${labels}.`);
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
			"skill-path": {
				type: "string",
				multiple: true,
				description:
					"During removal, match each positional skill name to one installed path; repeat once for each name",
			},
		},
		handler: skillsHandler,
	},
};
