/**
 * c8ctl-plugin-modeler
 *
 * Manage Camunda Desktop Modeler on macOS, Windows, or Linux.
 *
 * Usage:
 *   c8ctl modeler install
 *   c8ctl modeler update
 *   c8ctl modeler uninstall
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
					name: "uninstall",
					description:
						"Remove a c8ctl-managed Camunda Desktop Modeler installation",
				},
				{
					name: "remove",
					description: "Alias for uninstall",
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
					command: "c8ctl modeler uninstall --dry-run",
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
			"\nUsage: c8ctl modeler <install|update|uninstall>\n\nAvailable commands:\n  install\n  update\n  uninstall",
			{ essential: true },
		);
		process.exitCode = 1;
		return;
	}
	// `remove` is the pre-uninstall spelling, kept as a compatibility
	// alias; payloads and failure messages use the canonical name.
	const canonicalAction = action === "remove" ? "uninstall" : action;
	if (
		canonicalAction !== "install" &&
		canonicalAction !== "update" &&
		canonicalAction !== "uninstall"
	) {
		logger.error(`Unknown command: modeler ${args.join(" ")}`);
		logger.info('Run "c8 help" for usage information', { essential: true });
		process.exitCode = 1;
		return;
	}

	try {
		if (canonicalAction === "uninstall" && ctx.unrecognizedFlags?.length) {
			throw new Error(
				`Unknown flag${ctx.unrecognizedFlags.length === 1 ? "" : "s"} ${ctx.unrecognizedFlags.join(", ")} for 'modeler uninstall'. Fix or remove the flag before removing Camunda Modeler.`,
			);
		}
		const suspiciousFlagValue = ctx.suspiciousFlagValues?.[0];
		if (canonicalAction === "uninstall" && suspiciousFlagValue !== undefined) {
			throw new Error(
				`"${suspiciousFlagValue}" looks like a flag but was passed as a value. Fix the invocation before removing Camunda Modeler.`,
			);
		}
		const operation = {
			install: installDesktopModeler,
			update: updateDesktopModeler,
			uninstall: removeDesktopModeler,
		}[canonicalAction];
		const result = await operation({
			isDryRun: ctx.dryRun,
			logger,
			quiet: ctx.quiet,
			...(canonicalAction === "uninstall"
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
							command: `modeler ${canonicalAction}`,
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
		renderCommandFailure(
			logger,
			`Failed to ${canonicalAction} Camunda Modeler`,
			error,
			{
				verbose: ctx.verbose,
			},
		);
		process.exitCode = 1;
	}
}

export const commands: PluginCommands = {
	modeler: { flags: {}, handler: modelerHandler },
};
