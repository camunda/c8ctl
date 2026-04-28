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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const semver = require('semver');

const DEFAULT_OOTB_URL = 'https://marketplace.cloud.camunda.io/api/v1/ootb-connectors';
const FETCH_CONCURRENCY = 12;
const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function getMarketplaceUrl() {
  return process.env.C8CTL_OOTB_ELEMENT_TEMPLATES_URL || DEFAULT_OOTB_URL;
}

export function getCacheDir() {
  if (!globalThis.c8ctl?.getUserDataDir) {
    throw new Error('c8ctl runtime is not available; cannot resolve element-template cache dir.');
  }
  return join(globalThis.c8ctl.getUserDataDir(), 'element-templates');
}

function getCachePath() {
  return join(getCacheDir(), 'templates.json');
}

function getFetchedAtPath() {
  return join(getCacheDir(), 'fetched-at');
}

// ---------------------------------------------------------------------------
// Cache I/O
// ---------------------------------------------------------------------------

export function loadCache() {
  const path = getCachePath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch (error) {
    throw new Error(`Element template cache is corrupt at ${path}: ${error.message}`);
  }
}

function loadFetchedAt() {
  const path = getFetchedAtPath();
  if (!existsSync(path)) return null;
  const value = readFileSync(path, 'utf-8').trim();
  const ms = Number(value);
  return Number.isFinite(ms) ? ms : null;
}

function saveCache(templates) {
  const dir = getCacheDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(getCachePath(), `${JSON.stringify(templates, null, 2)}\n`, 'utf-8');
  writeFileSync(getFetchedAtPath(), String(Date.now()), 'utf-8');
}

export function isCacheStale() {
  const fetchedAt = loadFetchedAt();
  if (fetchedAt === null) return true;
  return Date.now() - fetchedAt > STALE_AFTER_MS;
}

export function getCacheAgeDays() {
  const fetchedAt = loadFetchedAt();
  if (fetchedAt === null) return null;
  return Math.floor((Date.now() - fetchedAt) / (24 * 60 * 60 * 1000));
}

