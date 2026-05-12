/**
 * c8ctl-plugin-bpmn
 *
 * Lint BPMN diagrams against recommended and Camunda rules.
 *
 * Usage:
 *   c8ctl bpmn lint <file.bpmn>
 *   cat file.bpmn | c8ctl bpmn lint
 */

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve as resolvePath } from "node:path";
import { styleText } from "node:util";
import type { BpmnModdleElement } from "bpmn-moddle";
import type { LintReport, LintResults } from "bpmnlint";
import type {
	PluginCommands,
	PluginMetadata,
} from "../../src/plugin-loader.ts";
import type {} from "../../src/runtime.ts";

const c8ctl = globalThis.c8ctl!;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === "object" && !Array.isArray(value);
}

// Ambient module declarations for the untyped bpmn-io ecosystem live in
// ./bpmn-io.d.ts (TS does not allow `declare module` inside module files
// for modules that resolve to actual files).

// ---------------------------------------------------------------------------
// Local types
// ---------------------------------------------------------------------------

type BpmnInput = { xml: string; source: string };

type LintRow = {
	elementRef: string;
	severity: "error" | "warning";
	message: string;
	displayName: string;
	category: string;
};

type LintIssue = {
	rule: string;
	elementId: string | null;
	message: string;
	category: string;
	path?: ReadonlyArray<string | number>;
};

type FormattedLintResults = {
	lines: string[];
	errorCount: number;
	warningCount: number;
	issues: LintIssue[];
};

// ---------------------------------------------------------------------------
// Module-scoped require — used for CommonJS bpmnlint internals so we can
// pass the plugin's own `require` to NodeResolver (resolves
// bpmnlint-plugin-camunda-compat from c8ctl's installation, not the user's
// CWD).
// ---------------------------------------------------------------------------

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Metadata
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

/**
 * Read BPMN XML from a file path or stdin. Returns null if no input is available.
 *
 * Stdin is consumed via async iteration so a slow upstream writer (e.g.
 * `apply | lint` in a pipeline, or any producer that hasn't flushed yet)
 * is awaited until 'end'. The previous `readFileSync(0)` implementation
 * raced with the writer: when stdin was a pipe with no buffered data
 * yet, it threw EAGAIN, which was swallowed and reported as "no input".
 */
async function readBpmnInput(
	filePath: string | undefined,
): Promise<BpmnInput | null> {
	if (filePath) {
		const resolved = resolvePath(filePath);
		if (!existsSync(resolved)) {
			throw new Error(`File not found: ${filePath}`);
		}
		return { xml: readFileSync(resolved, "utf-8"), source: resolved };
	}

	if (!process.stdin.isTTY) {
		process.stdin.setEncoding("utf-8");
		let xml = "";
		for await (const chunk of process.stdin) {
			xml += chunk;
		}
		if (!xml.trim()) return null;
		return { xml, source: "stdin" };
	}

	return null;
}

// ---------------------------------------------------------------------------
// Lint internals
// ---------------------------------------------------------------------------

function detectCamundaCloudVersion(
	rootElement: BpmnModdleElement,
): string | null {
	const attrs = rootElement.$attrs ?? {};
	const platform = attrs["modeler:executionPlatform"];
	const version = attrs["modeler:executionPlatformVersion"];
	if (platform !== "Camunda Cloud" || !version) return null;
	const match = version.match(/^(\d+\.\d+)/);
	return match ? match[1] : null;
}

function resolveCamundaCompatConfig(version: string): string | null {
	const plugin = require("bpmnlint-plugin-camunda-compat");
	const configs = plugin.configs;

	const configName = `camunda-cloud-${version.replace(".", "-")}`;
	if (configName in configs) {
		return `plugin:camunda-compat/${configName}`;
	}

	const cloudConfigs = Object.keys(configs)
		.filter((k) => k.startsWith("camunda-cloud-"))
		.sort((a, b) => {
			const parse = (s: string) =>
				s.replace("camunda-cloud-", "").split("-").map(Number);
			const va = parse(a);
			const vb = parse(b);
			for (let i = 0; i < Math.max(va.length, vb.length); i++) {
				const diff = (va[i] || 0) - (vb[i] || 0);
				if (diff !== 0) return diff;
			}
			return 0;
		});

	if (cloudConfigs.length > 0) {
		return `plugin:camunda-compat/${cloudConfigs[cloudConfigs.length - 1]}`;
	}

	return null;
}

