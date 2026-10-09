/**
 * Template/BPMN input resolution shared by element-template subcommands.
 *
 * Covers:
 *   - Classifying a `<template>` argument as URL, local path, or OOTB id.
 *   - Loading a template from any of those sources (cache lookup for ids,
 *     fetch/parse for URLs and paths).
 *   - Resolving an id against `.camunda/element-templates/`, then the cache.
 *   - Reading BPMN input from a file path or stdin.
 *   - Extracting `modeler:executionPlatformVersion` from BPMN XML.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve as resolvePath } from "node:path";
import type {} from "../../src/core/runtime.ts";
import {
	findById,
	nudgeIfStale,
	type PickVersionOptions,
	pickVersion,
	requireCachePresent,
} from "./cache.ts";
import {
	getPropertyDetail,
	getSettableProperties,
	isRecord,
	type PropertyDetail,
	parseTemplateJson,
	readFileOrUrl,
	type Template,
	type TemplateProperty,
} from "./helpers.ts";
import { resolveVendorBundle, type VendorBundle } from "./vendor.ts";

if (!globalThis.c8ctl) throw new Error("c8ctl runtime not initialised");
const c8ctl = globalThis.c8ctl;
const require = createRequire(import.meta.url);

export type BpmnInput = { xml: string; source: string };

export type TemplateRefUrl = { kind: "url"; value: string };
export type TemplateRefPath = { kind: "path"; value: string };
export type TemplateRefId = {
	kind: "id";
	id: string;
	version: number | undefined;
};
export type TemplateRef = TemplateRefUrl | TemplateRefPath | TemplateRefId;

export type LoadedTemplate = {
	template: Template;
	allDetails: PropertyDetail[];
	groupLabelMap: Map<string, string>;
	sourceByDetail: WeakMap<PropertyDetail, TemplateProperty>;
	autoResolvedVersion: boolean;
	engineVersionIgnoredByPinnedVersion: boolean;
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
		if (!xml.trim()) {
			return null;
		}
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
export function parseTemplateRef(arg: string | undefined): TemplateRef | null {
	if (!arg) {
		return null;
	}
	if (/^http:\/\//.test(arg)) {
		throw new Error(
			`Insecure template URL rejected: ${arg}\n` +
				"Template URLs must use HTTPS to protect credentials and content integrity.",
		);
	}
	if (/^https:\/\//.test(arg)) {
		return { kind: "url", value: arg };
	}
	if (
		arg.includes("/") ||
		arg.includes("\\") ||
		arg.startsWith(".") ||
		arg.toLowerCase().endsWith(".json")
	) {
		return { kind: "path", value: arg };
	}
	const match = arg.match(/^([^@\s]+?)(?:@(\d+))?$/);
	if (!match) {
		return { kind: "path", value: arg };
	}
	return {
		kind: "id",
		id: match[1],
		version: match[2] !== undefined ? Number(match[2]) : undefined,
	};
}

export async function getExecutionPlatformVersion(
	xml: string,
): Promise<string | null> {
	const { BpmnModdle } = await import("bpmn-moddle");
	const moddle = new BpmnModdle();
	try {
		const { rootElement } = await moddle.fromXML(xml);
		const version = rootElement.$attrs?.["modeler:executionPlatformVersion"];
		return typeof version === "string" ? version : null;
	} catch {
		return null;
	}
}

/**
 * Walk the moddle tree returned by bpmn-moddle and check whether any element
 * carries the given `id`. Used by the dry-run path to surface "element not
 * found" before reporting a successful preview.
 */
