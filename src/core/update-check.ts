/**
 * Non-blocking CLI self-update notification.
 *
 * The CLI process never touches the network for this. It only reads cached
 * state:
 * - `update-check.json` — latest dist-tag versions, written by a detached
 *   worker process (`update-check-worker.ts`).
 * - `last-update-notification.json` — the version we last notified about.
 *
 * On startup, if the cached check is older than CHECK_INTERVAL_MS, a detached,
 * unref'd worker is spawned to refresh it. A newer version it finds is
 * announced on a later invocation. An unreachable registry, a firewall that
 * drops packets, or a DNS lookup that never answers therefore costs the CLI
 * nothing: an in-process check can't cancel a pending getaddrinfo or connect,
 * and either one holds the event loop (and the shell prompt) open.
 *
 * Design constraints:
 * - Zero extra dependencies (uses node:https + node:fs + node:child_process)
 * - Never delays command execution or exit
 * - Once-per-version notification
 * - Notification output suppressed in JSON output mode; skipped entirely
 *   in CI environments (no spawn, no cache write)
 */

import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { get } from "node:https";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getUserDataDir } from "./config.ts";
import { isRecord } from "./logger.ts";
import { c8ctl, isUnversionedDevBuild } from "./runtime.ts";

/** npm registry metadata endpoint (returns JSON with dist-tags). */
const REGISTRY_URL = "https://registry.npmjs.org/@camunda8/cli";

/** Minimum time between background registry checks (ms). */
export const CHECK_INTERVAL_MS = 60 * 60 * 1000;

/** How long the worker waits for the registry before giving up (ms). */
export const WORKER_FETCH_TIMEOUT_MS = 10_000;

/** Written by the worker: when it last ran and what it found. */
const CHECK_FILE = "update-check.json";

/** Written by the CLI: the version it last notified about. */
const NOTIFICATION_FILE = "last-update-notification.json";

interface CheckState {
	/** Epoch ms of the last check attempt (successful or not). */
	checkedAt?: number;
	/** Latest version per dist-tag channel, from the last successful fetch. */
	versions: Record<string, string>;
}

interface NotificationState {
	/** The remote version we last notified about. */
	notifiedVersion?: string;
}

/**
 * Detect the npm dist-tag channel from the running version.
 * Versions like "1.2.0-alpha.5" → "alpha", everything else → "latest".
 */
export function detectChannel(version: string): string {
	return version.includes("-alpha.") ? "alpha" : "latest";
}

