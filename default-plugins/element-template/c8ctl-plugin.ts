/**
 * c8ctl-plugin-element-template
 *
 * Apply Camunda element templates to BPMN elements and inspect template properties.
 *
 * Usage:
 *   c8ctl element-template apply <template> <element-id> [<file.bpmn>] [--in-place] [--set key=value]
 *   c8ctl element-template info <template>
 *   c8ctl element-template get-properties <template> [<name>...] [--group <id>] [--detailed]
 *   c8ctl element-template get <template>
 *   c8ctl element-template search <query>
 *   c8ctl element-template sync [--prune]
 *
 * <template> can be a local path, an https:// URL, or an OOTB template id
 * (optionally pinned, e.g. io.camunda.connectors.HttpJson.v2@13).
 * GitHub blob URLs are auto-rewritten to raw.githubusercontent.com.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { styleText } from "node:util";

import {
	applySetOverrides,
	BINDING_TYPE_SHORTHANDS,
	getPropertyDetail,
	getSettableProperties,
	globToRegex,
	type PluginLogger,
	type PropertyDetail,
	parseArgs,
	parseTemplateJson,
	readFileOrUrl,
	type Template,
	type TemplateProperty,
	warnUnmetConditions,
} from "./helpers.ts";
import {
	bootstrapIfNeeded,
	findById,
	loadCache,
	nudgeIfStale,
	pickVersion,
	searchTemplates,
	syncTemplates,
} from "./marketplace.ts";

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Local types
// ---------------------------------------------------------------------------

type SubcommandMeta = { name: string; description: string };
type FlagMeta = {
	type: "string" | "boolean";
	description: string;
	short?: string;
};
type ExampleMeta = { command: string; description: string };
type CommandMeta = {
	description: string;
	helpDescription?: string;
	subcommands?: readonly SubcommandMeta[];
	flags?: Record<string, FlagMeta>;
	examples?: readonly ExampleMeta[];
};
type PluginMetadata = {
	name: string;
	description: string;
	commands: Record<string, CommandMeta>;
};

type BpmnInput = { xml: string; source: string };

type TemplateRefUrl = { kind: "url"; value: string };
type TemplateRefPath = { kind: "path"; value: string };
type TemplateRefId = { kind: "id"; id: string; version: number | undefined };
type TemplateRef = TemplateRefUrl | TemplateRefPath | TemplateRefId;

type LoadedTemplate = {
	template: Template;
	allDetails: PropertyDetail[];
	groupLabelMap: Map<string, string>;
	sourceByDetail: WeakMap<PropertyDetail, TemplateProperty>;
	autoResolvedVersion: boolean;
};

type InspectArgs = {
	help: boolean;
	templateArg: string | undefined;
	propertyArgs: string[];
	groups: string[];
	detailed: boolean;
};

// Minimal vendor-bundle surface — the bundle is loaded via require() with
// an absolute path, so we type the local destination instead of declaring
// the module name. Everything beyond this surface stays as `unknown` and
// gets narrowed at the use site.
type ElementRegistry = { get(id: string): unknown };
type ElementTemplatesService = {
	set(templates: Template[]): void;
	applyTemplate(element: unknown, template: Template): void;
};
type ModelerInstance = {
	importXML(xml: string): Promise<unknown>;
	get(name: "elementRegistry"): ElementRegistry;
	get(name: "elementTemplates"): ElementTemplatesService;
	get(name: string): unknown;
	saveXML(options: { format?: boolean }): Promise<{ xml: string }>;
};
type ModelerCtor = new (options: {
	additionalModules: unknown[];
	moddleExtensions: Record<string, unknown>;
}) => ModelerInstance;
type VendorBundle = {
	Modeler: ModelerCtor;
	CloudElementTemplatesCoreModule: unknown;
	ZeebeModdleExtension: unknown;
	HeadlessTextRendererModule: unknown;
};

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

export const metadata = {
	name: "element-template",
	description: "Apply, inspect, and export Camunda element templates",
	commands: {
		"element-template": {
			description: "Apply, inspect, and export Camunda element templates",
			helpDescription:
				"Apply Camunda element templates to BPMN elements, inspect template metadata and properties, " +
				"search the out-of-the-box template catalogue, export raw template JSON, " +
				"and manage the local template cache.\n\n" +
				"<template> is a local path, an https:// URL, or an OOTB template id (optionally @<version>).",
			subcommands: [
				{
					name: "search",
					description: "Search out-of-the-box element templates",
				},
				{
					name: "info",
					description: "Show template metadata and a compact property table",
				},
				{
					name: "get-properties",
					description:
						"Show detail cards for one or more properties (or all if none given)",
				},
				{
					name: "apply",
					description: "Apply a Camunda element template to a BPMN element",
				},
				{
					name: "get",
					description: "Print the raw template JSON to stdout (pipe-friendly)",
				},
				{
					name: "sync",
					description: "Refresh the local OOTB element template cache",
				},
			],
			flags: {
				"in-place": {
					type: "boolean",
					short: "i",
					description: "Modify the BPMN file in place (apply only)",
				},
				set: {
					type: "string",
					description: "Set a template property value (repeatable, apply only)",
				},
				detailed: {
					type: "boolean",
					short: "d",
					description:
						"Render full detail cards instead of the condensed list (get-properties)",
				},
				group: {
					type: "string",
					description:
						"Filter to one or more group ids (repeatable; get-properties only)",
				},
				prune: {
					type: "boolean",
					description: "Drop cached entries no longer in the index (sync only)",
				},
			},
			examples: [
				{
					command: 'c8ctl element-template search "AWS S3"',
					description: "Search OOTB templates by name",
				},
				{
					command:
						"c8ctl element-template info io.camunda.connectors.HttpJson.v2",
					description:
						"Show the template metadata card (id, version, applies-to, engines, docs)",
				},
				{
					command:
						"c8ctl element-template get-properties io.camunda.connectors.HttpJson.v2",
					description:
						"List every settable property as a condensed name + description row",
				},
				{
					command:
						"c8ctl element-template get-properties io.camunda.connectors.HttpJson.v2 --detailed 'authentication.*'",
					description:
						"Drill into specific properties as full detail cards (quote globs to avoid shell expansion)",
				},
				{
					command:
						"c8ctl element-template get-properties io.camunda.connectors.HttpJson.v2 --group authentication --group endpoint",
					description:
						"Filter to one or more group ids (use the id, not the label — `info` shows the available group ids)",
				},
				{
					command:
						"c8ctl element-template apply io.camunda.connectors.HttpJson.v2 Task_1 process.bpmn",
					description:
						"Apply an OOTB template (latest compatible with the BPMN engine version)",
				},
				{
					command:
						"c8ctl element-template apply io.camunda.connectors.HttpJson.v2@13 Task_1 process.bpmn",
					description: "Apply a specific OOTB template version",
				},
				{
					command:
						"c8ctl element-template apply template.json Task_1 process.bpmn",
					description: "Apply a template from a local file or URL",
				},
				{
					command:
						"c8ctl element-template get io.camunda.connectors.HttpJson.v2 > template.json",
					description:
						"Print the raw template JSON to stdout (redirect to save a copy)",
				},
				{
					command: "c8ctl element-template sync",
					description: "Refresh the local OOTB element template cache",
				},
			],
		},
	},
} as const satisfies PluginMetadata;

// ---------------------------------------------------------------------------
// Runtime helpers
// ---------------------------------------------------------------------------

function getLogger(): PluginLogger {
	if (globalThis.c8ctl) return globalThis.c8ctl.getLogger();
	return {
		info: (message) => console.log(message),
		warn: (message) => console.warn(message),
		error: (message) => console.error(message),
		debug: () => {},
		output: (content) => console.log(content),
		json: (data) => console.log(JSON.stringify(data, null, 2)),
	};
}

function isJsonMode(): boolean {
	return globalThis.c8ctl?.outputMode === "json";
}

/**
 * Read BPMN XML from a file path or stdin. See bpmn plugin for context on
 * why stdin is consumed via async iteration rather than readFileSync(0).
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

/**
 * Classify a template argument as one of:
 *   - { kind: 'url', value }
 *   - { kind: 'path', value }
 *   - { kind: 'id', id, version? }
 *
 * Detection rules (in order):
 *   1. starts with http:// or https://  → URL
 *   2. contains / or \, starts with `.`, or ends with .json → path
 *   3. matches `<id>` or `<id>@<n>`  → id
 */