// Structural guard: an object we can index for tree traversal. Mirrors the
// previous `typeof node === "object" && node !== null` check (arrays included)
// so `containsId` can read properties without an `as` cast.
function isTraversable(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function containsId(node: unknown, id: string, seen: Set<object>): boolean {
	if (!isTraversable(node)) return false;
	if (seen.has(node)) return false;
	seen.add(node);
	const record = node;
	if (record.id === id) return true;
	for (const key of Object.keys(record)) {
		if (key.startsWith("$")) continue;
		const value = record[key];
		if (Array.isArray(value)) {
			for (const item of value) {
				if (containsId(item, id, seen)) return true;
			}
		} else if (containsId(value, id, seen)) {
			return true;
		}
	}
	return false;
}

export async function elementExistsInBpmn(
	xml: string,
	elementId: string,
): Promise<boolean> {
	const { BpmnModdle } = await import("bpmn-moddle");
	const moddle = new BpmnModdle();
	const { rootElement } = await moddle.fromXML(xml);
	return containsId(rootElement, elementId, new Set<object>());
}

export async function readTemplateFromPathOrUrl(
	input: string,
): Promise<Template> {
	const content = await readFileOrUrl(input);
	return parseTemplateJson(content);
}

/**
 * Directories searched for local templates, nearest first — the walk mirrors
 * Desktop Modeler's ElementTemplatesProvider
 * (https://github.com/camunda/camunda-modeler/blob/main/app/lib/config/providers/ElementTemplatesProvider.js):
 * `.camunda/element-templates` in `startDir` and every ancestor up to and
 * including the filesystem root, then `resources/element-templates` in the
 * Modeler's user-data dir.
 */
function localTemplateDirs(startDir: string): string[] {
	const dirs: string[] = [];
	for (let dir = resolvePath(startDir); ; dir = dirname(dir)) {
		dirs.push(join(dir, ".camunda", "element-templates"));
		if (dirname(dir) === dir) break;
	}
	dirs.push(join(c8ctl.getModelerDataDir(), "resources", "element-templates"));
	return dirs;
}

type LocalTemplateEntry = { template: unknown; file: string };

/** Follows symlinks, like the Modeler's glob; a dangling one is skipped. */
function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

/**
 * Read every `**\/*.json` under `dirs`, in order; a file holds one template or
 * an array. As in the Modeler, a missing or unreadable directory is skipped
 * but a malformed file is an error.
 */
function readLocalTemplates(dirs: string[]): LocalTemplateEntry[] {
	const result: LocalTemplateEntry[] = [];
	for (const dir of dirs) {
		let files: string[];
		try {
			files = readdirSync(dir, { recursive: true, withFileTypes: true })
				.filter((e) => e.name.toLowerCase().endsWith(".json"))
				.map((e) => join(e.parentPath, e.name))
				.filter(isFile)
				.sort();
		} catch {
			continue;
		}
		for (const file of files) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(readFileSync(file, "utf-8"));
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(`template ${file} parse error: ${message}`);
			}
			for (const template of Array.isArray(parsed) ? parsed : [parsed]) {
				result.push({ template, file });
			}
		}
	}
	return result;
}

/**
 * Validate templates with bpmn-js-element-templates' Cloud validator — the
 * `elementTemplatesLoader` of `CloudElementTemplatesCoreModule`, the same
 * path the Modeler loads templates through: schema validation, and a
 * duplicate id+version keeps the first (nearest) one. Rejected templates are
 * reported as warnings, as the Modeler reports them without aborting.
 */
function validateLocalTemplates(
	id: string,
	entries: LocalTemplateEntry[],
): Template[] {
	const {
		Modeler,
		CloudElementTemplatesCoreModule,
		ZeebeModdleExtension,
		HeadlessTextRendererModule,
	}: VendorBundle = require(resolveVendorBundle());
	const modeler = new Modeler({
		additionalModules: [
			HeadlessTextRendererModule,
			CloudElementTemplatesCoreModule,
		],
		moddleExtensions: { zeebe: ZeebeModdleExtension },
	});
	const fileOf = new Map(entries.map((e) => [e.template, e.file]));
	const logger = c8ctl.getLogger();
	modeler.get("eventBus").on("elementTemplates.errors", (event) => {
		const errors =
			isRecord(event) && Array.isArray(event.errors) ? event.errors : [];
		for (const error of errors) {
			const file = isRecord(error) ? fileOf.get(error.template) : undefined;
			const message = error instanceof Error ? error.message : String(error);
			logger.warn(
				`Ignoring element template${file ? ` in ${file}` : ""}: ${message}`,
			);
		}
	});
	modeler
		.get("elementTemplatesLoader")
		.setTemplates(entries.map((e) => e.template));
	return modeler.get("elementTemplates").getAll(id) ?? [];
}

