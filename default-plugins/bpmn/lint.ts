/**
 * BPMN lint internals — bpmnlint driver, config resolution, and the
 * collect-then-render split that powers `c8ctl bpmn lint`. The plugin
 * file (./c8ctl-plugin.ts) only handles host glue and CLI dispatch.
 */

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { styleText } from "node:util";
import { pathStringify } from "@bpmn-io/moddle-utils";
import type { BpmnModdleElement } from "bpmn-moddle";
import type { LintReport, LintResults } from "bpmnlint";
import type { Logger } from "../../src/core/logger.ts";
import type {} from "../../src/core/runtime.ts";

if (!globalThis.c8ctl) throw new Error("c8ctl runtime not initialised");
const c8ctl = globalThis.c8ctl;
const require = createRequire(import.meta.url);

function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === "object" && !Array.isArray(value);
}

type StaticResolverLike = {
	resolveRule(pkg: string, ruleName: string): unknown;
	resolveConfig(pkg: string, configName: string): unknown;
};

type BpmnlintVendor = {
	Linter: new (opts: {
		config: unknown;
		resolver: StaticResolverLike;
	}) => { lint(rootElement: unknown): Promise<LintResults> };
	makeResolver: () => StaticResolverLike;
	camundaCompatConfigNames: string[];
};

function isBpmnlintVendor(value: unknown): value is BpmnlintVendor {
	return (
		isRecord(value) &&
		typeof value.Linter === "function" &&
		typeof value.makeResolver === "function" &&
		Array.isArray(value.camundaCompatConfigNames)
	);
}

let cachedVendor: BpmnlintVendor | null = null;

/**
 * Load the prebuilt bpmnlint static-resolver vendor bundle. bpmnlint's default
 * NodeResolver resolves rules and configs via runtime `require()` against the
 * CWD, which cannot work in the self-contained published CLI. The bundle
 * (built by `scripts/build-bpmnlint-vendor.mjs`) inlines every rule and config
 * and is loaded here in both dev and prod for a single code path:
 *   - dev:        default-plugins/bpmn/lint.ts → ../../dist/vendor/bpmnlint.cjs
 *   - production: dist/default-plugins/bpmn/c8ctl-plugin.js → ../../vendor/bpmnlint.cjs
 */
function loadBpmnlintVendor(): BpmnlintVendor {
	if (cachedVendor) return cachedVendor;
	const dir = dirname(fileURLToPath(import.meta.url));
	const candidates = [
		resolvePath(dir, "..", "..", "dist", "vendor", "bpmnlint.cjs"),
		resolvePath(dir, "..", "..", "vendor", "bpmnlint.cjs"),
	];
	for (const path of candidates) {
		if (existsSync(path)) {
			const loaded: unknown = require(path);
			if (!isBpmnlintVendor(loaded)) {
				throw new Error(`Invalid bpmnlint vendor bundle at ${path}`);
			}
			cachedVendor = loaded;
			return loaded;
		}
	}
	throw new Error(
		"bpmnlint vendor bundle not found. Run `npm run build:vendor` to build it.\n" +
			`Searched: ${candidates.join(", ")}`,
	);
}

type BpmnInput = { xml: string; source: string };

type Severity = "error" | "warning";

type LintIssue = {
	rule: string;
	elementId: string | null;
	message: string;
	category: Severity;
	path?: ReadonlyArray<string | number>;
};