function parseTemplateRef(arg: string | undefined): TemplateRef | null {
	if (!arg) return null;
	if (/^https?:\/\//.test(arg)) return { kind: "url", value: arg };
	if (
		arg.includes("/") ||
		arg.includes("\\") ||
		arg.startsWith(".") ||
		arg.toLowerCase().endsWith(".json")
	) {
		return { kind: "path", value: arg };
	}
	const match = arg.match(/^([^@\s]+?)(?:@(\d+))?$/);
	if (!match) return { kind: "path", value: arg };
	return {
		kind: "id",
		id: match[1],
		version: match[2] !== undefined ? Number(match[2]) : undefined,
	};
}

function getExecutionPlatformVersion(xml: string): string | null {
	const match = xml.match(
		/modeler:executionPlatformVersion\s*=\s*["']([^"']+)["']/,
	);
	return match ? match[1] : null;
}

async function readTemplateFromPathOrUrl(input: string): Promise<Template> {
	const content = await readFileOrUrl(input);
	return parseTemplateJson(content);
}

/**
 * Resolve an `<id>[@<v>]` reference to a single template object using the
 * local cache, bootstrapping if needed. `executionPlatformVersion` (from the
 * BPMN file) drives version selection when no explicit version is pinned.
 */
async function resolveOotbTemplate(
	ref: TemplateRefId,
	{
		executionPlatformVersion,
	}: { executionPlatformVersion?: string | null } = {},
): Promise<Template> {
	const logger = getLogger();
	await bootstrapIfNeeded({ logger });
	nudgeIfStale(logger);

	const candidates = findById(ref.id);
	if (candidates.length === 0) {
		throw new Error(
			`Template '${ref.id}' not found. Run 'c8ctl element-template sync' to refresh the cache, ` +
				"or use 'c8ctl element-template search <query>' to find an id.",
		);
	}

	const picked = pickVersion(candidates, {
		version: ref.version,
		executionPlatformVersion,
	});
	if (!picked) {
		if (ref.version !== undefined) {
			const known = candidates
				.map((t) => t.version)
				.filter((v): v is number => Number.isFinite(Number(v)))
				.sort((a, b) => Number(a) - Number(b));
			const available =
				known.length > 0
					? `Available: ${known.join(", ")}.`
					: "No known versions in cache.";
			throw new Error(
				`Template '${ref.id}' has no version ${ref.version}. ${available}`,
			);
		}
		const available = candidates
			.map((t) => {
				const versionLabel = Number.isFinite(Number(t.version))
					? String(t.version)
					: "unversioned";
				return `${versionLabel} (${t.engines?.camunda || "any"})`;
			})
			.join(", ");
		throw new Error(
			`Template '${ref.id}' has no version compatible with execution platform ` +
				`${executionPlatformVersion}. Available: ${available}.`,
		);
	}
	return picked;
}

// ---------------------------------------------------------------------------
// Vendor bundle resolution
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Locate the prebuilt vendor bundle. Plugins live in two places:
 *   - dev:        default-plugins/element-template/c8ctl-plugin.ts
 *                 vendor: ../../dist/vendor/bpmn-element-templates.cjs
 *   - production: dist/default-plugins/element-template/c8ctl-plugin.js
 *                 vendor: ../../vendor/bpmn-element-templates.cjs
 */
function resolveVendorBundle(): string {
	const candidates = [
		resolvePath(
			__dirname,
			"..",
			"..",
			"dist",
			"vendor",
			"bpmn-element-templates.cjs",
		),
		resolvePath(__dirname, "..", "..", "vendor", "bpmn-element-templates.cjs"),
	];
	for (const path of candidates) {
		if (existsSync(path)) return path;
	}
	throw new Error(
		"Vendor bundle not found. Run `npm run build:vendor` to build it.\n" +
			`Searched: ${candidates.join(", ")}`,
	);
}

/**
 * Apply an element template to a BPMN element using bpmn-js-headless and
 * bpmn-js-element-templates (same libraries as Web/Desktop Modeler).
 *
 * Loaded from a prebuilt CJS vendor bundle since the upstream libraries
 * use extensionless ESM imports that Node.js can't resolve without a bundler.
 */
async function applyElementTemplate(
	xml: string,
	template: Template,
	elementId: string,
): Promise<string> {
	const vendorPath = resolveVendorBundle();
	const vendor: VendorBundle = require(vendorPath);
	const {
		Modeler,
		CloudElementTemplatesCoreModule,
		ZeebeModdleExtension,
		HeadlessTextRendererModule,
	} = vendor;

	// HeadlessTextRendererModule overrides bpmn-js's default textRenderer,
	// which would otherwise call document.createElementNS during importXML
	// (to measure external label bounds) and throw "document is not defined"
	// in Node. The errors are non-fatal but produce noisy stack traces.
	const modeler = new Modeler({
		additionalModules: [
			HeadlessTextRendererModule,
			CloudElementTemplatesCoreModule,
		],
		moddleExtensions: { zeebe: ZeebeModdleExtension },
	});

	await modeler.importXML(xml);

	const elementRegistry = modeler.get("elementRegistry");
	const element = elementRegistry.get(elementId);
	if (!element) {
		throw new Error(`Element "${elementId}" not found in the BPMN diagram`);
	}

	const elementTemplates = modeler.get("elementTemplates");
	elementTemplates.set([template]);
	elementTemplates.applyTemplate(element, template);

	const result = await modeler.saveXML({ format: true });
	return result.xml;
}

// ---------------------------------------------------------------------------
// Subcommand: apply
// ---------------------------------------------------------------------------

async function applySubcommand(args: string[]): Promise<void> {
	const logger = getLogger();
	const parsed = parseArgs(args);

	if (parsed.help) {
		logger.output(
			"Usage: c8ctl element-template apply <template> <element-id> [<file.bpmn>] [--in-place] [--set key=value]",
		);
		return;
	}

	if (parsed.error) {
		throw new Error(parsed.error);
	}

	const [templateArg, elementId, bpmnFilePath] = parsed.positionals;

	if (!templateArg) {
		throw new Error(
			"Missing template argument. Usage: c8ctl element-template apply <template> <element-id> [<file.bpmn>]",
		);
	}
	if (!elementId) {
		throw new Error(
			"Missing element-id argument. Usage: c8ctl element-template apply <template> <element-id> [<file.bpmn>]",
		);
	}

	const input = await readBpmnInput(bpmnFilePath);
	if (!input) {
		throw new Error(
			"No BPMN input provided. Pass a file path or pipe BPMN XML via stdin.",
		);
	}

	if (parsed.inPlace && !bpmnFilePath) {
		throw new Error("--in-place cannot be used with stdin input");
	}

	const ref = parseTemplateRef(templateArg);
	if (!ref) {
		throw new Error("Missing template argument.");
	}
	let template: Template;
	if (ref.kind === "id") {
		const executionPlatformVersion = getExecutionPlatformVersion(input.xml);
		template = await resolveOotbTemplate(ref, { executionPlatformVersion });
		if (!ref.version && !executionPlatformVersion) {
			logger.warn(
				"BPMN has no modeler:executionPlatformVersion — applying latest version " +
					`(${template.version}) of ${ref.id}.`,
			);
		}
	} else {
		template = await readTemplateFromPathOrUrl(ref.value);
	}

	// Dry-run: describe what would happen without mutating anything
	if (globalThis.c8ctl?.dryRun) {
		const fallbackId = ref.kind === "id" ? ref.id : ref.value;
		const info = {
			dryRun: true,
			command: "element-template apply",
			template: {
				id: template.id ?? fallbackId,
				name: template.name,
				version: template.version,
			},
			elementId,
			source: input.source,
			inPlace: parsed.inPlace && !!bpmnFilePath,
			setOverrides: parsed.setArgs,
		};
		if (isJsonMode()) {
			logger.json(info);
		} else {
			logger.output("Dry run — no changes applied.");
			logger.output(
				`  Template: ${info.template.name ?? info.template.id}${
					info.template.version != null ? ` v${info.template.version}` : ""
				}`,
			);
			logger.output(`  Element:  ${elementId}`);
			logger.output(`  Source:   ${input.source}`);
			if (info.inPlace)
				logger.output(`  Mode:     in-place (would overwrite ${bpmnFilePath})`);
			else logger.output("  Mode:     stdout (would print transformed XML)");
			if (parsed.setArgs.length > 0)
				logger.output(`  --set:    ${parsed.setArgs.join(", ")}`);
		}
		return;
	}

	let setBindingNames: string[] = [];
	if (parsed.setArgs.length > 0) {
		setBindingNames = applySetOverrides(template.properties, parsed.setArgs);
	}

	let resultXml: string;
	try {
		resultXml = await applyElementTemplate(input.xml, template, elementId);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Error applying template: ${message}`);
	}

	if (setBindingNames.length > 0) {
		warnUnmetConditions(
			logger,
			resultXml,
			setBindingNames,
			template.properties,
		);
	}

	if (parsed.inPlace && bpmnFilePath) {
		writeFileSync(resolvePath(bpmnFilePath), resultXml, "utf-8");
		logger.info(`Updated ${bpmnFilePath}`);
		return;
	}

	process.stdout.write(resultXml);
}

// ---------------------------------------------------------------------------
// Subcommand: info
// ---------------------------------------------------------------------------

async function infoSubcommand(args: string[]): Promise<void> {
	const logger = getLogger();
	const usage = "Usage: c8ctl element-template info <template>";

	const parsed = parseInspectArgs(args, usage, {
		allowPropertyNames: false,
		allowFilters: false,
	});
	if (parsed.help) {
		logger.output(usage);
		return;
	}
	if (parsed.templateArg === undefined) {
		throw new Error(`Missing template argument. ${usage}`);
	}

	const { template, autoResolvedVersion } = await loadTemplate(
		parsed.templateArg,
	);

	if (isJsonMode()) {
		logger.json(buildTemplateSummary(template));
		return;
	}

	// Template metadata card. The version row carries a dim parenthetical
	// when the version was auto-resolved from an OOTB id.
	for (const line of formatTemplateHeaderLines(template, parsed.templateArg, {
		autoResolvedVersion,
	})) {
		logger.output(line);
	}
	logger.output("");

	// Trailing hint — point at get-properties for the property listing.
	logger.output(
		styleText(
			"dim",
			"For settable properties, run:\n" +
				`  c8ctl element-template get-properties ${parsed.templateArg}`,
		),
	);
}

// ---------------------------------------------------------------------------
// Subcommand: get-properties
// ---------------------------------------------------------------------------

async function getPropertiesSubcommand(args: string[]): Promise<void> {
	const logger = getLogger();
	const usage =
		"Usage: c8ctl element-template get-properties <template> [<name>...] [--group <id>...] [--detailed | -d]\n" +
		"  Default: condensed list (name + description). --detailed shows full cards.\n" +
		"  Names may include shell-style globs — quote to avoid shell expansion: 'auth*'";

	const parsed = parseInspectArgs(args, usage, {
		allowPropertyNames: true,
		allowFilters: true,
	});
	if (parsed.help) {
		logger.output(usage);
		return;
	}
	if (parsed.templateArg === undefined) {
		throw new Error(`Missing template argument. ${usage}`);
	}

	const { template, allDetails, groupLabelMap, sourceByDetail } =
		await loadTemplate(parsed.templateArg);

	// Resolve positional names if any (literals or globs). Each arg must
	// match at least one property — typos shouldn't silently produce no
	// output. With no positionals, default to all properties.
	let details =
		parsed.propertyArgs.length > 0
			? parsed.propertyArgs.flatMap((arg) =>
					filterByPropertyArg(allDetails, arg, parsed.templateArg),
				)
			: allDetails;

	// --group intersects with positional matches.
	details = applyGroupFilter(details, parsed.groups, groupLabelMap);

	// Dedupe by object reference — the same property detail object is
	// returned when it matches multiple positionals (e.g. `url` and
	// `u*` together). NOT by binding name+type: distinct properties
	// sometimes share those (operation-conditional duplicates that
	// bind to the same field with different `condition` clauses).
	const seen = new Set<PropertyDetail>();
	details = details.filter((d) => {
		if (seen.has(d)) return false;
		seen.add(d);
		return true;
	});

	const total = allDetails.length;

	if (isJsonMode()) {
		const projector = parsed.detailed
			? buildShowProperty
			: buildCondensedProperty;
		logger.json(
			buildJsonPayload(template, details, projector, total, sourceByDetail),
		);
		return;
	}

	// Summary line at the top — gives an at-a-glance answer to "how
	// many am I seeing, out of how many available". Especially useful
	// after a filter to confirm scope.
	logger.output(
		styleText("dim", `Showing ${details.length} of ${total} properties.`),
	);
	logger.output("");

	if (parsed.detailed) {
		// Detail-card view — full per-property fields.
		for (let i = 0; i < details.length; i++) {
			for (const line of formatPropertyCard(details[i])) {
				logger.output(line);
			}
			if (i < details.length - 1) logger.output("");
		}
		return;
	}

	// Default: condensed list — group heading + name + description.
	renderCondensedTable(details, groupLabelMap, logger);

	// Trailing hint — point users at name filtering and --detailed.
	logger.output("");
	logger.output(
		styleText(
			"dim",
			"Filter by name (supports globs):\n" +
				`  c8ctl element-template get-properties ${parsed.templateArg} 'auth*' url\n` +
				"For full details on each property:\n" +
				`  c8ctl element-template get-properties ${parsed.templateArg} --detailed`,
		),
	);
}

// ---------------------------------------------------------------------------
// Subcommand: get
// ---------------------------------------------------------------------------

/**
 * Print the raw template JSON to stdout. For local paths and URLs we
 * pass the source bytes through unchanged (no parse/stringify
 * round-trip — preserves whitespace, key order, trailing newline). For
 * OOTB ids we don't have the upstream bytes, so we serialize the cached
 * object with a 2-space indent. Designed for shell redirection:
 *
 *   c8ctl element-template get <id> > template.json
 *
 * No trailing hints or colored output — they would corrupt the piped
 * payload.
 */
async function getSubcommand(args: string[]): Promise<void> {
	const usage = "Usage: c8ctl element-template get <template>";

	let templateArg: string | undefined;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--help" || arg === "-h") {
			getLogger().output(usage);
			return;
		}
		if (arg === "--") break;
		if (arg.startsWith("-")) {
			throw new Error(`Unknown flag: ${arg}. ${usage}`);
		}
		if (templateArg === undefined) {
			templateArg = arg;
			continue;
		}
		throw new Error(`Unexpected argument: ${arg}. ${usage}`);
	}

	if (!templateArg) {
		throw new Error(`Missing template argument. ${usage}`);
	}

	const ref = parseTemplateRef(templateArg);
	if (!ref) {
		throw new Error(`Missing template argument. ${usage}`);
	}

	if (ref.kind === "path" || ref.kind === "url") {
		const content = await readFileOrUrl(ref.value);
		process.stdout.write(content);
		return;
	}

	// OOTB id: no upstream bytes available — stringify the cached object.
	// We deliberately do NOT auto-bootstrap here: the bootstrap log lines
	// would interleave with the JSON payload on stdout and corrupt any
	// shell redirect (`> template.json`). Surface the missing-cache case
	// as an explicit error pointing at `sync`.
	if (loadCache() === null) {
		throw new Error(
			"Element template cache not found. Run 'c8ctl element-template sync' first.",
		);
	}
	const template = await resolveOotbTemplate(ref);

	// The cache injects `metadata.upstreamRef` (our internal pointer for
	// incremental sync); strip it so the output matches what you'd get
	// from the marketplace, not c8ctl's cache shape.
	const cleaned = stripInternalMetadata(template);
	process.stdout.write(`${JSON.stringify(cleaned, null, 2)}\n`);
}

function stripInternalMetadata(template: Template): Template {
	if (!template.metadata?.upstreamRef) return template;
	const { metadata, ...rest } = template;
	const { upstreamRef: _ignored, ...metaRest } = metadata;
	if (Object.keys(metaRest).length === 0) {
		return { ...rest, properties: template.properties };
	}
	return { ...rest, properties: template.properties, metadata: metaRest };
}

// ---------------------------------------------------------------------------
// Shared inspect helpers (info + get-properties)
// ---------------------------------------------------------------------------

/**
 * Parse the shared inspect args: `<template> [<name>...] [--group <id>...]`.
 * `--group` is repeatable. Comma-separated values are NOT split — pass
 * `--group a --group b` for multiple ids.
 */
function parseInspectArgs(
	args: string[],
	usage: string,
	{
		allowPropertyNames,
		allowFilters,
	}: { allowPropertyNames: boolean; allowFilters: boolean },
): InspectArgs {
	const out: InspectArgs = {
		help: false,
		templateArg: undefined,
		propertyArgs: [],
		groups: [],
		detailed: false,
	};
	let afterDoubleDash = false;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (!afterDoubleDash && (arg === "--help" || arg === "-h")) {
			out.help = true;
			return out;
		}
		if (!afterDoubleDash && arg === "--") {
			afterDoubleDash = true;
			continue;
		}
		if (!afterDoubleDash && (arg === "--group" || arg.startsWith("--group="))) {
			if (!allowFilters) {
				throw new Error(`Unknown flag: --group. ${usage}`);
			}
			const value =
				arg === "--group" ? args[++i] : arg.slice("--group=".length);
			if (value === undefined || value === "") {
				throw new Error(`--group requires a value (group id). ${usage}`);
			}
			out.groups.push(value);
			continue;
		}
		if (!afterDoubleDash && (arg === "--detailed" || arg === "-d")) {
			out.detailed = true;
			continue;
		}
		if (!afterDoubleDash && arg.startsWith("-")) {
			throw new Error(`Unknown flag: ${arg}. ${usage}`);
		}
		if (out.templateArg === undefined) {
			out.templateArg = arg;
			continue;
		}
		if (!allowPropertyNames) {
			throw new Error(`Unexpected argument: ${arg}. ${usage}`);
		}
		out.propertyArgs.push(arg);
	}

	if (!out.templateArg && !out.help) {
		throw new Error(`Missing template argument. ${usage}`);
	}
	return out;
}

/** Load and parse a template (OOTB id, local path, or URL). */
async function loadTemplate(templateArg: string): Promise<LoadedTemplate> {
	const ref = parseTemplateRef(templateArg);
	if (!ref) {
		throw new Error("Missing template argument.");
	}
	let template: Template;
	if (ref.kind === "id") {
		template = await resolveOotbTemplate(ref);
	} else {
		template = await readTemplateFromPathOrUrl(ref.value);
	}

	const settable = getSettableProperties(template.properties);
	const groupLabelMap = new Map(
		(template.groups ?? []).map((g) => [g.id, g.label]),
	);
	// Side-table from detail → source property. Detail objects are
	// projected views; the side-table preserves access to the raw
	// schema-shaped property for JSON projection without leaking the
	// back-reference into the detail itself. Required because two
	// distinct properties can share the same `binding.name` + type
	// (template authors use it for operation-conditional duplicates),
	// so we can't recover identity from the detail's name+type tuple.
	const sourceByDetail = new WeakMap<PropertyDetail, TemplateProperty>();
	const allDetails = settable.map((p) => {
		const detail = getPropertyDetail(p, groupLabelMap);
		sourceByDetail.set(detail, p);
		return detail;
	});
	// `autoResolvedVersion` is true when the user gave an OOTB id without
	// pinning `@<n>` and we picked the latest. The info card surfaces
	// this as a dim parenthetical on the Version row instead of a
	// separate stderr warning.
	return {
		template,
		allDetails,
		groupLabelMap,
		sourceByDetail,
		autoResolvedVersion: ref.kind === "id" && !ref.version,
	};
}

/**
 * Project a template into the JSON summary shape — only the fields
 * the text output surfaces (name/id/version, description, applies-to,
 * engines, docs link), but using the element-templates JSON schema's
 * own field names. No invented derivations; no full-template dump.
 */
function buildTemplateSummary(template: Template): Record<string, unknown> {
	return {
		name: template.name,
		id: template.id,
		version: template.version,
		description: template.description,
		documentationRef: template.documentationRef,
		appliesTo: template.appliesTo,
		elementType: template.elementType,
		engines: template.engines,
	};
}

/**
 * Project a property into the JSON shape that mirrors the **condensed
 * get-properties text output** — just identification (binding) and the
 * descriptive text the row surfaces. Group is included so consumers
 * can resolve the section heading via the top-level `groups` table.
 */
function buildCondensedProperty(
	prop: TemplateProperty,
): Record<string, unknown> {
	return {
		id: prop.id,
		binding: prop.binding,
		label: prop.label,
		description: prop.description,
		group: prop.group,
	};
}

/**
 * Project a property into the JSON shape that mirrors the
 * **--detailed get-properties card** — every field the card surfaces.
 * Schema field names verbatim.
 */
function buildShowProperty(prop: TemplateProperty): Record<string, unknown> {
	return {
		id: prop.id,
		binding: prop.binding,
		type: prop.type,
		optional: prop.optional,
		value: prop.value,
		feel: prop.feel,
		group: prop.group,
		condition: prop.condition,
		label: prop.label,
		description: prop.description,
		constraints: prop.constraints,
		choices: prop.choices,
	};
}

/**
 * JSON payload for `get-properties`. `projectProp` decides which
 * per-property shape to use (condensed vs detailed) so JSON mirrors
 * text density per mode.
 */
function buildJsonPayload(
	template: Template,
	details: PropertyDetail[],
	projectProp: (prop: TemplateProperty) => Record<string, unknown>,
	totalCount: number,
	sourceByDetail: WeakMap<PropertyDetail, TemplateProperty>,
): Record<string, unknown> {
	const properties = details
		.map((d) => sourceByDetail.get(d))
		.filter((p): p is TemplateProperty => Boolean(p))
		.map(projectProp);

	return {
		count: properties.length,
		total: totalCount,
		groups: template.groups ?? [],
		properties,
	};
}

/**
 * Filter details to those whose `groupId` is in the requested list.
 * Empty list means no filter. Unknown group ids throw with the list of
 * valid ids — group ids are short and bounded so we always show them.
 */
function applyGroupFilter(
	details: PropertyDetail[],
	groups: string[],
	groupLabelMap: Map<string, string>,
): PropertyDetail[] {
	if (groups.length === 0) return details;
	const valid = new Set(groupLabelMap.keys());
	for (const g of groups) {
		if (!valid.has(g)) {
			const known = [...valid].join(", ") || "(none defined on this template)";
			throw new Error(
				`Unknown group id "${g}". Use the template's group id (not its label).\n` +
					`Available group ids: ${known}`,
			);
		}
	}
	const set = new Set(groups);
	return details.filter((d) => d.groupId !== undefined && set.has(d.groupId));
}