/**
 * Find a local template by id: every template with that id from the
 * directories in `localTemplateDirs` is merged into one pool (no
 * nearest-directory-wins fallback), validated, and the version picked once
 * over the pool with the cache's `pickVersion` rules, so local and OOTB
 * resolution agree: a pinned version must match exactly; otherwise the
 * highest version whose `engines.camunda` admits `executionPlatformVersion`
 * wins. Only templates with the requested id are validated, so an unrelated
 * invalid template doesn't produce noise.
 */
export function findLocalTemplate(
	startDir: string,
	id: string,
	options: PickVersionOptions = {},
): Template | undefined {
	const entries = readLocalTemplates(localTemplateDirs(startDir)).filter(
		(e) => isRecord(e.template) && e.template.id === id,
	);
	if (entries.length === 0) return undefined;
	return pickVersion(validateLocalTemplates(id, entries), options) ?? undefined;
}

/**
 * Resolve an `<id>[@<v>]` reference: a project-local template (searched from
 * `searchDir` upward, see `findLocalTemplate`) wins, otherwise the OOTB
 * cache. Only the fallback touches the cache, so a local hit works with a
 * cold cache. Every subcommand that takes an id goes through here.
 */
export async function resolveTemplateId(
	ref: TemplateRefId,
	{
		searchDir = process.cwd(),
		executionPlatformVersion,
	}: { searchDir?: string; executionPlatformVersion?: string | null } = {},
): Promise<Template> {
	return (
		findLocalTemplate(searchDir, ref.id, {
			version: ref.version,
			executionPlatformVersion,
		}) ?? resolveOotbTemplate(ref, { executionPlatformVersion })
	);
}

/**
 * Resolve an `<id>[@<v>]` reference to a single template object using the
 * local cache, bootstrapping if needed. `executionPlatformVersion` (from the
 * BPMN file) drives version selection when no explicit version is pinned.
 */
export async function resolveOotbTemplate(
	ref: TemplateRefId,
	{
		executionPlatformVersion,
	}: { executionPlatformVersion?: string | null } = {},
): Promise<Template> {
	const logger = c8ctl.getLogger();
	requireCachePresent();
	nudgeIfStale(logger);

	const candidates = findById(ref.id);
	if (candidates.length === 0) {
		throw new Error(
			`Element template '${ref.id}' not found. Run 'c8ctl element-template sync' to refresh the cache, ` +
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
				`Element template '${ref.id}' has no version ${ref.version}. ${available}`,
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
			`Element template '${ref.id}' has no version compatible with execution platform ` +
				`${executionPlatformVersion}. Available: ${available}.`,
		);
	}
	return picked;
}

/**
 * Load and parse a template (OOTB id, local path, or URL), and produce the
 * derived views the inspect subcommands need: settable property details,
 * a group id→label map, and a side-table from detail → source property.
 *
 * The side-table preserves access to the raw schema-shaped property for
 * JSON projection without leaking the back-reference into the detail
 * itself. Required because two distinct properties can share the same
 * `binding.name` + type (template authors use it for operation-conditional
 * duplicates), so we can't recover identity from the detail's name+type
 * tuple.
 */
export async function loadTemplate(
	templateArg: string,
	{
		executionPlatformVersion,
	}: { executionPlatformVersion?: string | null } = {},
): Promise<LoadedTemplate> {
	const ref = parseTemplateRef(templateArg);
	if (!ref) {
		throw new Error("Missing template argument.");
	}
	let template: Template;
	let engineVersionIgnoredByPinnedVersion = false;
	if (ref.kind === "id") {
		engineVersionIgnoredByPinnedVersion =
			ref.version !== undefined && Boolean(executionPlatformVersion);
		template = await resolveTemplateId(ref, {
			executionPlatformVersion:
				ref.version === undefined ? executionPlatformVersion : undefined,
		});
	} else {
		template = await readTemplateFromPathOrUrl(ref.value);
	}

	const settable = getSettableProperties(template.properties);
	const groupLabelMap = new Map(
		(template.groups ?? []).map((g) => [g.id, g.label]),
	);
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
		// Only mark "auto-resolved latest" when no engine constraint was
		// provided; with --engine-version we resolve the latest compatible
		// version, which is not necessarily the absolute latest.
		autoResolvedVersion:
			ref.kind === "id" &&
			ref.version === undefined &&
			!executionPlatformVersion,
		engineVersionIgnoredByPinnedVersion,
	};
}