export function nudgeIfStale(logger) {
  if (!existsSync(getCachePath())) return;
  if (!isCacheStale()) return;
  const days = getCacheAgeDays();
  logger.warn(
    `Element template cache is ${days} day${days === 1 ? '' : 's'} old. ` +
      `Run 'c8ctl element-template sync' to refresh.`,
  );
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}`);
  }
  return response.json();
}

async function fetchIndex() {
  return fetchJson(getMarketplaceUrl());
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

/**
 * Run `fn` over `items` with at most `concurrency` in flight.
 * Each fn() must handle its own errors — exceptions abort the pool.
 */
async function pool(items, concurrency, fn) {
  const queue = items.slice();
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      await fn(item);
    }
  });
  await Promise.all(workers);
}

/**
 * Flatten the marketplace index `{ id: [{version, ref, engine}] }` into a flat
 * list of `{ id, version, ref, engine }` entries, dropping legacy entries with
 * no `version`.
 */
function flattenIndex(index) {
  const entries = [];
  for (const [id, versions] of Object.entries(index)) {
    if (!Array.isArray(versions)) continue;
    for (const entry of versions) {
      if (entry?.version === undefined || entry?.ref === undefined) continue;
      entries.push({ id, version: entry.version, ref: entry.ref, engine: entry.engine });
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
export async function syncTemplates({ logger, prune = false } = {}) {
  logger.info(`Fetching index from ${getMarketplaceUrl()} ...`);
  const index = await fetchIndex();
  const entries = flattenIndex(index);
  logger.info(`Index has ${entries.length} template versions across ${Object.keys(index).length} connectors.`);

  const existing = loadCache() || [];
  const byUpstreamRef = new Map();
  for (const tpl of existing) {
    const ref = tpl?.metadata?.upstreamRef;
    if (ref) byUpstreamRef.set(ref, tpl);
  }

  const freshRefs = new Set(entries.map((e) => e.ref));
  const toFetch = entries.filter((e) => !byUpstreamRef.has(e.ref));

  logger.info(
    `${byUpstreamRef.size > 0 ? `Reusing ${entries.length - toFetch.length} cached, ` : ''}` +
      `fetching ${toFetch.length} new...`,
  );

  let fetched = 0;
  let errors = 0;
  let progress = 0;
  const fetchedTemplates = [];

  await pool(toFetch, FETCH_CONCURRENCY, async (entry) => {
    progress += 1;
    const label = `${entry.id}@${entry.version}`;
    try {
      const template = await fetchJson(entry.ref);
      template.metadata = template.metadata || {};
      template.metadata.upstreamRef = entry.ref;
      fetchedTemplates.push(template);
      fetched += 1;
      logger.info(`  [${progress}/${toFetch.length}] ${label}`);
    } catch (error) {
      errors += 1;
      logger.warn(`  [${progress}/${toFetch.length}] ${label} — ${error.message}`);
    }
  });

  // Build the new cache: keep cached entries that are still in the index,
  // plus everything we just fetched.
  const next = [];
  for (const tpl of existing) {
    const ref = tpl?.metadata?.upstreamRef;
    if (ref && freshRefs.has(ref)) {
      next.push(tpl);
    }
  }
  next.push(...fetchedTemplates);

  let pruned = 0;
  if (prune) {
    pruned = existing.length - next.filter((t) => byUpstreamRef.has(t?.metadata?.upstreamRef)).length;
  }

  // Without --prune, keep templates whose upstreamRef vanished from the index
  // (e.g. user wants to retain an older version that was removed upstream).
  if (!prune) {
    for (const tpl of existing) {
      const ref = tpl?.metadata?.upstreamRef;
      if (ref && !freshRefs.has(ref) && !next.includes(tpl)) {
        next.push(tpl);
      }
    }
  }

  saveCache(next);

  const summary = {
    total: next.length,
    fetched,
    cached: entries.length - toFetch.length,
    errors,
    pruned,
  };
  logger.info(
    `Sync complete: ${summary.fetched} fetched, ${summary.cached} cached` +
      `${summary.errors > 0 ? `, ${summary.errors} errors` : ''}` +
      `${prune ? `, ${summary.pruned} pruned` : ''}.`,
  );
  return summary;
}

/**
 * Run a sync if the cache doesn't exist yet. No-op if cache is present.
 */
export async function bootstrapIfNeeded({ logger }) {
  if (existsSync(getCachePath())) return;
  logger.info('Element template cache not found — running first-time sync...');
  await syncTemplates({ logger });
}

// ---------------------------------------------------------------------------
// Lookup & search
// ---------------------------------------------------------------------------

/**
 * Return all cached templates matching `id`. Empty if none.
 */
export function findById(id) {
  const cache = loadCache();
  if (!cache) return [];
  return cache.filter((t) => t?.id === id);
}

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
export function pickVersion(templates, { version, executionPlatformVersion } = {}) {
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
  return candidates.reduce((best, cur) => (Number(cur.version) > Number(best.version) ? cur : best));
}

/**
 * Substring search on name + description (case-insensitive). Mirrors Modeler.
 * Returns the latest version of each matching id.
 */
export function searchTemplates(query) {
  const cache = loadCache() || [];
  const q = query.toLowerCase();
  const matches = cache.filter((t) => {
    if (!t || typeof t !== 'object') return false;
    const name = (t.name || '').toLowerCase();
    const description = (t.description || '').toLowerCase();
    const id = (t.id || '').toLowerCase();
    return name.includes(q) || description.includes(q) || id.includes(q);
  });

  // Reduce to the latest version per id.
  const byId = new Map();
  for (const t of matches) {
    const existing = byId.get(t.id);
    if (!existing || Number(t.version || 0) > Number(existing.version || 0)) {
      byId.set(t.id, t);
    }
  }
  return [...byId.values()];
}
