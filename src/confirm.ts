/**
 * Interactive confirmation prompt for mutating commands.
 *
 * Uses Node's built-in `readline` — no external dependencies.
 * Returns `"yes"`, `"no"`, or `"always"`.
 * Automatically skips (returns `"yes"`) when stdin or stderr is not
 * a TTY (e.g. piped input, CI, redirected stderr), logging the
 * target to stderr instead.
 */

import { createInterface } from "node:readline";
import { c8ctl } from "./runtime.ts";

export type ConfirmResult = "yes" | "no" | "always";

/**
 * Prompt the user to confirm a deploy target.
 *
 * The caller decides *when* to call this (e.g. based on `--yes`,
 * `--profile`, profile count, env vars). This helper handles only
 * the TTY check and the actual prompting/logging:
 *
 * - **Interactive** (stdin + stderr are TTY): asks `Continue? [y/N/a]`
 *   and returns the user's answer.
 * - **Non-interactive** (piped/redirected): logs the target to stderr
 *   and returns `"yes"` (auto-approve).
 */
export async function confirmDeployTarget(options: {
	profileName: string;
	baseUrl: string;
}): Promise<ConfirmResult> {
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
		return "yes";
	}

	return new Promise<ConfirmResult>((resolve) => {
		const rl = createInterface({
			input: process.stdin,
			output: process.stderr,
		});

		rl.question(
			`Deploying to profile "${profileName}" (${baseUrl})\nContinue? [y/N/a] (a = always, don't prompt again) `,
			(answer) => {
				rl.close();
				const normalized = answer.trim().toLowerCase();
				if (normalized === "a" || normalized === "always") {
					resolve("always");
				} else if (normalized === "y" || normalized === "yes") {
					resolve("yes");
				} else {
					resolve("no");
				}
			},
		);
	});
}
