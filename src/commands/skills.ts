import { defineCommand } from "../framework/index.ts";
import {
	CAMUNDA_SKILLS_REPOSITORY,
	detectInstalledHarnesses,
	normalizeSkillHarness,
	runSkillInstall,
} from "../utils/index.ts";

const HARNESS_LABELS: Readonly<Record<string, string>> = {
	"claude-code": "Claude Code",
	"github-copilot": "GitHub Copilot CLI",
	cursor: "Cursor",
};

export const installSkillsCommand = defineCommand(
	"skills",
	"install",
	async (ctx, flags) => {
		const requestedHarness = flags.harness
			? normalizeSkillHarness(flags.harness)
			: undefined;
		const harnesses = requestedHarness
			? [requestedHarness]
			: detectInstalledHarnesses();

		if (harnesses.length === 0) {
			throw new Error(
				"No supported AI coding harness was detected. Install Claude Code or GitHub Copilot CLI, or pass --harness <agent-id>.",
			);
		}

		if (ctx.isDryRun) {
			ctx.logger.json({
				dryRun: true,
				command: "skills install",
				source: CAMUNDA_SKILLS_REPOSITORY,
				harnesses,
			});
			return { kind: "none" };
		}

		for (const harness of harnesses) {
			runSkillInstall(harness);
		}

		const labels = harnesses
			.map((harness) => HARNESS_LABELS[harness] ?? harness)
			.join(", ");
		return {
			kind: "success",
			message: `Installed or updated Camunda skills for ${labels}.`,
		};
	},
);
