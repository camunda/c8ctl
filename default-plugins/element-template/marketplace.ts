/**
 * Marketplace OOTB element-template index.
 *
 * Source: GET https://marketplace.cloud.camunda.io/api/v1/ootb-connectors
 *   → { [id]: [{ version, ref, engine: { camunda: "^8.x" } }, ...] }
 *
 * Each `ref` is a commit-pinned raw.githubusercontent.com URL → immutable.
 * We download every ref once, inline the templates into a single
 * `templates.json` cache file, and inject `metadata.upstreamRef = <ref>` so
 * subsequent syncs can skip already-cached entries (matches Modeler's
 * approach in `app/lib/template-updater/util.js`).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import semver from "semver";
import { isRecord, type PluginLogger, type Template } from "./helpers.ts";

const DEFAULT_OOTB_URL =
	"https://marketplace.cloud.camunda.io/api/v1/ootb-connectors";
const FETCH_CONCURRENCY = 12;
const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ---------------------------------------------------------------------------
// Index entry types
// ---------------------------------------------------------------------------

type IndexEngine = { camunda?: string };

type IndexVersionEntry = {
	version?: number;
	ref?: string;
	engine?: IndexEngine;
};

type FlatIndexEntry = {
	id: string;
	version: number;
	ref: string;
	engine: IndexEngine | undefined;
};

export type SyncSummary = {
	total: number;
	fetched: number;
	cached: number;
	errors: number;
	pruned: number;
};

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function getMarketplaceUrl(): string {
	return process.env.C8CTL_OOTB_ELEMENT_TEMPLATES_URL || DEFAULT_OOTB_URL;
}

export function getCacheDir(): string {
	if (!globalThis.c8ctl?.getUserDataDir) {
		throw new Error(
			"c8ctl runtime is not available; cannot resolve element-template cache dir.",
		);
	}
	return join(globalThis.c8ctl.getUserDataDir(), "element-templates");
}

function getCachePath(): string {
	return join(getCacheDir(), "templates.json");
}

function getFetchedAtPath(): string {
	return join(getCacheDir(), "fetched-at");
}

// ---------------------------------------------------------------------------
// Cache I/O
// ---------------------------------------------------------------------------

function isTemplateArray(value: unknown): value is Template[] {
	return (
		Array.isArray(value) &&
		value.every((item) => isRecord(item) && Array.isArray(item.properties))
	);
}

export function loadCache(): Template[] | null {
	const path = getCachePath();
	if (!existsSync(path)) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf-8"));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Element template cache is corrupt at ${path}: ${message}`);
	}
	if (!Array.isArray(parsed)) {
		throw new Error(
			`Element template cache is corrupt at ${path}: expected an array`,
		);
	}
	if (!isTemplateArray(parsed)) {
		throw new Error(
			`Element template cache is corrupt at ${path}: entries must be template objects with a properties array`,
		);
	}
	return parsed;
}

function loadFetchedAt(): number | null {
	const path = getFetchedAtPath();
	if (!existsSync(path)) return null;
	const value = readFileSync(path, "utf-8").trim();
	const ms = Number(value);
	return Number.isFinite(ms) ? ms : null;
}

function saveCache(templates: Template[]): void {
	const dir = getCacheDir();
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		getCachePath(),
		`${JSON.stringify(templates, null, 2)}\n`,
		"utf-8",
	);
	writeFileSync(getFetchedAtPath(), String(Date.now()), "utf-8");
}

export function isCacheStale(): boolean {
	const fetchedAt = loadFetchedAt();
	if (fetchedAt === null) return true;
	return Date.now() - fetchedAt > STALE_AFTER_MS;
}

export function getCacheAgeDays(): number | null {
	const fetchedAt = loadFetchedAt();
	if (fetchedAt === null) return null;
	return Math.floor((Date.now() - fetchedAt) / (24 * 60 * 60 * 1000));
}

export function nudgeIfStale(logger: PluginLogger): void {
	if (!existsSync(getCachePath())) return;
	if (!isCacheStale()) return;
	const days = getCacheAgeDays();
	const ageText =
		days === null ? "stale" : `${days} day${days === 1 ? "" : "s"} old`;
	logger.warn(
		`Element template cache is ${ageText}. ` +
			"Run 'c8ctl element-template sync' to refresh.",
	);
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function fetchJson(url: string): Promise<unknown> {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(
			`HTTP ${response.status} ${response.statusText} for ${url}`,
		);
	}
	return response.json();
}

async function fetchIndex(): Promise<Record<string, IndexVersionEntry[]>> {
	const raw = await fetchJson(getMarketplaceUrl());
	if (!isRecord(raw)) {
		throw new Error("Marketplace index is not a JSON object");
	}
	// Trust the upstream shape — schema-validated at the marketplace.
	const result: Record<string, IndexVersionEntry[]> = {};
	for (const [id, value] of Object.entries(raw)) {
		if (!Array.isArray(value)) continue;
		const entries: IndexVersionEntry[] = [];
		for (const entry of value) {
			if (!isRecord(entry)) continue;
			entries.push({
				version: typeof entry.version === "number" ? entry.version : undefined,
				ref: typeof entry.ref === "string" ? entry.ref : undefined,
				engine: isRecord(entry.engine)
					? {
							camunda:
								typeof entry.engine.camunda === "string"
									? entry.engine.camunda
									: undefined,
						}
					: undefined,
			});
		}
		result[id] = entries;
	}
	return result;
}

function isTemplateLike(value: unknown): value is Template {
	return isRecord(value) && Array.isArray(value.properties);
}

async function fetchTemplate(url: string): Promise<Template> {
	const raw = await fetchJson(url);
	if (!isTemplateLike(raw)) {
		throw new Error(`Fetched template at ${url} did not match expected shape`);
	}
	return raw;
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

/**
 * Run `fn` over `items` with at most `concurrency` in flight.
 * Each fn() must handle its own errors — exceptions abort the pool.
 */
