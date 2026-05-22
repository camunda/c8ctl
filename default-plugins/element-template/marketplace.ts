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

import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";
import semver from "semver";
import { isRecord, type Logger, type Template, USER_AGENT } from "./helpers.ts";

const DEFAULT_OOTB_URL =
	"https://marketplace.cloud.camunda.io/api/v1/ootb-connectors";
const FETCH_CONCURRENCY = 12;
const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const FETCH_TIMEOUT_MS = 30_000; // 30 s per HTTP request
// Backstop for ghost locks left by PID-recycled crashed syncs. Kept
// well above realistic sync runtimes so a live but slow sync's lock
// is never reclaimed.
const SYNC_LOCK_STALE_AFTER_MS = 60 * 60 * 1000; // 60 minutes

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

function getSyncLockPath(): string {
	return join(getCacheDir(), ".sync.lock");
}

// ---------------------------------------------------------------------------
// Sync lock — serialises concurrent `sync` runs so they don't silently
// undo each other's `--prune` (atomic rename prevents torn files but
// not stale-read clobbers).
// ---------------------------------------------------------------------------

type SyncLockPayload = { pid: number; startedAt: number };

/**
 * Read `error.code` if the thrown value carries one. Errors from the
 * `node:fs` and `node:process` APIs all set `code` to a `string`; this
 * narrows safely without an `as NodeJS.ErrnoException` cast.
 */
function getErrorCode(error: unknown): string | undefined {
	if (isRecord(error) && typeof error.code === "string") {
		return error.code;
	}
	return undefined;
}

function isProcessAlive(pid: number): boolean {
	try {
		// Signal 0 doesn't deliver a signal — it just tests permission /
		// existence. ESRCH means the PID is gone.
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means the process exists but we lack permission — still alive.
		return getErrorCode(error) === "EPERM";
	}
}

function readLockPayload(path: string): SyncLockPayload | null {
	try {
		const raw = readFileSync(path, "utf-8");
		const parsed: unknown = JSON.parse(raw);
		if (
			isRecord(parsed) &&
			typeof parsed.pid === "number" &&
			typeof parsed.startedAt === "number"
		) {
			return { pid: parsed.pid, startedAt: parsed.startedAt };
		}
	} catch {
		// Unreadable / unparsable lock counts as stale.
	}
	return null;
}

function tryCreateLock(path: string, payload: SyncLockPayload): boolean {
	try {
		const fd = openSync(path, "wx", 0o644);
		try {
			writeSync(fd, JSON.stringify(payload));
		} finally {
			closeSync(fd);
		}
		return true;
	} catch (error) {
		if (getErrorCode(error) === "EEXIST") {
			return false;
		}
		throw error;
	}
}

/**
 * Acquire the sync lock or throw with a user-actionable message.
 *
 * The lock is a regular file at `<cacheDir>/.sync.lock` holding
 * `{pid, startedAt}` JSON. We use `openSync("wx")` for atomic create —
 * two concurrent attempts cannot both win on the same filesystem.
 *
 * If an existing lock is from a dead PID or older than
 * `SYNC_LOCK_STALE_AFTER_MS`, we treat it as stale, log, and retry
 * the create once. A persistent EEXIST after that is a real race with
 * another live sync — surface it.
 */
function acquireSyncLock(logger: Logger): void {
	const dir = getCacheDir();
	mkdirSync(dir, { recursive: true });
	const path = getSyncLockPath();
	const payload: SyncLockPayload = {
		pid: process.pid,
		startedAt: Date.now(),
	};
	if (tryCreateLock(path, payload)) {
		return;
	}

	const existing = readLockPayload(path);
	const age = existing ? Date.now() - existing.startedAt : Infinity;
	const stale =
		existing === null ||
		!isProcessAlive(existing.pid) ||
		age > SYNC_LOCK_STALE_AFTER_MS;

	if (stale) {
		if (existing) {
			logger.warn(
				`Removed stale sync lock from pid ${existing.pid} (age ${Math.round(age / 1000)}s).`,
			);
		}
		try {
			unlinkSync(path);
		} catch {
			// Someone else may have just cleaned it up — fine, we'll retry below.
		}
		if (tryCreateLock(path, payload)) {
			return;
		}
	}

	const detail = existing
		? `pid ${existing.pid}, started ${new Date(existing.startedAt).toISOString()}`
		: "unknown owner";
	throw new Error(
		`Another sync is in progress (${detail}). ` +
			`Wait for it to finish or remove ${path} if you're sure no other sync is running.`,
	);
}

function releaseSyncLock(): void {
	try {
		unlinkSync(getSyncLockPath());
	} catch {
		// Best-effort — the lock may already be gone if a signal handler
		// raced with the normal `finally`.
	}
}

/**
 * Run `body` while the sync lock is held. Installs signal handlers
 * so the lock is released on SIGINT/SIGTERM (otherwise a Ctrl-C
 * during sync would orphan the lockfile, leaving the next run to
 * wait the stale window). Only the lock-release handlers we add are
 * removed in `finally`; any pre-existing listeners are left untouched.
 */
