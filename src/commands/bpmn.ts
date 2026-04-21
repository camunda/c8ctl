/**
 * BPMN tooling commands — lint diagrams.
 */

import {
	closeSync,
	existsSync,
	openSync,
	readFileSync,
	readSync,
} from "node:fs";
import { createRequire } from "node:module";
import { resolve as resolvePath } from "node:path";
import type { CommandResult } from "../command-framework.ts";
import { defineCommand } from "../command-framework.ts";
import { SilentError } from "../errors.ts";
import { c8ctl } from "../runtime.ts";

// bpmnlint is CJS — use createRequire to load it and its resolver
const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export interface BpmnInput {
	xml: string;
	source: string;
}

/**
 * Read BPMN XML from a file path or stdin.
 * Returns null if no input is available.
 */
export function readBpmnInput(filePath: string | undefined): BpmnInput | null {
	if (filePath) {
		const resolved = resolvePath(filePath);
		if (!existsSync(resolved)) {
			throw new Error(`File not found: ${filePath}`);
		}
		return { xml: readFileSync(resolved, "utf-8"), source: resolved };
	}

	// Read from stdin if not a TTY
	if (!process.stdin.isTTY) {
		const chunks: Buffer[] = [];
		const fd = openSync("/dev/stdin", "r");
		const buf = Buffer.alloc(65536);
		let bytesRead = readSync(fd, buf, 0, buf.length, null);
		while (bytesRead > 0) {
			chunks.push(buf.subarray(0, bytesRead));
			bytesRead = readSync(fd, buf, 0, buf.length, null);
		}
		closeSync(fd);
		const xml = Buffer.concat(chunks).toString("utf-8");
		if (!xml.trim()) {
			return null;
		}
		return { xml, source: "stdin" };
	}

	return null;
}

// ---------------------------------------------------------------------------
// Lint internals
// ---------------------------------------------------------------------------

interface RootElement {
	$attrs?: Record<string, string>;
}

interface LintReport {
	category: string;
	id?: string;
	message: string;
	name?: string;
	path?: unknown;
}

/**
 * Extract executionPlatformVersion from BPMN definitions attributes.
 * Returns e.g. "8.8" or null if not present / not Camunda Cloud.
 */
function detectCamundaCloudVersion(rootElement: RootElement): string | null {
	const attrs = rootElement.$attrs ?? {};
	const platform = attrs["modeler:executionPlatform"];
	const version = attrs["modeler:executionPlatformVersion"];

	if (platform !== "Camunda Cloud" || !version) {
		return null;
	}

	const match = version.match(/^(\d+\.\d+)/);
	return match ? match[1] : null;
}

/**
 * Resolve the camunda-compat config name for a given version.
 * Falls back to the highest available config if the exact version isn't supported.
 */
function resolveCamundaCompatConfig(version: string): string | null {
	const plugin = require("bpmnlint-plugin-camunda-compat");
	const configs: Record<string, unknown> = plugin.configs;

	const configName = `camunda-cloud-${version.replace(".", "-")}`;
	if (configs[configName]) {
		return `plugin:camunda-compat/${configName}`;
	}

	const cloudConfigs = Object.keys(configs)
		.filter((k) => k.startsWith("camunda-cloud-"))
		.sort();

	if (cloudConfigs.length > 0) {
		const fallback = cloudConfigs[cloudConfigs.length - 1];
		return `plugin:camunda-compat/${fallback}`;
	}

	return null;
}

/**
 * Build linter config: use local .bpmnlintrc if present, otherwise
 * build defaults based on the BPMN file's executionPlatformVersion.
 */
function buildLintConfig(rootElement: RootElement): {
	extends: string[];
} {
	const rcPath = resolvePath(".bpmnlintrc");
	if (existsSync(rcPath)) {
		return JSON.parse(readFileSync(rcPath, "utf-8"));
	}

	const config = {
		extends: ["bpmnlint:recommended"],
	};

	const version = detectCamundaCloudVersion(rootElement);
	if (version) {
		const compatConfig = resolveCamundaCompatConfig(version);
		if (compatConfig) {
			config.extends.push(compatConfig);
		}
	}

	return config;
}

