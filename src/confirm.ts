/**
 * Interactive confirmation prompt for mutating commands.
 *
 * Uses Node's built-in `readline` — no external dependencies.
 * Returns `true` if the user confirms, `false` otherwise.
 * Automatically skips (returns `true`) when stdin is not a TTY
 * (e.g. piped input, CI), logging the target to stderr instead.
 */

import { createInterface } from "node:readline";
import { c8ctl } from "./runtime.ts";

/**
 * Prompt the user to confirm a deploy target when multiple profiles exist.
 *
 * Conditions for prompting (all must be true):
 * - `--yes` / `-y` was NOT passed
 * - `--profile` was NOT explicitly passed
 * - More than one profile is configured
 * - stdin is a TTY (interactive terminal)
 *
 * When stdin is not a TTY, logs the target to stderr and proceeds.
 */
export async function confirmDeployTarget(options: {
	profileName: string;
	baseUrl: string;
}): Promise<boolean> {
	const { profileName, baseUrl } = options;
	const message = `Deploying to profile "${profileName}" (${baseUrl})`;

	// Non-interactive: log target and proceed
	if (!process.stdin.isTTY) {
		if (c8ctl.outputMode === "json") {
			console.error(JSON.stringify({ type: "message", message }));
		} else {
			console.error(message);
		}
		return true;
	}

	return new Promise<boolean>((resolve) => {
		const rl = createInterface({
			input: process.stdin,
			output: process.stderr,
		});

		rl.question(
			`Deploying to profile "${profileName}" (${baseUrl})\nContinue? [y/N] `,
			(answer) => {
				rl.close();
				const normalized = answer.trim().toLowerCase();
				resolve(normalized === "y" || normalized === "yes");
			},
		);
	});
}
