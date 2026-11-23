/**
 * c8ctl-plugin-modeler
 *
 * Manage Camunda Desktop Modeler on macOS, Windows, or Linux.
 *
 * Usage:
 *   c8ctl modeler install
 *   c8ctl modeler update
 *   c8ctl modeler remove
 */

import { isRecord, renderCommandFailure } from "../../src/core/index.ts";
import type {
	PluginCommands,
	PluginCtx,
	PluginMetadata,
} from "../../src/framework/plugins/plugin-loader.ts";
import {
	installDesktopModeler,
	type ModelerRemovalTarget,
	removeDesktopModeler,
	updateDesktopModeler,
} from "./install.ts";

export const metadata: PluginMetadata = {
	name: "modeler",
	description: "Manage Camunda Desktop Modeler",
	commands: {
		modeler: {
			description: "Manage Camunda Desktop Modeler",
			helpDescription:
				"Manage Camunda Desktop Modeler on macOS, Windows, or Linux. Install the latest stable release, update it using the same installation method, or remove it. On macOS, uses Homebrew when available and otherwise downloads the Camunda-signed release into /Applications (or ~/Applications when /Applications is not writable). On Windows, uses winget and registers file types and a Start Menu shortcut. On Linux (x64), installs into /usr/bin as root and registers file types with Modeler's bundled support scripts.",
			subcommands: [
				{
					name: "install",
					description: "Install the latest stable Camunda Desktop Modeler",
				},
				{
					name: "update",
					description:
						"Update Camunda Desktop Modeler to the latest stable release",
				},
				{
					name: "remove",
					description:
						"Remove a c8ctl-managed Camunda Desktop Modeler installation",
				},
			],
			examples: [
				{
					command: "c8ctl modeler install",
					description: "Install the latest stable Camunda Desktop Modeler",
				},
				{
					command: "c8ctl modeler update",
					description: "Update Camunda Desktop Modeler",
				},
				{
					command: "c8ctl modeler remove --dry-run",
					description: "Preview removal of Camunda Desktop Modeler",
				},
			],
		},
	},
};

function expectedRemovalTargetFromEnvironment():
	| ModelerRemovalTarget
	| undefined {
	const serialized = process.env.C8CTL_SETUP_MODELER_REMOVAL_TARGET;
	if (serialized === undefined) return undefined;

	let parsed: unknown;
	try {
		parsed = JSON.parse(serialized);
	} catch {
		throw new Error("Invalid setup-provided Modeler removal target.");
	}
	if (
		!isRecord(parsed) ||
		typeof parsed.method !== "string" ||
		parsed.method.length === 0 ||
		typeof parsed.path !== "string" ||
		parsed.path.length === 0
	) {
		throw new Error("Invalid setup-provided Modeler removal target.");
	}
	return { method: parsed.method, path: parsed.path };
}

async function modelerHandler(
	args: string[],
	_flags: Record<string, unknown> | undefined,
	ctx?: PluginCtx,
): Promise<void> {
	if (!ctx) throw new Error("modeler requires the plugin host context");
	const { logger } = ctx;
	const action = args[0];

	if (action === undefined) {
		logger.info(
			"\nUsage: c8ctl modeler <install|update|remove>\n\nAvailable commands:\n  install\n  update\n  remove",
			{ essential: true },
		);
		process.exitCode = 1;
		return;
	}
	if (action !== "install" && action !== "update" && action !== "remove") {
		logger.error(`Unknown command: modeler ${args.join(" ")}`);
		logger.info('Run "c8 help" for usage information', { essential: true });
		process.exitCode = 1;
		return;
	}

	try {
		const operation = {
			install: installDesktopModeler,
			update: updateDesktopModeler,
			remove: removeDesktopModeler,
		}[action];
		const result = await operation({
			isDryRun: ctx.dryRun,
			logger,
			quiet: ctx.quiet,
			...(action === "remove"
				? {
						expectedRemovalTarget: expectedRemovalTargetFromEnvironment(),
					}
				: {}),
		});
		// A dry run owes automation the JSON preview on stdout even when
		// nothing would change (Modeler absent or already current).
		const normalized =
			result.kind === "info" && ctx.dryRun
				? {
						kind: "dryRun" as const,
						info: {
							dryRun: true,
							command: `modeler ${action}`,
							message: result.message,
							wouldChange: false,
						},
					}
				: result;
		if (normalized.kind === "dryRun") {
			logger.json(normalized.info);
		} else if (normalized.kind === "info") {
			logger.info(normalized.message, { essential: true });
		} else {
			logger.success(normalized.message);
		}
	} catch (error) {
		renderCommandFailure(logger, `Failed to ${action} Camunda Modeler`, error, {
			verbose: ctx.verbose,
		});
		process.exitCode = 1;
	}
}

export const commands: PluginCommands = {
	modeler: { flags: {}, handler: modelerHandler },
};