/**
 * Count and format lint results. Returns text lines and counts.
 */
function formatLintResults(results: Record<string, LintReport[]>): {
	lines: string[];
	errorCount: number;
	warningCount: number;
	issues: Array<Record<string, unknown>>;
} {
	let errorCount = 0;
	let warningCount = 0;
	const lines: string[] = [];
	const issues: Array<Record<string, unknown>> = [];

	for (const [ruleName, reports] of Object.entries(results)) {
		for (const report of reports) {
			const { category, id = "", message, name: reportName, path } = report;

			let elementRef = id;
			if (path) {
				const { pathStringify } = require("@bpmn-io/moddle-utils");
				elementRef = `${id}#${pathStringify(path)}`;
			}

			const displayName = reportName ?? ruleName;
			const prefix = category === "error" ? "error" : "warning";

			lines.push(`  ${elementRef}  ${prefix}  ${message}  ${displayName}`);

			issues.push({
				rule: reportName ?? ruleName,
				elementId: id || null,
				message,
				category: category === "warn" ? "warning" : category,
				...(path ? { path } : {}),
			});

			if (category === "error") {
				errorCount++;
			} else {
				warningCount++;
			}
		}
	}

	return { lines, errorCount, warningCount, issues };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export const lintBpmnCommand = defineCommand(
	"bpmn",
	"lint",
	async (ctx, _flags, args): Promise<CommandResult> => {
		const { logger } = ctx;
		const filePath = args.file;

		const input = readBpmnInput(filePath);
		if (!input) {
			throw new Error(
				"No BPMN input provided. Pass a file path or pipe BPMN XML via stdin.",
			);
		}

		// Parse BPMN XML
		// @ts-expect-error — bpmn-moddle has no type declarations
		const BpmnModdle = (await import("bpmn-moddle")).default;
		const zeebeSchema = (
			await import("zeebe-bpmn-moddle/resources/zeebe.json", {
				with: { type: "json" },
			})
		).default;

		const moddle = new BpmnModdle({ zeebe: zeebeSchema });

		let rootElement: RootElement;
		try {
			const result = await moddle.fromXML(input.xml);
			rootElement = result.rootElement;
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`Failed to parse BPMN: ${message}`);
		}

		// Build config and lint
		const config = buildLintConfig(rootElement);
		const { Linter } = require("bpmnlint");
		const NodeResolver = require("bpmnlint/lib/resolver/node-resolver");

		const linter = new Linter({ config, resolver: new NodeResolver() });
		const results: Record<string, LintReport[]> =
			await linter.lint(rootElement);

		const { lines, errorCount, warningCount, issues } =
			formatLintResults(results);

		// JSON mode
		if (c8ctl.outputMode === "json") {
			logger.json({
				file: input.source,
				issues,
				errorCount,
				warningCount,
			});
			if (errorCount > 0) {
				throw new SilentError("Lint errors found");
			}
			return { kind: "none" };
		}

		// Text mode
		const problemCount = errorCount + warningCount;
		if (problemCount > 0) {
			logger.output("");
			logger.output(resolvePath(input.source));
			for (const line of lines) {
				logger.output(line);
			}

			const pluralize = (word: string, count: number) =>
				count === 1 ? word : `${word}s`;
			logger.output("");
			logger.output(
				`\u2716 ${problemCount} ${pluralize("problem", problemCount)} ` +
					`(${errorCount} ${pluralize("error", errorCount)}, ` +
					`${warningCount} ${pluralize("warning", warningCount)})`,
			);
		}

		if (errorCount > 0) {
			throw new SilentError("Lint errors found");
		}

		return { kind: "none" };
	},
);
