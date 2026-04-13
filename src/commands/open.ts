/**
 * Open command - opens Camunda web applications in a browser
 */

import { spawn } from "node:child_process";
import { platform } from "node:os";
import { resolveClusterConfig } from "../config.ts";
import { getLogger } from "../logger.ts";

export const OPEN_APPS = [
	"operate",
	"tasklist",
	"modeler",
	"optimize",
] as const;
export type AppName = (typeof OPEN_APPS)[number];

export function isAppName(value: string): value is AppName {
	// biome-ignore lint/plugin: safe widening — readonly tuple to readonly string[] for .includes() compatibility
	return (OPEN_APPS as readonly string[]).includes(value);
}

/** Pattern that matches a self-managed REST API version suffix, e.g. `/v2` */
const VERSION_SUFFIX_RE = /\/v\d+\/?$/;

/**
 * Derive the URL of a Camunda web application from the cluster base URL.
 *
 * Only supported for self-managed clusters where the base URL is the REST API
 * endpoint (e.g. `http://localhost:8080/v2`). Returns `null` when the URL
 * does not look like a self-managed gateway (no `/v<n>` suffix).
 */
export function deriveAppUrl(baseUrl: string, app: AppName): string | null {
	if (!VERSION_SUFFIX_RE.test(baseUrl)) {
		return null;
	}
	const base = baseUrl.replace(VERSION_SUFFIX_RE, "").replace(/\/$/, "");
	return `${base}/${app}`;
}

/**
 * Determine the platform-appropriate command and arguments to open a URL.
 *
 * WSL is detected explicitly because it reports `linux`, but should use the
 * Windows opener via interop rather than relying on `xdg-open`.
 *
 * Accepts optional overrides for testing.
 */
export function getBrowserCommand(
	url: string,
	plat: NodeJS.Platform = platform(),
	env: Record<string, string | undefined> = process.env,
): { command: string; args: string[] } {
	const isWsl =
		plat === "linux" && Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP);

	if (plat === "darwin") {
		return { command: "open", args: [url] };
	}
	if (plat === "win32" || isWsl) {
		return { command: "cmd.exe", args: ["/c", "start", "", url] };
	}
	// Linux
	return { command: "xdg-open", args: [url] };
}

/**
 * Open a URL in the default system browser.
 * Works on macOS, Linux, native Windows, and WSL.
 */
export function openUrl(url: string): void {
	const logger = getLogger();
	const { command, args } = getBrowserCommand(url);
	const child = spawn(command, args, { detached: true, stdio: "ignore" });

	child.on("error", (error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") {
			logger.error(
				`Could not open the browser automatically because '${command}' is not available on PATH.`,
			);
			logger.info(`Open this URL manually: ${url}`);
			return;
		}
		logger.error(`Could not open the browser automatically: ${error.message}`);
		logger.info(`Open this URL manually: ${url}`);
	});

	child.unref();
}

/**
 * Open a Camunda web application in the default browser.
 */
export async function openApp(
	app: string | undefined,
	options: { profile?: string; dryRun?: boolean },
): Promise<void> {
	const logger = getLogger();

	if (!app) {
		logger.error(`Application required. Available: ${OPEN_APPS.join(", ")}`);
		logger.info("Usage: c8 open <app> [--profile <name>]");
		process.exit(1);
	}

	if (!isAppName(app)) {
		logger.error(
			`Unknown application '${app}'. Available: ${OPEN_APPS.join(", ")}`,
		);
		logger.info("Usage: c8 open <app> [--profile <name>]");
		process.exit(1);
	}

	const config = resolveClusterConfig(options.profile);
	const url = deriveAppUrl(config.baseUrl, app);

	if (!url) {
		logger.error(`Cannot derive ${app} URL from base URL: ${config.baseUrl}`);
		logger.info(
			"The open command is only supported for self-managed clusters whose base URL ends with /v<n> (e.g. http://localhost:8080/v2).",
		);
		process.exit(1);
	}

	logger.info(`Opening ${app} at: ${url}`);
	if (!options.dryRun) {
		openUrl(url);
	}
}
