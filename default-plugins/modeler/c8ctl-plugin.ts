/**
 * c8ctl-plugin-modeler
 *
 * Install Camunda Desktop Modeler on macOS, Windows, or Linux.
 *
 * Usage:
 *   c8ctl modeler install
 */

import { renderCommandFailure } from "../../src/core/index.ts";
import type {
	PluginCommands,
	PluginCtx,
	PluginMetadata,
} from "../../src/framework/plugins/plugin-loader.ts";
import { installDesktopModeler } from "./install.ts";

export const metadata: PluginMetadata = {
	name: "modeler",
	description: "Install Camunda Desktop Modeler",
	commands: {
		modeler: {
			description: "Install Camunda Desktop Modeler",
			helpDescription:
				"Install the latest stable Camunda Desktop Modeler on macOS, Windows, or Linux, skipping the installation when Modeler is already installed. On macOS, uses Homebrew when available, and otherwise installs the Camunda-signed release into /Applications (or ~/Applications when /Applications is not writable). On Windows, installs it with winget into %LOCALAPPDATA%\\Programs\\Camunda Modeler, then registers its file types and adds it to the Start Menu. On Linux (x64), installs the release into /usr/bin as root, using sudo, as the Camunda documentation describes, then registers its file types with the bundled support/xdg_register.sh.",
			subcommands: [
				{
					name: "install",
					description: "Install the latest stable Camunda Desktop Modeler",
				},
			],
			examples: [
				{
					command: "c8ctl modeler install",
					description: "Install the latest stable Camunda Desktop Modeler",
				},
			],
		},
	},
};

async function modelerHandler(
	args: string[],
	_flags: Record<string, unknown> | undefined,
	ctx?: PluginCtx,
): Promise<void> {
	if (!ctx) throw new Error("modeler requires the plugin host context");
	const { logger } = ctx;

	if (args[0] !== "install") {
		if (args[0] === undefined) {
			logger.info(
				"\nUsage: c8ctl modeler install\n\nAvailable resources:\n  install",
				{
					essential: true,
				},
			);
		} else {
			logger.error(`Unknown command: modeler ${args.join(" ")}`);
			logger.info('Run "c8 help" for usage information', { essential: true });
		}
		process.exitCode = 1;
		return;
	}

	try {
		const result = await installDesktopModeler({
			isDryRun: ctx.dryRun,
			logger,
			quiet: ctx.quiet,
		});
		if (result.kind === "dryRun") {
			logger.json(result.info);
		} else if (result.kind === "info") {
			logger.info(result.message, { essential: true });
		} else {
			logger.success(result.message);
		}
	} catch (error) {
		renderCommandFailure(logger, "Failed to modeler install", error, {
			verbose: ctx.verbose,
		});
		process.exitCode = 1;
	}
}

export const commands: PluginCommands = {
	modeler: { flags: {}, handler: modelerHandler },
};