async function withSyncLock<T>(
	logger: Logger,
	body: () => Promise<T>,
): Promise<T> {
	acquireSyncLock(logger);
	const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
	const handlers = new Map<NodeJS.Signals, () => void>();
	for (const sig of signals) {
		const handler = () => {
			releaseSyncLock();
			// Re-raise the signal with the default action so the process
			// actually exits with the expected status. Remove our listener
			// first so we don't recurse.
			process.removeListener(sig, handler);
			process.kill(process.pid, sig);
		};
		handlers.set(sig, handler);
		process.on(sig, handler);
	}
	try {
		return await body();
	} finally {
		for (const [sig, handler] of handlers) {
			process.removeListener(sig, handler);
		}
		releaseSyncLock();
	}
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

/**
 * Write `contents` to `target` via a sibling temp file + atomic
 * `renameSync`. Readers either see the old file or the new file —
 * never a truncated mid-write state. POSIX `rename` is atomic on the
 * same filesystem (which a sibling in the same directory always is).
 */
function atomicWriteFileSync(target: string, contents: string): void {
	const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	try {
		writeFileSync(tmp, contents, "utf-8");
		renameSync(tmp, target);
	} catch (error) {
		try {
			unlinkSync(tmp);
		} catch {
			// Best-effort cleanup — the original error is the one that matters.
		}
		throw error;
	}
}

function saveCache(templates: Template[]): void {
	const dir = getCacheDir();
	mkdirSync(dir, { recursive: true });
	atomicWriteFileSync(
		getCachePath(),
		`${JSON.stringify(templates, null, 2)}\n`,
	);
	atomicWriteFileSync(getFetchedAtPath(), String(Date.now()));
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

export function nudgeIfStale(logger: Logger): void {
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
	const response = await fetch(url, {
		headers: { "User-Agent": USER_AGENT },
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
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
	logger: Logger;
	prune?: boolean;
}): Promise<SyncSummary> {
	return withSyncLock(logger, () => syncTemplatesLocked({ logger, prune }));
}

async function syncTemplatesLocked({
	logger,
	prune,
}: {
	logger: Logger;
	prune: boolean;
}): Promise<SyncSummary> {
	logger.info(`Fetching index from ${getMarketplaceUrl()} ...`);
	const index = await fetchIndex();
	const entries = flattenIndex(index);
	logger.info(
		`Index has ${entries.length} template versions across ${Object.keys(index).length} connectors.`,
	);

	let existing: Template[];
	try {
		existing = loadCache() || [];
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logger.warn(`Corrupt cache — starting fresh: ${message}`);
		existing = [];
	}
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
		const myProgress = progress;
		const label = `${entry.id}@${entry.version}`;
		try {
			const template = await fetchTemplate(entry.ref);
			template.metadata = template.metadata || {};
			template.metadata.upstreamRef = entry.ref;
			fetchedTemplates.push(template);
			fetched += 1;
			logger.info(`  [${myProgress}/${toFetch.length}] ${label}`);
		} catch (error) {
			errors += 1;
			const message = error instanceof Error ? error.message : String(error);
			logger.warn(`  [${myProgress}/${toFetch.length}] ${label} — ${message}`);
		}
	});

	// Build the new cache: keep cached entries that are still in the index,
	// plus everything we just fetched. Sort fetched entries by id+version so
	// cache order (and therefore search result order) is deterministic
	// regardless of network timing.
	fetchedTemplates.sort((a, b) => {
		const idCmp = (a.id ?? "").localeCompare(b.id ?? "");
		if (idCmp !== 0) return idCmp;
		return (a.version ?? 0) - (b.version ?? 0);
	});
	const next: Template[] = [];
	for (const tpl of existing) {
		const ref = tpl.metadata?.upstreamRef;
		if (ref && freshRefs.has(ref)) {
			next.push(tpl);
		}
	}
	next.push(...fetchedTemplates);

	// `pruned` = cached entries whose upstreamRef no longer appears in the
	// fresh index (or that never had one). The "without --prune" branch
	// below preserves these entries; with --prune we drop them, and the
	// summary line reports that count to the user.
	let pruned = 0;
	if (prune) {
		pruned = existing.filter((t) => {
			const ref = t.metadata?.upstreamRef;
			return ref === undefined || !freshRefs.has(ref);
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
 * Sentinel error message used by all subcommands that need the cache
 * present. Phrased as a directive so callers don't have to invent
 * their own copy.
 */
export const CACHE_NOT_FOUND_MESSAGE =
	"Element template cache not found. Run 'c8ctl element-template sync' to download it first.";

/**
 * Throw a uniform error when the cache is missing. We deliberately do
 * NOT auto-bootstrap — bootstrap progress goes to stdout via
 * `logger.info`, which would corrupt any pipe the caller has set up
 * (apply | bpmn lint, get > template.json, ...). Sync is one explicit
 * command and the error tells the user to run it.
 */
export function requireCachePresent(): void {
	if (existsSync(getCachePath())) {
		return;
	}
	throw new Error(CACHE_NOT_FOUND_MESSAGE);
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

export type SearchTemplatesOptions = {
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
 * Substring search on name + description + keywords (case-insensitive).
 * Mirrors Modeler's discovery path. Deprecated versions are excluded
 * before the per-id latest-version reduction so that if the newest
 * version of a connector is deprecated, the latest non-deprecated
 * version is still discoverable.
 */
export function searchTemplates(
	query: string,
	{ executionPlatformVersion }: SearchTemplatesOptions = {},
): Template[] {
	const cache = loadCache() || [];
	const q = query.toLowerCase();
	let matches = cache
		.filter((t) => {
			const name = (t.name || "").toLowerCase();
			const description = (t.description || "").toLowerCase();
			const id = (t.id || "").toLowerCase();
			const keywords = (t.keywords ?? []).map((k) => k.toLowerCase()).join(" ");
			return (
				name.includes(q) ||
				description.includes(q) ||
				id.includes(q) ||
				keywords.includes(q)
			);
		})
		// Filter deprecated before per-id reduction so the latest
		// non-deprecated version surfaces when the newest is deprecated.
		.filter((t) => !t.deprecated);

	if (executionPlatformVersion) {
		const coerced = semver.coerce(executionPlatformVersion);
		if (coerced) {
			matches = matches.filter((t) => {
				const constraint = t.engines?.camunda;
				if (!constraint) return true;
				return semver.satisfies(coerced, constraint);
			});
		}
	}

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
