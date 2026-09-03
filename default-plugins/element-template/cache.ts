/**
 * OOTB element-template cache.
 *
 * Source: the `camunda/connectors` GitHub releases (see `releases.ts`).
 * For every supported minor line we download that line's newest
 * `connectors-bundle-templates-<tag>.tar.gz` asset, inline its templates
 * into a single `templates.json` cache file, and inject
 * `metadata.upstreamRef = <assetUrl>#<file>` so subsequent syncs can skip
 * bundles that are already cached (same dedup idea as Modeler's
 * `app/lib/template-updater/util.js`).
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
import { isRecord, type Logger, type Template } from "./helpers.ts";
import {
	type ConnectorRelease,
	extractJsonEntries,
	fetchConnectorReleases,
	fetchReleaseAsset,
	getReleasesUrl,
} from "./releases.ts";

const FETCH_CONCURRENCY = 4;
const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
// Backstop for ghost locks left by PID-recycled crashed syncs. Kept
// well above realistic sync runtimes so a live but slow sync's lock
// is never reclaimed.
const SYNC_LOCK_STALE_AFTER_MS = 60 * 60 * 1000; // 60 minutes

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
// Bundle ingestion
// ---------------------------------------------------------------------------

function isTemplateLike(value: unknown): value is Template {
	return isRecord(value) && Array.isArray(value.properties);
}

/**
 * `metadata.upstreamRef` for a template that came out of a release
 * bundle: the asset URL plus the archive entry it was read from.
 * Both halves are immutable (release assets are tag-pinned), so a
 * cached ref means "this bundle is already ingested".
 */
function buildUpstreamRef(assetUrl: string, entryName: string): string {
	return `${assetUrl}#${entryName}`;
}

/** The asset URL half of an `upstreamRef` (everything before the `#`). */
function assetUrlOfRef(ref: string): string {
	const hash = ref.indexOf("#");
	return hash === -1 ? ref : ref.slice(0, hash);
}

/**
 * Download and unpack one release bundle into templates carrying an
 * `upstreamRef`. Templates without a numeric `version` are skipped:
 * they are pre-versioned legacy templates that version resolution
 * cannot rank.
 */
async function fetchReleaseTemplates(
	release: ConnectorRelease,
): Promise<Template[]> {
	const bundle = await fetchReleaseAsset(release.assetUrl);
	const templates: Template[] = [];
	for (const entry of extractJsonEntries(bundle)) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(entry.content);
		} catch {
			continue;
		}
		if (!isTemplateLike(parsed) || typeof parsed.version !== "number") {
			continue;
		}
		parsed.metadata = {
			...parsed.metadata,
			upstreamRef: buildUpstreamRef(release.assetUrl, entry.name),
		};
		templates.push(parsed);
	}
	if (templates.length === 0) {
		throw new Error(
			`Bundle for release ${release.tag} contained no element templates`,
		);
	}
	return templates;
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

/** Order templates by id, then version — a stable cache ordering. */
function sortTemplates(templates: Template[]): Template[] {
	return [...templates].sort((a, b) => {
		const idCmp = (a.id ?? "").localeCompare(b.id ?? "");
		if (idCmp !== 0) return idCmp;
		return (a.version ?? 0) - (b.version ?? 0);
	});
}

