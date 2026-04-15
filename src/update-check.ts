/**
 * Non-blocking CLI self-update notification.
 *
 * On every invocation a fire-and-forget fetch checks the npm registry for a
 * newer version on the appropriate channel (latest or alpha, based on the
 * running version). If one is found and hasn't been notified yet, an update
 * notification is printed after the command completes.
 *
 * Timing strategy — "patient once per day":
 * - Every invocation fires a background fetch immediately.
 * - When the command finishes, if the fetch already resolved, use it (zero delay).
 * - If the fetch is still pending:
 *   - Once per day ("patient" check): wait up to 5 seconds for it to complete.
 *   - All other times: abort immediately — zero post-command delay.
 * - This means an offline user on an airplane sees at most one 5-second delay
 *   per day, and usually zero.
 *
 * Design constraints:
 * - Zero extra dependencies (uses global fetch + node:fs)
 * - Never delays command execution (fire-and-forget with AbortController)
 * - Once-per-version notification (cache in the user data dir)
 * - Notification output suppressed in JSON output mode; skipped entirely
 *   in CI environments (no fetch, no cache write)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getUserDataDir } from "./config.ts";
import { isRecord } from "./logger.ts";
import { c8ctl } from "./runtime.ts";

/** npm registry metadata endpoint (returns JSON with dist-tags). */
const REGISTRY_URL = "https://registry.npmjs.org/@camunda8/cli";

/** Maximum time to wait for the registry fetch on a "patient" check (ms). */
const PATIENT_TIMEOUT_MS = 5000;

/** Interval between "patient" checks — once per day (ms). */
const PATIENT_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Cache file name inside the user data dir. */
const CACHE_FILE = "last-update-notification.json";

interface UpdateCache {
	/** The remote version we last notified about. */
	notifiedVersion?: string;
	/** Epoch ms of the last "patient" check (where we waited for the fetch). */
	lastPatientCheck?: number;
}

/**
 * Detect the npm dist-tag channel from the running version.
 * Versions like "1.2.0-alpha.5" → "alpha", everything else → "latest".
 */
export function detectChannel(version: string): string {
	return version.includes("-alpha.") ? "alpha" : "latest";
}

/**
 * Read the notification cache. Returns undefined if missing or corrupt.
 */
function readCache(): UpdateCache | undefined {
	try {
		const dir = getUserDataDir();
		const filePath = join(dir, CACHE_FILE);
		if (!existsSync(filePath)) return undefined;
		const raw: unknown = JSON.parse(readFileSync(filePath, "utf-8"));
		if (!isRecord(raw)) return undefined;
		const cache: UpdateCache = {};
		if (typeof raw.notifiedVersion === "string")
			cache.notifiedVersion = raw.notifiedVersion;
		if (typeof raw.lastPatientCheck === "number")
			cache.lastPatientCheck = raw.lastPatientCheck;
		return cache;
	} catch {
		return undefined;
	}
}

/**
 * Write the notification cache (records which version we last notified about).
 */
function writeCache(cache: UpdateCache): void {
	try {
		const dir = getUserDataDir();
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, CACHE_FILE), JSON.stringify(cache), "utf-8");
	} catch {
		// Best-effort — don't crash if the write fails
	}
}

/**
 * Naive semver comparison: returns true if `remote` is newer than `local`.
 * Handles prerelease tags (alpha.N) by comparing the numeric suffix.
 *
 * Split on "." and "-" to get [major, minor, patch, preTag?, preNum?].
 * Compare major.minor.patch first; if equal and both are prereleases,
 * compare prerelease numbers. A stable release is always "newer" than
 * a prerelease of the same major.minor.patch.
 */
export function isNewer(local: string, remote: string): boolean {
	const parse = (v: string) => {
		const [core, pre] = v.split("-", 2);
		const parts = core.split(".").map(Number);
		// Extract numeric suffix from prerelease tag like "alpha.5"
		// Normalize NaN to undefined so comparisons don't silently break
		const rawPreNum = pre ? Number(pre.split(".").pop()) : undefined;
		const preNum =
			rawPreNum !== undefined && Number.isFinite(rawPreNum)
				? rawPreNum
				: undefined;
		return { major: parts[0], minor: parts[1], patch: parts[2], pre, preNum };
	};

	const l = parse(local);
	const r = parse(remote);

	// Compare major.minor.patch
	if (r.major !== l.major) return r.major > l.major;
	if (r.minor !== l.minor) return r.minor > l.minor;
	if (r.patch !== l.patch) return r.patch > l.patch;

	// Same core version — compare prerelease
	// No prerelease is "newer" than any prerelease (stable > alpha)
	if (!r.pre && l.pre) return true;
	if (r.pre && !l.pre) return false;

	// Both prereleases — compare numeric suffix
	if (
		r.preNum !== undefined &&
		l.preNum !== undefined &&
		r.preNum !== l.preNum
	) {
		return r.preNum > l.preNum;
	}

	return false;
}

/**
 * Fetch the latest version for a given dist-tag from the npm registry.
 * Returns undefined on any failure (offline, timeout, etc.).
 */
