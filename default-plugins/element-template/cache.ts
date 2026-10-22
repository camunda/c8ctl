/**
 * OOTB element-template cache.
 *
 * Source: the @camunda/connectors-element-templates npm package.
 * Cache entries retain a versioned upstreamRef so unchanged published
 * packages can be reused without downloading their archive again.
 */

import {
	closeSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import semver from "semver";
import { extractJsonEntries } from "./archive.ts";
import { isRecord, type Logger, type Template } from "./helpers.ts";

const DEFAULT_PACKAGE = "@camunda/connectors-element-templates";
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

function getPackageStatePath(): string {
	return join(getCacheDir(), "package-state.json");
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

function loadPackageState(): { ref: string; count: number } | null {
	try {
		const parsed: unknown = JSON.parse(
			readFileSync(getPackageStatePath(), "utf-8"),
		);
		if (
			isRecord(parsed) &&
			typeof parsed.ref === "string" &&
			typeof parsed.count === "number"
		) {
			return { ref: parsed.ref, count: parsed.count };
		}
	} catch {
		// An absent or incomplete marker means the package must be repacked.
	}
	return null;
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

/** Persist the cache after a successful sync. */
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
// Package ingestion
// ---------------------------------------------------------------------------

function isTemplateLike(value: unknown): value is Template {
	return isRecord(value) && Array.isArray(value.properties);
}

/**
 * Published package versions are immutable, so the ref identifies
 * both the package version and its archive entry.
 */
function buildUpstreamRef(packageRef: string, entryName: string): string {
	return `${packageRef}#${entryName}`;
}

function packageOfRef(ref: string): string {
	const hash = ref.indexOf("#");
	return hash === -1 ? ref : ref.slice(0, hash);
}

function packTemplates(spec: string, expectedVersion?: string): Template[] {
	const c8ctl = globalThis.c8ctl;
	if (!c8ctl) throw new Error("c8ctl npm runner is not available.");
	const dir = mkdtempSync(join(tmpdir(), "c8ctl-element-templates-"));
	try {
		const output = c8ctl.npm({
			args: [
				"pack",
				spec,
				"--ignore-scripts",
				"--json",
				"--pack-destination",
				dir,
			],
			stdout: true,
		}).stdout;
		const result: unknown = JSON.parse(output);
		if (
			!Array.isArray(result) ||
			!isRecord(result[0]) ||
			typeof result[0].filename !== "string" ||
			!/^[^/\\]+\.tgz$/.test(result[0].filename)
		) {
			throw new Error("npm pack did not return a valid archive filename.");
		}
		const archivePath = join(dir, result[0].filename);
		if (statSync(archivePath).size > 32 * 1024 * 1024) {
			throw new Error("Element template package archive exceeds 32 MB.");
		}
		const entries = extractJsonEntries(readFileSync(archivePath));
		const manifest = entries.find(
			(entry) => entry.name === "package/package.json",
		);
		if (!manifest)
			throw new Error("Element template package has no package.json.");
		const parsedManifest: unknown = JSON.parse(manifest.content);
		if (
			!isRecord(parsedManifest) ||
			typeof parsedManifest.name !== "string" ||
			typeof parsedManifest.version !== "string" ||
			(expectedVersion && parsedManifest.name !== DEFAULT_PACKAGE) ||
			(expectedVersion && parsedManifest.version !== expectedVersion)
		) {
			throw new Error(
				"Element template package has an unexpected name or version.",
			);
		}
		const ref = `npm:${parsedManifest.name}@${parsedManifest.version}`;
		const templates: Template[] = [];
		for (const entry of entries) {
			if (
				!entry.name.startsWith("package/src/element-templates/") ||
				!entry.name.endsWith(".json")
			)
				continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(entry.content);
			} catch {
				continue;
			}
			for (const value of Array.isArray(parsed) ? parsed : [parsed]) {
				if (
					!isTemplateLike(value) ||
					typeof value.id !== "string" ||
					typeof value.version !== "number"
				)
					continue;
				value.metadata = {
					...value.metadata,
					upstreamRef: buildUpstreamRef(ref, entry.name),
				};
				templates.push(value);
			}
		}
		if (templates.length === 0)
			throw new Error("Package contained no element templates.");
		return templates;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function latestPackageVersion(spec: string): string {
	const c8ctl = globalThis.c8ctl;
	if (!c8ctl) throw new Error("c8ctl npm runner is not available.");
	const raw = c8ctl.npm({
		args: ["view", spec, "version", "--json"],
		stdout: true,
	}).stdout;
	const parsed: unknown = JSON.parse(raw);
	if (typeof parsed !== "string" || !semver.valid(parsed)) {
		throw new Error(`npm returned an invalid version for ${spec}.`);
	}
	return parsed;
}

function mergeTemplates(
	fresh: Template[],
	existing: Template[],
	prune: boolean,
): { templates: Template[]; fetched: number; cached: number; pruned: number } {
	const templates: Template[] = [];
	const seen = new Set<string>();
	for (const tpl of sortTemplates(fresh)) {
		const key = `${tpl.id}@${tpl.version}`;
		if (seen.has(key)) continue;
		seen.add(key);
		templates.push(tpl);
	}
	const fetched = templates.length;
	let cached = 0;
	let pruned = 0;
	for (const tpl of sortTemplates(existing)) {
		const key = `${tpl.id}@${tpl.version}`;
		if (seen.has(key)) continue;
		if (prune) {
			pruned++;
			continue;
		}
		seen.add(key);
		templates.push(tpl);
		cached++;
	}
	return { templates: sortTemplates(templates), fetched, cached, pruned };
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

/** Order templates by id, then version — a stable cache ordering. */
function sortTemplates(templates: Template[]): Template[] {
	return [...templates].sort((a, b) => {
		const idCmp = (a.id ?? "").localeCompare(b.id ?? "");
		if (idCmp !== 0) return idCmp;
		return (a.version ?? 0) - (b.version ?? 0);
	});
}

/**
 * Sync the cache with the published npm package. Overrides can specify
 * an npm package spec, URL, or local path; these are repacked each time
 * so mutable local sources are not mistaken for immutable registry versions.
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
	const spec = process.env.C8CTL_ELEMENT_TEMPLATES_PACKAGE || DEFAULT_PACKAGE;
	const suffix = spec.startsWith(`${DEFAULT_PACKAGE}@`)
		? spec.slice(DEFAULT_PACKAGE.length + 1)
		: "";
	const registrySpec =
		spec === DEFAULT_PACKAGE ||
		(Boolean(suffix) &&
			(Boolean(semver.valid(suffix)) ||
				(semver.validRange(suffix) === null &&
					/^[a-z][\w.-]*$/i.test(suffix))));
	const version = registrySpec ? latestPackageVersion(spec) : undefined;
	const desiredRef = version ? `npm:${DEFAULT_PACKAGE}@${version}` : undefined;

	let existing: Template[];
	try {
		existing = loadCache() || [];
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logger.warn(`Corrupt cache — starting fresh: ${message}`);
		existing = [];
	}

	const packageState = loadPackageState();
	const matching = desiredRef
		? existing.filter(
				(tpl) =>
					tpl.metadata?.upstreamRef &&
					packageOfRef(tpl.metadata.upstreamRef) === desiredRef,
			)
		: [];
	const reusable =
		desiredRef !== undefined &&
		packageState !== null &&
		packageState.ref === desiredRef &&
		packageState.count === matching.length
			? matching
			: [];
	let errors = 0;
	let fresh = reusable;
	if (reusable.length === 0) {
		logger.info("Packing element templates with npm ...");
		try {
			fresh = packTemplates(
				version ? `${DEFAULT_PACKAGE}@${version}` : spec,
				version,
			);
		} catch {
			errors = 1;
			logger.warn(
				"Could not pack element templates. Check the package spec and npm registry settings.",
			);
		}
	}
	if (errors > 0) {
		if (existing.length === 0) {
			throw new Error(
				"No element templates could be downloaded (package download failed). " +
					"Check the warnings above and retry 'c8ctl element-template sync'.",
			);
		}
		if (prune) {
			logger.warn(
				"Skipping prune: package download failed — cached templates were kept.",
			);
		}
		return {
			total: existing.length,
			fetched: 0,
			cached: existing.length,
			errors,
			pruned: 0,
		};
	}
	const {
		templates: next,
		fetched: added,
		cached: retained,
		pruned,
	} = mergeTemplates(fresh, existing, prune);

	if (next.length === 0) {
		// Nothing downloaded, nothing reusable — writing an empty cache
		// here would make `requireCachePresent()` pass over a cache that
		// can never resolve a template.
		throw new Error(
			"No element templates could be downloaded (package was empty). " +
				"Check the warnings above and retry 'c8ctl element-template sync'.",
		);
	}

	// A partial sync leaves the previous `fetched-at` in place so the
	// staleness nudge keeps asking for a full refresh.
	saveCache(next);
	if (desiredRef) {
		atomicWriteFileSync(
			getPackageStatePath(),
			JSON.stringify({ ref: desiredRef, count: added }),
		);
	} else {
		try {
			unlinkSync(getPackageStatePath());
		} catch (error) {
			if (getErrorCode(error) !== "ENOENT") throw error;
		}
	}

	const summary: SyncSummary = {
		total: next.length,
		fetched: reusable.length ? 0 : added,
		cached: reusable.length ? retained + added : retained,
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
