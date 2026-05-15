/**
 * BPMN lint internals — bpmnlint driver, config resolution, and the
 * collect-then-render split that powers `c8ctl bpmn lint`. The plugin
 * file (./c8ctl-plugin.ts) only handles host glue and CLI dispatch.
 */

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve as resolvePath } from "node:path";
import { styleText } from "node:util";
import type { BpmnModdleElement } from "bpmn-moddle";
import type { LintReport, LintResults } from "bpmnlint";
import type { Logger } from "../../src/logger.ts";
import type {} from "../../src/runtime.ts";

if (!globalThis.c8ctl) throw new Error("c8ctl runtime not initialised");
const c8ctl = globalThis.c8ctl;
const require = createRequire(import.meta.url);

function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === "object" && !Array.isArray(value);
}

type BpmnInput = { xml: string; source: string };

type LintIssue = {
	rule: string;
	elementId: string | null;
	message: string;
	category: string;
	path?: ReadonlyArray<string | number>;
};

type LintRow = {
	elementRef: string;
	severity: "error" | "warning";
	message: string;
	displayName: string;
	category: string;
};

type LintResult = {
	rows: LintRow[];
	issues: LintIssue[];
	errorCount: number;
	warningCount: number;
};

/**
 * Read BPMN XML from a file path or stdin. Returns null if no input is available.
 *
 * Stdin is consumed via async iteration so a slow upstream writer (e.g.
 * `apply | lint` in a pipeline, or any producer that hasn't flushed yet)
 * is awaited until 'end'. Do not use `readFileSync(0)` here — when stdin
 * is a pipe with no buffered data yet, it throws EAGAIN, which gets
 * swallowed and surfaces as "no input".
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

function detectCamundaCloudVersion(
	rootElement: BpmnModdleElement,
): string | null {
	const attrs = rootElement.$attrs ?? {};
	const platform = attrs["modeler:executionPlatform"];
	const version = attrs["modeler:executionPlatformVersion"];
	if (platform !== "Camunda Cloud" || !version) {
		return null;
	}
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
				if (diff !== 0) {
					return diff;
				}
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

/**
 * Flatten bpmnlint's `{ ruleName: [report, ...] }` shape into a typed
 * issue list plus the parallel `rows` list that the text renderer
 * formats into a column-aligned table.
 */
function collectLintResult(results: LintResults): LintResult {
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

	return { rows, issues, errorCount, warningCount };
}

function renderLintJson(
	logger: Logger,
	file: string,
	result: LintResult,
): void {
	logger.json({
		file,
		issues: result.issues,
		errorCount: result.errorCount,
		warningCount: result.warningCount,
	});
}

function renderLintText(
	logger: Logger,
	source: string,
	result: LintResult,
	options: { quiet: boolean },
): void {
	const { rows, errorCount, warningCount } = result;
	const problemCount = errorCount + warningCount;

	if (problemCount === 0) {
		if (!options.quiet) {
			// Mirror the bold red ✖ summary used for problems with a bold green
			// ✓ on success — gives the user an unambiguous "lint ran cleanly"
			// signal instead of trailing silence.
			logger.output(styleText(["bold", "green"], "✓ No issues found."));
		}
		return;
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

	const sourceLabel = source === "stdin" ? "stdin" : resolvePath(source);
	logger.output("");
	logger.output(styleText("underline", sourceLabel));
	for (const r of rows) {
		const severityColor = r.category === "error" ? "red" : "yellow";
		const severityCell = styleText(
			severityColor,
			padEnd(r.severity, widths.severity),
		);
		logger.output(
			[
				" ",
				padEnd(r.elementRef, widths.elementRef),
				severityCell,
				padEnd(r.message, widths.message),
				r.displayName,
			].join("  "),
		);
	}

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
}

export async function lintSubcommand(args: string[]): Promise<void> {
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

	// Reject extra positional args (only one BPMN file is accepted).
	const allPositionals = [
		...positionalArgs,
		...optionArgs.filter((a) => !a.startsWith("-")),
	];
	if (allPositionals.length > 1) {
		throw new Error(`Unexpected argument: ${allPositionals[1]}. ${usage}`);
	}

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

	const result = collectLintResult(results);

	if (c8ctl.outputMode === "json") {
		renderLintJson(logger, input.source, result);
	} else {
		renderLintText(logger, input.source, result, { quiet });
	}

	if (result.errorCount > 0) {
		process.exitCode = 1;
	}
}