/**
 * Render the condensed one-line-per-property listing grouped by
 * section.
 */
function renderCondensedTable(
	details: PropertyDetail[],
	groupLabelMap: Map<string, string>,
	logger: PluginLogger,
): void {
	const grouped = new Map<string, PropertyDetail[]>();
	const ungrouped: PropertyDetail[] = [];
	for (const detail of details) {
		if (detail.groupId) {
			const list = grouped.get(detail.groupId) ?? [];
			list.push(detail);
			grouped.set(detail.groupId, list);
		} else {
			ungrouped.push(detail);
		}
	}

	// Global name-column width so the description column anchors at the
	// same x-position across all groups.
	const nameWidth = Math.max(0, ...details.map((d) => (d.name ?? "?").length));

	type GroupEntry = { groupId: string | null; group: PropertyDetail[] };
	const groupEntries: GroupEntry[] = [...grouped.entries()].map(
		([groupId, group]) => ({ groupId, group }),
	);
	if (ungrouped.length > 0)
		groupEntries.push({ groupId: null, group: ungrouped });

	for (let i = 0; i < groupEntries.length; i++) {
		const { groupId, group } = groupEntries[i];
		const label = groupId ? (groupLabelMap.get(groupId) ?? groupId) : "Other";
		// Show "Label (id)" so the --group filter token is self-documenting.
		// Skip the parenthetical when label and id are identical.
		const heading =
			groupId && label !== groupId
				? `${styleText("bold", label)} ${styleText("dim", `(${groupId})`)}`
				: styleText("bold", label);
		logger.output(heading);
		for (const detail of group) {
			logger.output(formatCondensedRow(detail, { nameWidth }));
		}
		if (i < groupEntries.length - 1) logger.output("");
	}
}