type LintRow = {
	elementRef: string;
	severity: Severity;
	message: string;
	displayName: string;
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
export async function readBpmnInput(
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

export async function createBpmnModdle() {
	const BpmnModdle = (await import("bpmn-moddle")).default;
	const zeebeSchema = (
		await import("zeebe-bpmn-moddle/resources/zeebe.json", {
			with: { type: "json" },
		})
	).default;
	return new BpmnModdle({ zeebe: zeebeSchema });
}

type PlatformInfo = {
	executionPlatform: string;
	version: string | null;
};

function extractPlatformInfo(
	rootElement: BpmnModdleElement,
): PlatformInfo | null {
	const attrs = rootElement.$attrs ?? {};
	const executionPlatform = attrs["modeler:executionPlatform"];
	if (!executionPlatform) {
		return null;
	}
	const version = attrs["modeler:executionPlatformVersion"] ?? null;
	return { executionPlatform, version };
}

function detectCamundaCloudVersion(
	rootElement: BpmnModdleElement,
): string | null {
	const info = extractPlatformInfo(rootElement);
	if (!info || info.executionPlatform !== "Camunda Cloud" || !info.version) {
		return null;
	}
	const match = info.version.match(/^(\d+\.\d+)/);
	return match ? match[1] : null;
}

type ConfigResolution =
	| { kind: "exact"; config: string }
	| { kind: "above-range"; config: string; highest: string }
	| { kind: "below-range"; lowest: string };

function parseVersionParts(s: string): number[] {
	return s.replace("camunda-cloud-", "").split("-").map(Number);
}

function compareVersionParts(a: number[], b: number[]): number {
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const diff = (a[i] || 0) - (b[i] || 0);
		if (diff !== 0) {
			return diff;
		}
	}
	return 0;
}

function resolveCamundaCompatConfig(version: string): ConfigResolution | null {
	const configNames = loadBpmnlintVendor().camundaCompatConfigNames;

	const configName = `camunda-cloud-${version.replace(".", "-")}`;
	if (configNames.includes(configName)) {
		return { kind: "exact", config: `plugin:camunda-compat/${configName}` };
	}

	const cloudConfigs = configNames
		.filter((k) => k.startsWith("camunda-cloud-"))
		.sort((a, b) =>
			compareVersionParts(parseVersionParts(a), parseVersionParts(b)),
		);

	if (cloudConfigs.length === 0) {
		return null;
	}

	const requested = parseVersionParts(
		`camunda-cloud-${version.replace(".", "-")}`,
	);
	const lowest = cloudConfigs[0];
	const highest = cloudConfigs[cloudConfigs.length - 1];

	if (compareVersionParts(requested, parseVersionParts(lowest)) < 0) {
		return { kind: "below-range", lowest };
	}

	return {
		kind: "above-range",
		config: `plugin:camunda-compat/${highest}`,
		highest,
	};
}

function buildLintConfig(
	rootElement: BpmnModdleElement,
): Record<string, unknown> {
	const rcPath = resolvePath(".bpmnlintrc");
	if (existsSync(rcPath)) {
		const raw = readFileSync(rcPath, "utf-8");
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			throw new Error(
				`Failed to parse .bpmnlintrc: only JSON is supported (${detail}). ` +
					"For YAML or JS configs, use the standalone `bpmnlint` CLI.",
			);
		}
		if (!isRecord(parsed)) {
			throw new Error(".bpmnlintrc must contain a JSON object");
		}
		return parsed;
	}

	const config: { extends: string[] } = { extends: ["bpmnlint:recommended"] };

	const version = detectCamundaCloudVersion(rootElement);
	if (version) {
		const resolution = resolveCamundaCompatConfig(version);
		if (resolution?.kind === "exact" || resolution?.kind === "above-range") {
			config.extends.push(resolution.config);
		}
		if (resolution?.kind === "above-range") {
			c8ctl
				.getLogger()
				.warn(
					`No camunda-compat config for ${version}; falling back to ${resolution.highest}. ` +
						"Update c8ctl for newer rulesets.",
				);
		}
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

	for (const [ruleName, reports] of Object.entries(results)) {
		for (const report of reports) {
			const elementRef = formatElementRef(report, pathStringify);
			const displayName = report.name ?? ruleName;
			const severity: Severity =
				report.category === "error" ? "error" : "warning";
			rows.push({
				elementRef,
				severity,
				message: report.message,
				displayName,
			});

			const issue: LintIssue = {
				rule: report.name ?? ruleName,
				elementId: report.id || null,
				message: report.message,
				category: severity,
			};
			if (report.path) {
				issue.path = report.path;
			}
			issues.push(issue);

			if (severity === "error") errorCount++;
			else warningCount++;
		}
	}

	return { rows, issues, errorCount, warningCount };
}

function renderDryRun(
	logger: Logger,
	source: string,
	platform: PlatformInfo | null,
	config: Record<string, unknown>,
): void {
	const sourceLabel = source === "stdin" ? "stdin" : resolvePath(source);
	if (c8ctl.outputMode === "json") {
		logger.json({
			dryRun: true,
			command: "bpmn lint",
			source: sourceLabel,
			platform,
			config,
		});
		return;
	}

	const platformLabel = platform
		? `${platform.executionPlatform}${platform.version ? ` ${platform.version}` : ""}`
		: "not declared";
	logger.output("Dry run — no lint performed.");
	logger.output(`  Source: ${sourceLabel}`);
	logger.output(`  Platform: ${platformLabel}`);
	logger.output("  Config:");
	const configLines = JSON.stringify(config, null, 2).split("\n");
	for (const line of configLines) {
		logger.output(`    ${line}`);
	}
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
		const severityColor = r.severity === "error" ? "red" : "yellow";
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

	const moddle = await createBpmnModdle();

	let rootElement: BpmnModdleElement;
	try {
		const result = await moddle.fromXML(input.xml);
		rootElement = result.rootElement;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to parse BPMN: ${message}`);
	}

	const config = buildLintConfig(rootElement);

	if (c8ctl.dryRun) {
		renderDryRun(
			logger,
			input.source,
			extractPlatformInfo(rootElement),
			config,
		);
		return;
	}

	const { Linter, makeResolver } = loadBpmnlintVendor();

	// The static-resolver vendor bundle inlines all bpmnlint and
	// camunda-compat rules/configs, so `bpmn lint` resolves them without a
	// runtime CWD lookup and works in the self-contained published CLI.
	const linter = new Linter({
		config,
		resolver: makeResolver(),
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
