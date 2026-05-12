/**
 * c8ctl-plugin-bpmn
 *
 * Lint BPMN diagrams against recommended and Camunda rules.
 *
 * Usage:
 *   c8ctl bpmn lint <file.bpmn>
 *   cat file.bpmn | c8ctl bpmn lint
 */

import type {
	PluginCommands,
	PluginMetadata,
} from "../../src/plugin-loader.ts";
import type {} from "../../src/runtime.ts";
import { lintSubcommand } from "./lint.ts";

const c8ctl = globalThis.c8ctl!;

// Ambient module declarations for the untyped bpmn-io ecosystem live in
// ./bpmn-io.d.ts (TS does not allow `declare module` inside module files
// for modules that resolve to actual files).

/**
 * Reinject flags pre-parsed by the host (#366/#367) back into the args
 * array as `--name value` / `--name` tokens, so the plugin's hand-rolled
 * `parseArgs` still sees them.
 */
function injectFlagsIntoArgs(
	args: readonly string[],
	flags: Record<string, unknown> | undefined,
): string[] {
	const out = [...args];
	if (!flags) {
		return out;
	}
	for (const [name, value] of Object.entries(flags)) {
		if (value === undefined || value === null) {
			continue;
		}
		if (typeof value === "boolean") {
			if (value) {
				out.push(`--${name}`);
			}
		} else if (Array.isArray(value)) {
			for (const item of value) {
				if (item !== undefined && item !== null) {
					out.push(`--${name}`, String(item));
				}
			}
		} else {
			out.push(`--${name}`, String(value));
		}
	}
	return out;
}

async function bpmnHandler(
	args: string[] | undefined,
	flags?: Record<string, unknown>,
): Promise<void> {
	const reinjected = injectFlagsIntoArgs(args ?? [], flags);
	const subcommand = reinjected[0];
	const subArgs = reinjected.slice(1);

	const validSubcommands = metadata.commands.bpmn.subcommands.map(
		(s) => s.name as string,
	);
	if (!subcommand || !validSubcommands.includes(subcommand)) {
		const logger = c8ctl.getLogger();
		const lead = subcommand
			? `Unknown subcommand '${subcommand}'.`
			: "c8ctl bpmn requires a subcommand.";
		logger.info(`${lead} Available: ${validSubcommands.join(", ")}`);
		logger.info("Run 'c8ctl bpmn --help' for full usage.");
		process.exitCode = 1;
		return;
	}

	try {
		if (subcommand === "lint") await lintSubcommand(subArgs);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const logger = c8ctl.getLogger();
		logger.error(`Failed to bpmn ${subcommand}: ${message}`);
		process.exitCode = 1;
	}
}

// ---------------------------------------------------------------------------
// Plugin API
// ---------------------------------------------------------------------------

export const metadata = {
	name: "bpmn",
	description: "Lint BPMN diagrams",
	commands: {
		bpmn: {
			description: "BPMN tooling — lint diagrams (supports stdin piping)",
			helpDescription:
				"Lint BPMN diagrams. Supports file paths and stdin piping.\n\n" +
				"Rule configuration: a .bpmnlintrc in the working directory takes precedence. " +
				"Otherwise the linter extends bpmnlint:recommended plus the matching " +
				"camunda-compat/camunda-cloud-<version> ruleset, auto-detected from " +
				"modeler:executionPlatformVersion in the BPMN file.",
			subcommands: [
				{
					name: "lint",
					description:
						"Lint a BPMN diagram against recommended and Camunda rules",
				},
			],
			examples: [
				{
					command: "c8ctl bpmn lint process.bpmn",
					description: "Lint a BPMN file with Camunda rules",
				},
				{
					command: "cat process.bpmn | c8ctl bpmn lint",
					description: "Lint from stdin",
				},
				{
					command: "c8ctl bpmn lint --quiet process.bpmn",
					description: "Suppress the success line in scripts",
				},
			],
		},
	},
} as const satisfies PluginMetadata;

export const commands = {
	bpmn: {
		flags: {
			quiet: {
				type: "boolean",
				short: "q",
				description: 'Suppress the "No issues found." line on a clean lint',
			},
		},
		handler: bpmnHandler,
	},
} satisfies PluginCommands;