/**
 * Build one condensed row: indent · padded name · description-or-label.
 */
function formatCondensedRow(
	detail: PropertyDetail,
	{ nameWidth }: { nameWidth: number },
): string {
	const NAME_INDENT = "  ";
	const COLUMN_GAP = "  ";
	const name = (detail.name ?? "?").padEnd(nameWidth);
	const text = detail.description ?? detail.label ?? "";
	const trailing = text ? `${COLUMN_GAP}${styleText("dim", text)}` : "";
	const lines = [`${NAME_INDENT}${styleText("bold", name)}${trailing}`];

	// Surface `id` only when it adds information — i.e. it exists and
	// differs from the binding name. For most properties (id == name or
	// id missing) this stays a single-line row.
	if (detail.id && detail.id !== detail.name) {
		const indent = " ".repeat(NAME_INDENT.length + 4);
		lines.push(styleText("dim", `${indent}[id: ${detail.id}]`));
	}

	return lines.join("\n");
}

/**
 * Render template-level metadata as a keyed card.
 */
function formatTemplateHeaderLines(
	template: Template,
	fallbackName: string | undefined,
	{ autoResolvedVersion = false }: { autoResolvedVersion?: boolean } = {},
): string[] {
	const fields: [string, string][] = [];
	if (template.id) fields.push(["ID", template.id]);
	if (template.version !== undefined) {
		const versionCell = autoResolvedVersion
			? `${template.version}  ${styleText("dim", "(latest; @<n> to pin)")}`
			: String(template.version);
		fields.push(["Version", versionCell]);
	}
	const appliesValue = formatAppliesToValue(template);
	if (appliesValue) fields.push(["Applies to", appliesValue]);
	if (template.engines?.camunda)
		fields.push(["Engines", template.engines.camunda]);
	if (template.description) fields.push(["Description", template.description]);
	if (template.documentationRef) {
		fields.push(["Docs", styleText("dim", template.documentationRef)]);
	}

	return formatKeyedCard({
		title: template.name ?? fallbackName ?? "Template",
		fields,
	});
}

