/**
 * Done-checks for `c8ctl setup`: whether Camunda 8 Run is installed and
 * whether the local cluster is healthy. Setup re-checks these on every run
 * instead of trusting a record of earlier runs.
 *
 * Built-in code cannot import the cluster plugin, so the install checks
 * follow its rules (cache location, install layout, binary name). Tests
 * compare them with the plugin's own functions.
 */

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type Env = Readonly<Record<string, string | undefined>>;

// ── Camunda 8 Run installation ─────────────────────────────────────

/** Where the cluster plugin keeps Camunda 8 Run installs. */
export function c8runCacheDir({
	env = process.env,
	platform = process.platform,
	home = homedir(),
}: {
	env?: Env;
	platform?: string;
	home?: string;
} = {}): string {
	if (env.C8RUN_CACHE_DIR) return env.C8RUN_CACHE_DIR;
	switch (platform) {
		case "darwin":
			return join(home, "Library", "Caches", "c8run");
		case "win32":
			return join(
				env.LOCALAPPDATA || join(home, "AppData", "Local"),
				"c8run",
				"cache",
			);
		default:
			return join(env.XDG_CACHE_HOME || join(home, ".cache"), "c8run");
	}
}

const binaryName = (platform: string) =>
	platform === "win32" ? "c8run.exe" : "c8run";

/**
 * Whether `version`'s Camunda 8 Run binary is present: in a
 * `c8run-<version>*` subdirectory of `c8run-<version>`, or directly in it.
 */
export function isCamunda8RunInstalled({
	version,
	cacheDir = c8runCacheDir(),
	platform = process.platform,
}: {
	version: string;
	cacheDir?: string;
	platform?: string;
}): boolean {
	const installDir = join(cacheDir, `c8run-${version}`);
	if (!existsSync(installDir)) return false;
	const binary = binaryName(platform);
	const nested = readdirSync(installDir, { withFileTypes: true }).some(
		(entry) =>
			entry.isDirectory() &&
			entry.name.startsWith(`c8run-${version}`) &&
			existsSync(join(installDir, entry.name, binary)),
	);
	return nested || existsSync(join(installDir, binary));
}

/** Installed versions whose binary is present, in version order. */
export function installedCamunda8RunVersions({
	cacheDir = c8runCacheDir(),
	platform = process.platform,
}: {
	cacheDir?: string;
	platform?: string;
} = {}): string[] {
	if (!existsSync(cacheDir)) return [];
	return readdirSync(cacheDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && entry.name.startsWith("c8run-"))
		.map((entry) => entry.name.slice("c8run-".length))
		.filter((version) =>
			isCamunda8RunInstalled({ version, cacheDir, platform }),
		)
		.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

// ── Local cluster health ───────────────────────────────────────────

/** The endpoint the cluster plugin polls to decide a started cluster is ready. */
export const LOCAL_CLUSTER_HEALTH_URL = "http://localhost:9600/actuator/health";
const DEFAULT_HEALTH_TIMEOUT_MS = 3_000;

/** The `fetch` subset the health check uses. */
export type HealthFetch = (
	url: string,
	init: { signal: AbortSignal },
) => Promise<Response>;

export interface ClusterHealth {
	readonly healthy: boolean;
	/** e.g. "status UP", "HTTP 503", "not reachable (ECONNREFUSED)". */
	readonly detail: string;
}

function causeCode(error: unknown): string | undefined {
	for (let current = error, depth = 0; current && depth < 5; depth++) {
		if (typeof current !== "object") return undefined;
		if ("code" in current && typeof current.code === "string") {
			return current.code;
		}
		current = "cause" in current ? current.cause : undefined;
	}
	return undefined;
}

/**
 * Whether a local cluster is running and healthy: its health endpoint
 * reports `UP`. One request, no retries.
 */
export async function checkLocalClusterHealth({
	fetch = globalThis.fetch,
	timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS,
}: {
	fetch?: HealthFetch;
	timeoutMs?: number;
} = {}): Promise<ClusterHealth> {
	// A referenced timer, unlike AbortSignal.timeout(), so the timeout fires
	// even when nothing else keeps the event loop alive.
	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);
	try {
		const response = await fetch(LOCAL_CLUSTER_HEALTH_URL, {
			signal: controller.signal,
		});
		if (!response.ok) {
			return { healthy: false, detail: `HTTP ${response.status}` };
		}
		let body: unknown;
		try {
			body = await response.json();
		} catch {
			return { healthy: false, detail: "unexpected response" };
		}
		const status =
			body && typeof body === "object" && "status" in body
				? String(body.status)
				: "unknown";
		return { healthy: status === "UP", detail: `status ${status}` };
	} catch (error) {
		const reason = timedOut
			? `timed out after ${timeoutMs / 1000}s`
			: (causeCode(error) ?? "connection failed");
		return { healthy: false, detail: `not reachable (${reason})` };
	} finally {
		clearTimeout(timer);
	}
}