function buildLintConfig(
	rootElement: BpmnModdleElement,
): Record<string, unknown> {
	const rcPath = resolvePath(".bpmnlintrc");
	if (existsSync(rcPath)) {
		const parsed: unknown = JSON.parse(readFileSync(rcPath, "utf-8"));
		if (!isRecord(parsed)) {
			throw new Error(".bpmnlintrc must contain a JSON object");
		}
		return parsed;
	}

	const config: { extends: string[] } = { extends: ["bpmnlint:recommended"] };

	const version = detectCamundaCloudVersion(rootElement);
	if (version) {
		const compatConfig = resolveCamundaCompatConfig(version);
		if (compatConfig) config.extends.push(compatConfig);
	}

	return config;
}

function formatLintResults(results: LintResults): FormattedLintResults {
	let errorCount = 0;
	let warningCount = 0;
	const issues: LintIssue[] = [];
	const rows: LintRow[] = [];
	const { pathStringify } = require("@bpmn-io/moddle-utils");

	for (const [ruleName, reports] of Object.entries(results)) {
		for (const report of reports) {
			const elementRef = formatElementRef(report, pathStringify);
			const displayName = report.name ?? ruleName;
			const severity = report.category === "error" ? "error" : "warning";
			rows.push({
				elementRef,
				severity,
				message: report.message,
				displayName,
				category: report.category,
			});

			const issue: LintIssue = {
				rule: report.name ?? ruleName,
				elementId: report.id || null,
				message: report.message,
				category: report.category === "warn" ? "warning" : report.category,
			};
			if (report.path) {
				issue.path = report.path;
			}
			issues.push(issue);

			if (report.category === "error") errorCount++;
			else warningCount++;
		}
	}

	// Compute column widths from the uncolored values so padding lines up
	// regardless of terminal color support.
	const widths = rows.reduce(
		(acc, r) => ({
			elementRef: Math.max(acc.elementRef, r.elementRef.length),
			severity: Math.max(acc.severity, r.severity.length),
			message: Math.max(acc.message, r.message.length),
		}),
		{ elementRef: 0, severity: 0, message: 0 },
	);

	const padEnd = (s: string, n: number): string =>
		s + " ".repeat(Math.max(0, n - s.length));

	const lines = rows.map((r) => {
		const severityColor = r.category === "error" ? "red" : "yellow";
		const severityCell = styleText(
			severityColor,
			padEnd(r.severity, widths.severity),
		);
		return [
			" ",
			padEnd(r.elementRef, widths.elementRef),
			severityCell,
			padEnd(r.message, widths.message),
			r.displayName,
		].join("  ");
	});

	return { lines, errorCount, warningCount, issues };
}

function formatElementRef(
	report: LintReport,
	pathStringify: (path: ReadonlyArray<string | number>) => string,
): string {
	const id = report.id ?? "";
	if (report.path) {
		return `${id}#${pathStringify(report.path)}`;
	}
	return id;
}

// ---------------------------------------------------------------------------
// Subcommand: lint
// ---------------------------------------------------------------------------