/**
 * Resolve `appliesTo` and `elementType.value` into a single value cell.
 */
function formatAppliesToValue(template: Template): string | null {
	const applies = Array.isArray(template.appliesTo)
		? template.appliesTo.filter((v): v is string => Boolean(v))
		: [];
	const elementType = template.elementType?.value;
	if (applies.length === 0 && !elementType) return null;

	const left =
		applies.length === 0
			? null
			: applies.length === 1
				? applies[0]
				: applies.length === 2
					? applies.join(" or ")
					: `${applies.slice(0, -1).join(", ")}, or ${applies[applies.length - 1]}`;

	if (left && elementType && !applies.includes(elementType)) {
		return `${left} → ${elementType}`;
	}
	if (left) return left;
	return elementType ?? null;
}

/**
 * Generic keyed-card renderer used by both the template header and the
 * property detail card.
 */
function formatKeyedCard({
	title,
	subtitle,
	fields,
}: {
	title: string;
	subtitle?: string;
	fields: [string, string][];
}): string[] {
	const lines: string[] = [];
	const titleParts = [styleText("bold", title)];
	if (subtitle) titleParts.push(styleText("dim", subtitle));
	lines.push(titleParts.join(" "));

	if (fields.length === 0) return lines;

	const keyWidth = Math.max(0, ...fields.map(([k]) => k.length));
	for (const [key, value] of fields) {
		const paddedKey = key.padEnd(keyWidth);
		const styledKey = key ? styleText("dim", paddedKey) : paddedKey;
		lines.push(`  ${styledKey}  ${value}`);
	}
	return lines;
}