export async function fetchRemoteVersion(
	channel: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	try {
		const res = await fetch(REGISTRY_URL, { signal });
		if (!res.ok) return undefined;
		const data: unknown = await res.json();
		if (!isRecord(data)) return undefined;
		const distTags = data["dist-tags"];
		if (!isRecord(distTags)) return undefined;
		const version = distTags[channel];
		return typeof version === "string" ? version : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The resolved result of an update check.
 * Stored on the module so the notification can be printed after the command.
 */
let pendingNotification: { message: string; version: string } | undefined;

/**
 * A reference to the background check promise (for testing).
 */
let checkPromise: Promise<void> | undefined;

/** Resolves once the background fetch settles (used by Promise.race). */
let fetchSettled: Promise<"settled"> | undefined;
let resolveFetchSettled: (() => void) | undefined;

/** AbortController for the background fetch — exposed so printUpdateNotification can cancel. */
let fetchController: AbortController | undefined;

/**
 * Start the non-blocking update check. Call this once at CLI startup.
 * The result is stored internally and printed by `printUpdateNotification()`.
 *
 * The function is sync — it fires a background fetch and returns immediately.
 */
export function startUpdateCheck(currentVersion: string): void {
	// Suppress in CI environments
	if (process.env.CI) return;

	// Suppress for the development placeholder version
	if (currentVersion === "0.0.0-semantically-released") return;

	const channel = detectChannel(currentVersion);

	fetchController = new AbortController();
	const timeoutId = setTimeout(
		() => fetchController?.abort(),
		PATIENT_TIMEOUT_MS,
	);

	// Create a settlement sentinel — avoids microtask ordering issues with a boolean flag
	fetchSettled = new Promise<"settled">((resolve) => {
		resolveFetchSettled = () => resolve("settled");
	});

	checkPromise = fetchRemoteVersion(channel, fetchController.signal)
		.then((remoteVersion) => {
			if (!remoteVersion) return;
			if (!isNewer(currentVersion, remoteVersion)) return;

			// Check once-per-version cache
			const cache = readCache();
			if (cache?.notifiedVersion === remoteVersion) return;

			// Store the notification for later printing (cache write deferred to print time
			// so JSON-mode suppression doesn't poison the cache)
			const installCmd =
				channel === "alpha"
					? "npm install -g @camunda8/cli@alpha"
					: "npm install -g @camunda8/cli";
			pendingNotification = {
				message: `A newer version of c8ctl is available (${currentVersion} → ${remoteVersion}). Update with: ${installCmd}`,
				version: remoteVersion,
			};
		})
		.catch(() => {
			// Swallow all errors — this is best-effort
		})
		.finally(() => {
			resolveFetchSettled?.();
			clearTimeout(timeoutId);
		});
}

/**
 * Print the update notification if one was resolved.
 * Call this after the main command has completed.
 *
 * Timing: if the fetch already resolved during command execution, use it
 * immediately. If it's still pending, wait only if the last "patient" check
 * was more than 24 hours ago. Otherwise, abort and return instantly.
 *
 * Suppressed in JSON output mode to avoid polluting structured output.
 */
export async function printUpdateNotification(): Promise<void> {
	if (checkPromise && fetchSettled) {
		// Race the fetch settlement against an immediately-resolved sentinel.
		// This avoids microtask ordering issues with a boolean flag.
		const alreadyDone =
			(await Promise.race([fetchSettled, Promise.resolve("pending")])) ===
			"settled";

		if (alreadyDone) {
			// Already done — no delay
			await checkPromise;
		} else if (isPatientCheck()) {
			// Patient check — wait up to PATIENT_TIMEOUT_MS for the fetch
			await checkPromise;
			persistPatientTimestamp();
		} else {
			// Impatient — abort immediately, no post-command delay
			fetchController?.abort();
			return;
		}
	}

	if (!pendingNotification) return;

	// Suppress in JSON mode — don't pollute structured output
	if (c8ctl.outputMode === "json") return;

	// Persist so we don't nag about this version again (deferred from background
	// check so JSON-mode suppression doesn't write the cache prematurely)
	writeCache({
		...readCache(),
		notifiedVersion: pendingNotification.version,
	});

	console.log("");
	console.log(pendingNotification.message);
}

/**
 * Whether this invocation should be a "patient" check (wait for the fetch).
 * Returns true if the last patient check was more than 24 hours ago.
 */
function isPatientCheck(): boolean {
	const cache = readCache();
	const last = cache?.lastPatientCheck;
	if (!last) return true; // Never checked — be patient
	return Date.now() - last >= PATIENT_INTERVAL_MS;
}

/**
 * Record that a patient check happened now.
 */
function persistPatientTimestamp(): void {
	const cache = readCache() ?? {};
	writeCache({ ...cache, lastPatientCheck: Date.now() });
}

/**
 * Reset internal state (for testing only).
 */
export function _resetForTesting(): void {
	pendingNotification = undefined;
	checkPromise = undefined;
	fetchSettled = undefined;
	resolveFetchSettled = undefined;
	fetchController = undefined;
}
