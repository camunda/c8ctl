/**
 * Interactive confirmation prompt for mutating commands.
 *
 * Uses Node's built-in `readline` — no external dependencies.
 * Returns `true` if the user confirms, `false` otherwise.
 * Automatically skips (returns `true`) when stdin or stderr is not
 * a TTY (e.g. piped input, CI, redirected stderr), logging the
 * target to stderr instead.
 */

import { createInterface } from "node:readline";
import { c8ctl } from "./runtime.ts";

/**
 * Prompt the user to confirm a deploy target.
 *
 * The caller decides *when* to call this (e.g. based on `--yes`,
 * `--profile`, profile count, env vars). This helper handles only
 * the TTY check and the actual prompting/logging:
 *
 * - **Interactive** (stdin + stderr are TTY): asks `Continue? [y/N]`
 *   and returns the user's answer.
 * - **Non-interactive** (piped/redirected): logs the target to stderr
 *   and returns `true` (auto-approve).
 */
export async function confirmDeployTarget(options: {
	profileName: string;
	baseUrl: string;
}): Promise<boolean> {
	const { profileName, baseUrl } = options;
	const message = `Deploying to profile "${profileName}" (${baseUrl})`;

	// Non-interactive: log target and proceed.
	// Treat the session as non-interactive unless both stdin AND stderr
	// are TTY — if stderr is redirected the prompt would be invisible.
	if (!process.stdin.isTTY || !process.stderr.isTTY) {
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