/**
 * Detail card for a single property — keyed two-column layout.
 */
function formatPropertyCard(detail: PropertyDetail): string[] {
	const fields: [string, string][] = [];
	if (detail.id) fields.push(["Id", detail.id]);
	fields.push(["Type", detail.type ?? "String"]);
	fields.push(["Required", detail.required ? "yes" : "no"]);
	if (detail.feel) fields.push(["FEEL", detail.feel]);
	if (detail.default !== undefined && detail.default !== "") {
		fields.push(["Default", formatBadgeValue(detail.default)]);
	}
	if (detail.bindingType) fields.push(["Binding", detail.bindingType]);

	if (detail.label || detail.description) {
		const text = [detail.label, detail.description].filter(Boolean).join(" — ");
		fields.push(["Description", text]);
	}
	if (detail.conditionText) {
		fields.push(["Active when", detail.conditionText]);
	} else if (detail.condition) {
		fields.push(["Conditional", "(see template definition)"]);
	}
	if (detail.pattern) {
		fields.push(["Pattern", detail.pattern.value]);
		if (detail.pattern.message) {
			fields.push(["", detail.pattern.message]);
		}
	}
	if (detail.choices?.length) {
		fields.push(["Choices", detail.choices.map((c) => c.value).join(", ")]);
	}

	return formatKeyedCard({
		title: detail.name ?? "?",
		subtitle: detail.group ? `(${detail.group})` : undefined,
		fields,
	});
}

