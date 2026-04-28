/**
 * Open command - opens Camunda web applications in a browser
 *
 * Pure helpers (URL derivation, platform browser detection, validation,
 * `openUrl`) live in `src/open-helpers.ts` so they can be unit-tested
 * without violating the test→commands import boundary (#291).
 */

import { defineCommand } from "../command-framework.ts";
import { resolveClusterConfig } from "../config.ts";
import {
	deriveAppUrl,
	openUrl,
	validateOpenAppOptions,
} from "../open-helpers.ts";

// ─── defineCommand ───────────────────────────────────────────────────────────

/**
 * Open a Camunda web application in the default browser.
 *
 * Side-effectful: validates the app name, derives the URL from the cluster
 * config, and spawns the platform browser opener. With `--dry-run`, logs
 * the resolved URL but skips the spawn.
 */
export const openAppCommand = defineCommand("open", "", async (ctx) => {
	const { app, profile, dryRun } = validateOpenAppOptions(ctx.resource, {
		profile: ctx.profile,
		dryRun: ctx.dryRun,
	});

	const config = resolveClusterConfig(profile);
	const url = deriveAppUrl(config.baseUrl, app);

	if (!url) {
		throw new Error(
			`Cannot derive ${app} URL from base URL: ${config.baseUrl}. ` +
				"The open command is only supported for self-managed clusters " +
				"whose base URL ends with /v<n> (e.g. http://localhost:8080/v2).",
		);
	}

	ctx.logger.info(`Opening ${app} at: ${url}`);
	if (!dryRun) {
		openUrl(url);
	}
	return { kind: "none" };
});

/** Open the GitHub issues page for c8ctl feedback. */
export const feedbackCommand = defineCommand("feedback", "", async (ctx) => {
	const url = "https://github.com/camunda/c8ctl/issues";
	ctx.logger.info(`Opening feedback page: ${url}`);
	openUrl(url);
	return { kind: "none" };
});