async function pool<T>(
	items: T[],
	concurrency: number,
	fn: (item: T) => Promise<void>,
): Promise<void> {
	const queue = items.slice();
	const workers = Array.from(
		{ length: Math.min(concurrency, queue.length) },
		async () => {
			while (queue.length > 0) {
				const item = queue.shift();
				if (item === undefined) break;
				await fn(item);
			}
		},
	);
	await Promise.all(workers);
}

/**
 * Flatten the marketplace index `{ id: [{version, ref, engine}] }` into a flat
 * list of `{ id, version, ref, engine }` entries, dropping legacy entries with
 * no `version`.
 */
function flattenIndex(
	index: Record<string, IndexVersionEntry[]>,
): FlatIndexEntry[] {
	const entries: FlatIndexEntry[] = [];
	for (const [id, versions] of Object.entries(index)) {
		for (const entry of versions) {
			if (entry.version === undefined || entry.ref === undefined) continue;
			entries.push({
				id,
				version: entry.version,
				ref: entry.ref,
				engine: entry.engine,
			});
		}
	}
	return entries;
}

/**
 * Sync the cache with the marketplace.
 *
 * - Always re-fetches the index.
 * - Fetches refs that aren't already cached (matches by `metadata.upstreamRef`).
 * - With `prune: true`, drops cached entries whose `upstreamRef` is no longer
 *   in the fresh index.
 *
 * Per-template fetch failures are logged + counted but do not abort the run.
 *
 * Returns a summary `{ total, fetched, cached, errors, pruned }`.
 */