/**
 * Filter properties by a `<name>` or `<binding-type>:<name>` argument.
 */
function filterByPropertyArg(
	details: PropertyDetail[],
	propertyArg: string,
	templateArg: string | undefined,
): PropertyDetail[] {
	const colon = propertyArg.indexOf(":");
	let nameFilter = propertyArg;
	let typeFilter: string | undefined;
	if (colon !== -1) {
		const prefix = propertyArg.slice(0, colon);
		typeFilter = BINDING_TYPE_SHORTHANDS[prefix];
		if (!typeFilter) {
			const valid = Object.keys(BINDING_TYPE_SHORTHANDS).join(", ");
			throw new Error(
				`Unknown binding type prefix "${prefix}". Valid prefixes: ${valid}`,
			);
		}
		nameFilter = propertyArg.slice(colon + 1);
	}

	const isGlob = nameFilter.includes("*");
	const matcher = isGlob ? globToRegex(nameFilter) : null;

	const matches = details.filter((d) => {
		if (typeFilter && d.bindingType !== typeFilter) return false;
		if (!d.name) return false;
		return matcher ? matcher.test(d.name) : d.name === nameFilter;
	});
	if (matches.length === 0) {
		const hint = templateArg
			? `\nRun 'c8ctl element-template info ${templateArg}' to see available properties.`
			: "";
		throw new Error(`Property "${propertyArg}" not found.${hint}`);
	}
	return matches;
}

