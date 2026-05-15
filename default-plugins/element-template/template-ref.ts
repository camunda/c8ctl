/**
 * Template/BPMN input resolution shared by element-template subcommands.
 *
 * Covers:
 *   - Classifying a `<template>` argument as URL, local path, or OOTB id.
 *   - Loading a template from any of those sources (cache lookup for ids,
 *     fetch/parse for URLs and paths).
 *   - Reading BPMN input from a file path or stdin.
 *   - Extracting `modeler:executionPlatformVersion` from BPMN XML.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type {} from "../../src/runtime.ts";
import {
	getPropertyDetail,
	getSettableProperties,
	type PropertyDetail,
	parseTemplateJson,
	readFileOrUrl,
	type Template,
	type TemplateProperty,
} from "./helpers.ts";
import {
	bootstrapIfNeeded,
	findById,
	nudgeIfStale,
	pickVersion,
} from "./marketplace.ts";

if (!globalThis.c8ctl) throw new Error("c8ctl runtime not initialised");
const c8ctl = globalThis.c8ctl;

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
	const BpmnModdle = (await import("bpmn-moddle")).default;
	const moddle = new BpmnModdle();
	try {
		const { rootElement } = await moddle.fromXML(xml);
		const version = rootElement.$attrs?.["modeler:executionPlatformVersion"];
		return typeof version === "string" ? version : null;
	} catch {
		return null;
	}
}

export async function readTemplateFromPathOrUrl(
	input: string,
): Promise<Template> {
	const content = await readFileOrUrl(input);
	return parseTemplateJson(content);
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
	await bootstrapIfNeeded({ logger });
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
): Promise<LoadedTemplate> {
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
		autoResolvedVersion: ref.kind === "id" && ref.version === undefined,
	};
}