export async function syncTemplates({
	logger,
	prune = false,
}: {
	logger: PluginLogger;
	prune?: boolean;
}): Promise<SyncSummary> {
	logger.info(`Fetching index from ${getMarketplaceUrl()} ...`);
	const index = await fetchIndex();
	const entries = flattenIndex(index);
	logger.info(
		`Index has ${entries.length} template versions across ${Object.keys(index).length} connectors.`,
	);

	const existing = loadCache() || [];
	const byUpstreamRef = new Map<string, Template>();
	for (const tpl of existing) {
		const ref = tpl.metadata?.upstreamRef;
		if (ref) byUpstreamRef.set(ref, tpl);
	}

	const freshRefs = new Set(entries.map((e) => e.ref));
	const toFetch = entries.filter((e) => !byUpstreamRef.has(e.ref));

	logger.info(
		`${
			byUpstreamRef.size > 0
				? `Reusing ${entries.length - toFetch.length} cached, `
				: ""
		}fetching ${toFetch.length} new...`,
	);

	let fetched = 0;
	let errors = 0;
	let progress = 0;
	const fetchedTemplates: Template[] = [];

	await pool(toFetch, FETCH_CONCURRENCY, async (entry) => {
		progress += 1;
		const label = `${entry.id}@${entry.version}`;
		try {
			const template = await fetchTemplate(entry.ref);
			template.metadata = template.metadata || {};
			template.metadata.upstreamRef = entry.ref;
			fetchedTemplates.push(template);
			fetched += 1;
			logger.info(`  [${progress}/${toFetch.length}] ${label}`);
		} catch (error) {
			errors += 1;
			const message = error instanceof Error ? error.message : String(error);
			logger.warn(`  [${progress}/${toFetch.length}] ${label} — ${message}`);
		}
	});

	// Build the new cache: keep cached entries that are still in the index,
	// plus everything we just fetched.
	const next: Template[] = [];
	for (const tpl of existing) {
		const ref = tpl.metadata?.upstreamRef;
		if (ref && freshRefs.has(ref)) {
			next.push(tpl);
		}
	}
	next.push(...fetchedTemplates);

	let pruned = 0;
	if (prune) {
		pruned =
			existing.length -
			next.filter((t) => {
				const ref = t.metadata?.upstreamRef;
				return ref !== undefined && byUpstreamRef.has(ref);
			}).length;
	}

	// Without --prune, keep templates whose upstreamRef vanished from the index
	// (e.g. user wants to retain an older version that was removed upstream).
	if (!prune) {
		for (const tpl of existing) {
			const ref = tpl.metadata?.upstreamRef;
			if (ref && !freshRefs.has(ref) && !next.includes(tpl)) {
				next.push(tpl);
			}
		}
	}

	saveCache(next);

	const summary: SyncSummary = {
		total: next.length,
		fetched,
		cached: entries.length - toFetch.length,
		errors,
		pruned,
	};
	logger.info(
		`Sync complete: ${summary.fetched} fetched, ${summary.cached} cached` +
			`${summary.errors > 0 ? `, ${summary.errors} errors` : ""}` +
			`${prune ? `, ${summary.pruned} pruned` : ""}.`,
	);
	return summary;
}

/**
 * Run a sync if the cache doesn't exist yet. No-op if cache is present.
 */
export async function bootstrapIfNeeded({
	logger,
}: {
	logger: PluginLogger;
}): Promise<void> {
	if (existsSync(getCachePath())) return;
	logger.info("Element template cache not found — running first-time sync...");
	await syncTemplates({ logger });
}

// ---------------------------------------------------------------------------
// Lookup & search
// ---------------------------------------------------------------------------

/**
 * Return all cached templates matching `id`. Empty if none.
 */
export function findById(id: string): Template[] {
	const cache = loadCache();
	if (!cache) return [];
	return cache.filter((t) => t.id === id);
}

export type PickVersionOptions = {
	version?: number;
	executionPlatformVersion?: string | null;
};

/**
 * Pick the template version best matching the BPMN's executionPlatformVersion.
 *
 * - If `version` is given: exact `version` match required.
 * - If `executionPlatformVersion` is given: highest `version` whose
 *   `engines.camunda` is satisfied by `coerce(executionPlatformVersion)`.
 *   Templates without `engines.camunda` are treated as compatible with any
 *   version (legacy fallback).
 * - Otherwise: highest `version`.
 *
 * Returns `null` if no candidate matches.
 */
export function pickVersion(
	templates: Template[],
	{ version, executionPlatformVersion }: PickVersionOptions = {},
): Template | null {
	if (templates.length === 0) return null;

	if (version !== undefined) {
		const exact = templates.find((t) => Number(t.version) === Number(version));
		return exact || null;
	}

	let candidates = templates.filter((t) => t.version !== undefined);

	if (executionPlatformVersion) {
		const coerced = semver.coerce(executionPlatformVersion);
		if (coerced) {
			candidates = candidates.filter((t) => {
				const constraint = t.engines?.camunda;
				if (!constraint) return true;
				return semver.satisfies(coerced, constraint);
			});
		}
	}

	if (candidates.length === 0) return null;
	return candidates.reduce((best, cur) =>
		Number(cur.version) > Number(best.version) ? cur : best,
	);
}

/**
 * Substring search on name + description (case-insensitive). Mirrors Modeler.
 * Returns the latest version of each matching id.
 */
export function searchTemplates(query: string): Template[] {
	const cache = loadCache() || [];
	const q = query.toLowerCase();
	const matches = cache.filter((t) => {
		const name = (t.name || "").toLowerCase();
		const description = (t.description || "").toLowerCase();
		const id = (t.id || "").toLowerCase();
		return name.includes(q) || description.includes(q) || id.includes(q);
	});

	// Reduce to the latest version per id.
	const byId = new Map<string, Template>();
	for (const t of matches) {
		if (t.id === undefined) continue;
		const existing = byId.get(t.id);
		if (!existing || Number(t.version || 0) > Number(existing.version || 0)) {
			byId.set(t.id, t);
		}
	}
	return [...byId.values()];
}