/**
 * Sync the cache with the connectors GitHub releases.
 *
 * - Always re-fetches the release listing and reduces it to the newest
 *   release per minor line.
 * - Downloads the template bundle of every selected release that isn't
 *   already cached (matched by the asset URL half of
 *   `metadata.upstreamRef`).
 * - Deduplicates `id@version` across bundles, preferring the newest
 *   release's copy.
 * - With `prune: true`, drops cached entries that no longer belong to a
 *   selected release.
 *
 * Per-release fetch failures are logged + counted but do not abort the run.
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
	const releasesUrl = getReleasesUrl();
	logger.info(`Fetching connector releases from ${releasesUrl} ...`);
	const releases = await fetchConnectorReleases();
	if (releases.length === 0) {
		throw new Error(
			`No connector release with an element-template bundle found at ${releasesUrl}.`,
		);
	}
	logger.info(
		`Latest release per minor: ${releases.map((r) => r.tag).join(", ")}.`,
	);

	let existing: Template[];
	try {
		existing = loadCache() || [];
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logger.warn(`Corrupt cache — starting fresh: ${message}`);
		existing = [];
	}

	// Group the cache by the bundle each template came from. Anything
	// that doesn't belong to a selected release (no `upstreamRef`, or a
	// bundle that dropped out of the selection) is a prune candidate.
	const selectedAssets = new Set(releases.map((r) => r.assetUrl));
	const cachedByAsset = new Map<string, Template[]>();
	const staleCached: Template[] = [];
	for (const tpl of existing) {
		const ref = tpl.metadata?.upstreamRef;
		const asset = ref ? assetUrlOfRef(ref) : undefined;
		if (asset && selectedAssets.has(asset)) {
			const bucket = cachedByAsset.get(asset);
			if (bucket) bucket.push(tpl);
			else cachedByAsset.set(asset, [tpl]);
		} else {
			staleCached.push(tpl);
		}
	}

	// Release assets are tag-pinned and therefore immutable: a bundle
	// already represented in the cache never has to be downloaded again.
	const toFetch = releases.filter((r) => !cachedByAsset.has(r.assetUrl));
	const reusedCount = [...cachedByAsset.values()].reduce(
		(sum, bucket) => sum + bucket.length,
		0,
	);

	logger.info(
		`${
			reusedCount > 0
				? `Reusing ${reusedCount} cached templates from ${cachedByAsset.size} bundle(s), `
				: ""
		}downloading ${toFetch.length} bundle(s)...`,
	);

	let errors = 0;
	let progress = 0;
	const fetchedByAsset = new Map<string, Template[]>();

	await pool(toFetch, FETCH_CONCURRENCY, async (release) => {
		progress += 1;
		const myProgress = progress;
		try {
			const templates = await fetchReleaseTemplates(release);
			fetchedByAsset.set(release.assetUrl, templates);
			logger.info(
				`  [${myProgress}/${toFetch.length}] ${release.tag} — ${templates.length} templates`,
			);
		} catch (error) {
			errors += 1;
			const message = error instanceof Error ? error.message : String(error);
			logger.warn(
				`  [${myProgress}/${toFetch.length}] ${release.tag} — ${message}`,
			);
		}
	});

	// Build the new cache newest release first, so an `id@version` shipped
	// by several minor lines is taken from the newest one. Each bundle's
	// templates are sorted by id+version so cache order (and therefore
	// search result order) is deterministic regardless of network timing.
	const next: Template[] = [];
	const seen = new Set<string>();
	let fetched = 0;
	let cached = 0;
	const add = (tpl: Template): boolean => {
		const key = `${tpl.id}@${tpl.version}`;
		if (seen.has(key)) return false;
		seen.add(key);
		next.push(tpl);
		return true;
	};

	for (const release of releases) {
		const fresh = fetchedByAsset.get(release.assetUrl);
		const templates = fresh ?? cachedByAsset.get(release.assetUrl) ?? [];
		for (const tpl of sortTemplates(templates)) {
			if (!add(tpl)) continue;
			if (fresh) fetched += 1;
			else cached += 1;
		}
	}

	// Without --prune, keep templates that no longer belong to a selected
	// release (e.g. the user wants to retain a line that dropped out of
	// support). With --prune they are dropped and reported.
	if (!prune) {
		for (const tpl of sortTemplates(staleCached)) {
			add(tpl);
		}
	}
	const pruned = prune ? staleCached.length : 0;

	saveCache(next);

	const summary: SyncSummary = {
		total: next.length,
		fetched,
		cached,
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