async function lintSubcommand(args: string[]): Promise<void> {
	const logger = c8ctl.getLogger();

	const usage = "Usage: c8ctl bpmn lint [<file.bpmn>] [--quiet | -q]";
	const endOfOpts = args.indexOf("--");
	const optionArgs = endOfOpts === -1 ? args : args.slice(0, endOfOpts);
	const positionalArgs = endOfOpts === -1 ? [] : args.slice(endOfOpts + 1);

	const quiet = optionArgs.includes("--quiet") || optionArgs.includes("-q");

	const unknownFlag = optionArgs.find(
		(a) => a.startsWith("-") && a !== "--quiet" && a !== "-q",
	);
	if (unknownFlag) {
		throw new Error(`Unknown flag: ${unknownFlag}. ${usage}`);
	}

	const filePath =
		positionalArgs[0] ?? optionArgs.find((a) => !a.startsWith("-"));

	const input = await readBpmnInput(filePath);
	if (!input) {
		throw new Error(
			"No BPMN input provided. Pass a file path or pipe BPMN XML via stdin.",
		);
	}

	const BpmnModdle = (await import("bpmn-moddle")).default;
	const zeebeSchema = (
		await import("zeebe-bpmn-moddle/resources/zeebe.json", {
			with: { type: "json" },
		})
	).default;

	const moddle = new BpmnModdle({ zeebe: zeebeSchema });

	let rootElement: BpmnModdleElement;
	try {
		const result = await moddle.fromXML(input.xml);
		rootElement = result.rootElement;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to parse BPMN: ${message}`);
	}

	const config = buildLintConfig(rootElement);
	const { Linter } = require("bpmnlint");
	const NodeResolver = require("bpmnlint/lib/resolver/node-resolver");

	// Pass our plugin-scoped `require` to NodeResolver so bpmnlint resolves
	// `bpmnlint-plugin-camunda-compat` from c8ctl's installation, not the
	// user's CWD. Without this, `bpmn lint` only works when run from a
	// directory that happens to have the plugin in its node_modules.
	const linter = new Linter({
		config,
		resolver: new NodeResolver({ require }),
	});
	const results = await linter.lint(rootElement);

	const { lines, errorCount, warningCount, issues } =
		formatLintResults(results);

	if (c8ctl.outputMode === "json") {
		logger.json({
			file: input.source,
			issues,
			errorCount,
			warningCount,
		});
		if (errorCount > 0) {
			process.exitCode = 1;
		}
		return;
	}

	const problemCount = errorCount + warningCount;
	if (problemCount > 0) {
		const sourceLabel =
			input.source === "stdin" ? "stdin" : resolvePath(input.source);
		logger.output("");
		logger.output(styleText("underline", sourceLabel));
		for (const line of lines) logger.output(line);

		const pluralize = (word: string, count: number): string =>
			count === 1 ? word : `${word}s`;
		const summary =
			`✖ ${problemCount} ${pluralize("problem", problemCount)} ` +
			`(${errorCount} ${pluralize("error", errorCount)}, ` +
			`${warningCount} ${pluralize("warning", warningCount)})`;
		const summaryColor: ReadonlyArray<"bold" | "red" | "yellow"> =
			errorCount > 0 ? ["bold", "red"] : ["bold", "yellow"];
		logger.output("");
		logger.output(styleText(summaryColor, summary));
	} else if (!quiet) {
		// Mirror the bold red ✖ summary used for problems with a bold green
		// ✓ on success — gives the user an unambiguous "lint ran cleanly"
		// signal instead of trailing silence.
		logger.output(styleText(["bold", "green"], "✓ No issues found."));
	}

	if (errorCount > 0) {
		process.exitCode = 1;
	}
}

// ---------------------------------------------------------------------------
// Plugin commands export
// ---------------------------------------------------------------------------

function printSubcommandHint(unknownSubcommand?: string): void {
	const logger = c8ctl.getLogger();
	const names = metadata.commands.bpmn.subcommands
		.map((s) => s.name)
		.join(", ");
	const lead = unknownSubcommand
		? `Unknown subcommand '${unknownSubcommand}'.`
		: "c8ctl bpmn requires a subcommand.";
	logger.info(`${lead} Available: ${names}`);
	logger.info("Run 'c8ctl bpmn --help' for full usage.");
}

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
	if (!flags) return out;
	for (const [name, value] of Object.entries(flags)) {
		if (value === undefined || value === null) continue;
		if (typeof value === "boolean") {
			if (value) out.push(`--${name}`);
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

	if (subcommand !== "lint") {
		printSubcommandHint(subcommand);
		process.exitCode = 1;
		return;
	}

	try {
		await lintSubcommand(subArgs);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const logger = c8ctl.getLogger();
		logger.error(`Failed to bpmn ${subcommand}: ${message}`);
		process.exitCode = 1;
	}
}

export const commands = {
	bpmn: {
		flags: {
			quiet: {
				type: "boolean",
				short: "q",
				description:
					'Suppress the "No issues found." line on a clean lint (lint only)',
			},
		},
		handler: bpmnHandler,
	},
} satisfies PluginCommands;