function formatBadgeValue(value: unknown): string {
	if (typeof value === "string") {
		// Multi-line defaults (FEEL expression bodies, JSON snippets) would
		// otherwise wrap and break the badge layout — collapse to a single
		// line and truncate.
		const oneLine = value.replace(/\s+/g, " ").trim();
		return oneLine.length > 60 ? `${oneLine.slice(0, 57)}...` : oneLine;
	}
	return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// Subcommand: search
// ---------------------------------------------------------------------------

async function searchSubcommand(args: string[]): Promise<void> {
	const logger = getLogger();
	const usage = "Usage: c8ctl element-template search <query>";

	const queryParts: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--help" || arg === "-h") {
			logger.output(usage);
			return;
		}
		if (arg === "--") {
			queryParts.push(...args.slice(i + 1));
			break;
		}
		if (arg.startsWith("-")) {
			throw new Error(`Unknown flag: ${arg}. ${usage}`);
		}
		queryParts.push(arg);
	}

	const query = queryParts.join(" ").trim();
	if (!query) {
		throw new Error(`Missing query. ${usage}`);
	}

	await bootstrapIfNeeded({ logger });
	nudgeIfStale(logger);

	// Hide deprecated templates from search results — same as Modeler.
	// The schema's `deprecated` field is either `true` or `{ message }`;
	// both forms mean the same thing.
	const matches = searchTemplates(query).filter((t) => !t.deprecated);

	if (isJsonMode()) {
		logger.json({
			query,
			count: matches.length,
			matches: matches.map(buildTemplateSummary),
		});
		return;
	}

	if (matches.length === 0) {
		logger.output(`No element templates match '${query}'.`);
		logger.output("");
		logger.output(
			styleText(
				"dim",
				"Try a broader query, or run 'c8ctl element-template sync' to refresh the cache.",
			),
		);
		return;
	}

	// Header — count + the query that produced it.
	const matchWord = matches.length === 1 ? "match" : "matches";
	logger.output(
		styleText("bold", `${matches.length} ${matchWord} for '${query}'`),
	);
	logger.output("");

	for (let i = 0; i < matches.length; i++) {
		const t = matches[i];
		for (const line of formatTemplateHeaderLines(t, t.id)) {
			logger.output(line);
		}
		if (i < matches.length - 1) logger.output("");
	}

	// Trailing hint.
	logger.output("");
	const exampleId = matches[0]?.id ?? "<id>";
	logger.output(
		styleText(
			"dim",
			"For details on a template:\n" +
				`  c8ctl element-template info ${exampleId}`,
		),
	);
}

// ---------------------------------------------------------------------------
// Subcommand: sync
// ---------------------------------------------------------------------------

async function syncSubcommand(args: string[]): Promise<void> {
	const logger = getLogger();
	let prune = false;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--help" || arg === "-h") {
			logger.output("Usage: c8ctl element-template sync [--prune]");
			return;
		}
		if (arg === "--prune") {
			prune = true;
			continue;
		}
		if (arg === "--") {
			break;
		}
		if (arg.startsWith("-")) {
			throw new Error(
				`Unknown flag: ${arg}. Usage: c8ctl element-template sync [--prune]`,
			);
		}
		throw new Error(
			`Unexpected argument: ${arg}. Usage: c8ctl element-template sync [--prune]`,
		);
	}

	const summary = await syncTemplates({ logger, prune });

	if (isJsonMode()) {
		logger.json(summary);
	}
}

// ---------------------------------------------------------------------------
// Plugin commands export
// ---------------------------------------------------------------------------

const VALID_SUBCOMMANDS = [
	"search",
	"info",
	"get-properties",
	"apply",
	"get",
	"sync",
] as const;
type Subcommand = (typeof VALID_SUBCOMMANDS)[number];

function isValidSubcommand(s: string): s is Subcommand {
	return VALID_SUBCOMMANDS.some((v) => v === s);
}

function printUsage(): void {
	const logger = getLogger();
	const cmd = metadata.commands["element-template"];
	logger.output("Usage: c8ctl element-template <subcommand> [options]");
	logger.output("");
	for (const line of cmd.helpDescription.split("\n")) {
		logger.output(line);
	}
	logger.output("");
	logger.output("Subcommands:");
	for (const sub of cmd.subcommands) {
		logger.output(`  ${sub.name.padEnd(20)} ${sub.description}`);
	}
	logger.output("");
	logger.output("Options:");
	const flags: Record<string, FlagMeta> = cmd.flags;
	for (const [name, def] of Object.entries(flags)) {
		const shortStr = def.short ? `-${def.short}, ` : "    ";
		logger.output(`  ${shortStr}--${name.padEnd(16)} ${def.description}`);
	}
	logger.output("");
	logger.output("Examples:");
	for (const ex of cmd.examples) {
		logger.output(`  ${ex.command}`);
	}
}

export const commands = {
	"element-template": async (args: string[] | undefined): Promise<void> => {
		const subcommand = args?.[0];
		const subArgs = args?.slice(1) ?? [];

		if (!subcommand || subcommand === "--help" || subcommand === "-h") {
			printUsage();
			return;
		}
		if (!isValidSubcommand(subcommand)) {
			printUsage();
			process.exitCode = 1;
			return;
		}

		try {
			if (subcommand === "search") {
				await searchSubcommand(subArgs);
			} else if (subcommand === "info") {
				await infoSubcommand(subArgs);
			} else if (subcommand === "get-properties") {
				await getPropertiesSubcommand(subArgs);
			} else if (subcommand === "apply") {
				await applySubcommand(subArgs);
			} else if (subcommand === "get") {
				await getSubcommand(subArgs);
			} else if (subcommand === "sync") {
				await syncSubcommand(subArgs);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const logger = getLogger();
			logger.error(`Failed to element-template ${subcommand}: ${message}`);
			process.exitCode = 1;
		}
	},
};