function readJson(file: string): Record<string, unknown> | undefined {
	try {
		const filePath = join(getUserDataDir(), file);
		if (!existsSync(filePath)) return undefined;
		const raw: unknown = JSON.parse(readFileSync(filePath, "utf-8"));
		return isRecord(raw) ? raw : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Best-effort write. Goes through a temp file + rename so a reader never
 * sees a half-written file while the worker and the CLI run concurrently.
 */
function writeJson(file: string, data: unknown): void {
	try {
		const dir = getUserDataDir();
		mkdirSync(dir, { recursive: true });
		const target = join(dir, file);
		const temp = `${target}.${process.pid}.tmp`;
		writeFileSync(temp, JSON.stringify(data), "utf-8");
		renameSync(temp, target);
	} catch {
		// Best-effort — don't crash if the write fails
	}
}

function readCheckState(): CheckState {
	const raw = readJson(CHECK_FILE);
	const versions: Record<string, string> = {};
	if (raw && isRecord(raw.versions)) {
		for (const [channel, version] of Object.entries(raw.versions)) {
			if (typeof version === "string") versions[channel] = version;
		}
	}
	return {
		checkedAt: typeof raw?.checkedAt === "number" ? raw.checkedAt : undefined,
		versions,
	};
}

function readNotificationState(): NotificationState {
	const raw = readJson(NOTIFICATION_FILE);
	return typeof raw?.notifiedVersion === "string"
		? { notifiedVersion: raw.notifiedVersion }
		: {};
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

type Transport = (
	url: string,
	init: { signal?: AbortSignal },
) => Promise<Response>;

/**
 * GET via node:https. Runs only in the worker, whose deadline bounds a stall,
 * so it uses the default agent: that keeps Node's env proxy support
 * (NODE_USE_ENV_PROXY + HTTPS_PROXY), which a blocked network may need.
 */
export const httpsTransport: Transport = (url, { signal }) =>
	new Promise((resolve, reject) => {
		const req = get(url, { signal }, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (c: Buffer) => chunks.push(c));
			res.on("end", () =>
				resolve(
					new Response(Buffer.concat(chunks), { status: res.statusCode ?? 0 }),
				),
			);
			res.on("error", reject);
		});
		req.on("error", reject);
	});

let transport: Transport = httpsTransport;

/**
 * Fetch the latest version for a given dist-tag from the npm registry.
 * Returns undefined on any failure (offline, timeout, etc.).
 */
export async function fetchRemoteVersion(
	channel: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	try {
		const res = await transport(REGISTRY_URL, { signal });
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
 * Worker body: fetch the channel's latest version and record it.
 * Runs in the detached worker process, never in the CLI process.
 *
 * `checkedAt` is recorded before the fetch so that, while the registry is
 * unreachable, CLI invocations don't respawn a worker each time.
 */
export async function runUpdateCheck(channel: string): Promise<void> {
	const state = readCheckState();
	writeJson(CHECK_FILE, { ...state, checkedAt: Date.now() });

	const version = await fetchRemoteVersion(
		channel,
		AbortSignal.timeout(WORKER_FETCH_TIMEOUT_MS),
	);
	if (!version) return;

	const latest = readCheckState();
	writeJson(CHECK_FILE, {
		...latest,
		versions: { ...latest.versions, [channel]: version },
	});
}

type Spawner = (channel: string) => void;

/**
 * Launch the worker detached and unref'd: the CLI neither waits for it nor
 * shares its process group, so Ctrl-C or the shell prompt are unaffected.
 */
const spawnWorker: Spawner = (channel) => {
	// `.ts` when running from source, `.js` from dist
	const ext = extname(fileURLToPath(import.meta.url));
	const worker = fileURLToPath(
		new URL(`./update-check-worker${ext}`, import.meta.url),
	);
	try {
		const child = spawn(process.execPath, [worker, channel], {
			detached: true,
			stdio: "ignore",
			windowsHide: true,
		});
		child.on("error", () => {});
		child.unref();
	} catch {
		// Best-effort — never fail the command over an update check
	}
};

let spawner: Spawner = spawnWorker;

/** The notification resolved from cache, printed after the command. */
let pendingNotification: { message: string; version: string } | undefined;

/**
 * Start the non-blocking update check. Call this once at CLI startup.
 *
 * Reads the cached check result (sync, no network) to decide what
 * `printUpdateNotification()` will print, and spawns the background worker
 * if the cache is stale.
 */
export function startUpdateCheck(currentVersion: string): void {
	// Suppress in CI environments
	if (process.env.CI) return;

	// Suppress for the development placeholder version
	if (isUnversionedDevBuild(currentVersion)) return;

	const channel = detectChannel(currentVersion);
	const state = readCheckState();

	const stale =
		state.checkedAt === undefined ||
		Date.now() - state.checkedAt >= CHECK_INTERVAL_MS;
	if (stale) spawner(channel);

	const remoteVersion = state.versions[channel];
	if (!remoteVersion || !isNewer(currentVersion, remoteVersion)) return;
	if (readNotificationState().notifiedVersion === remoteVersion) return;

	const installCmd =
		channel === "alpha"
			? "npm install -g @camunda8/cli@alpha"
			: "npm install -g @camunda8/cli";
	pendingNotification = {
		message: `A newer version of c8ctl is available (${currentVersion} → ${remoteVersion}). Update with: ${installCmd}`,
		version: remoteVersion,
	};
}

/**
 * Print the update notification if one was resolved.
 * Call this after the main command has completed. Never waits.
 *
 * Suppressed in JSON output mode.
 */
export function printUpdateNotification(): void {
	if (c8ctl.outputMode === "json") return;
	if (!pendingNotification) return;

	// Persist so we don't nag about this version again (deferred to print time
	// so JSON-mode suppression doesn't write the cache prematurely)
	writeJson(NOTIFICATION_FILE, {
		...readJson(NOTIFICATION_FILE),
		notifiedVersion: pendingNotification.version,
	});

	console.log(`\n${pendingNotification.message}`);
}

/**
 * Reset internal state (for testing only).
 */
export function _resetForTesting(): void {
	pendingNotification = undefined;
	spawner = spawnWorker;
	transport = httpsTransport;
}

/** Override the HTTP transport (for testing only). */
export function _setTransportForTesting(t: Transport): void {
	transport = t;
}

/** Override how the worker is launched (for testing only). */
export function _setSpawnerForTesting(s: Spawner): void {
	spawner = s;
}
