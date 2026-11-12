/**
 * Prerequisite checks for `c8ctl setup`: Node.js version, operating
 * system and architecture, and network access to the Camunda 8 Run
 * download host.
 *
 * Inputs (versions, platform, fetch, environment) are parameters with
 * the real runtime as the default, so every outcome is testable.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import semver from "semver";

export type PrerequisiteId = "node" | "platform" | "network";

export interface PrerequisiteResult {
	readonly id: PrerequisiteId;
	readonly title: string;
	readonly ok: boolean;
	/** What was found, e.g. "Node.js 22.17.1 is installed; c8ctl needs >=22.18.0." */
	readonly detail: string;
	/** How to fix a failed check. */
	readonly hint?: string;
}

/** The `fetch` subset the network check uses. */
export type PrerequisiteFetch = (
	url: string,
	init: { method: string; signal: AbortSignal },
) => Promise<unknown>;

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Pages for setting Camunda up by hand, for anyone who cannot meet a
 * prerequisite. Unversioned docs.camunda.io URLs resolve to the current
 * release.
 */
export const MANUAL_SETUP_LINKS: readonly {
	readonly label: string;
	readonly url: string;
}[] = [
	{
		label: "Run your first process without c8ctl",
		url: "https://docs.camunda.io/docs/guides/getting-started-hello-world/",
	},
	{
		label: "Install and start Camunda 8 Run",
		url: "https://docs.camunda.io/docs/self-managed/quickstart/developer-quickstart/c8run/install-start/",
	},
	{
		label: "Install Desktop Modeler",
		url: "https://docs.camunda.io/docs/components/modeler/desktop-modeler/install-the-modeler/",
	},
];

// ── Node.js ────────────────────────────────────────────────────────

function readRequiredNodeRange(): string | undefined {
	try {
		// src/utils/command-local/ and dist/utils/command-local/ are both
		// three levels below the package root.
		const pkg: unknown = JSON.parse(
			readFileSync(
				join(import.meta.dirname, "..", "..", "..", "package.json"),
				"utf-8",
			),
		);
		const engines =
			pkg && typeof pkg === "object" && "engines" in pkg
				? pkg.engines
				: undefined;
		const node =
			engines && typeof engines === "object" && "node" in engines
				? engines.node
				: undefined;
		return typeof node === "string" ? node : undefined;
	} catch {
		return undefined;
	}
}

/** The Node.js range from c8ctl's `engines.node`, the one npm enforces. */
export const REQUIRED_NODE_RANGE = readRequiredNodeRange();

export function checkNodeVersion({
	version = process.versions.node,
	range = REQUIRED_NODE_RANGE,
}: {
	version?: string;
	range?: string;
} = {}): PrerequisiteResult {
	const title = "Node.js version";
	if (!range) {
		return { id: "node", title, ok: true, detail: `Node.js ${version}.` };
	}
	const ok = semver.satisfies(version, range, { includePrerelease: true });
	return ok
		? { id: "node", title, ok, detail: `Node.js ${version}.` }
		: {
				id: "node",
				title,
				ok,
				detail: `Node.js ${version} is installed; c8ctl needs ${range}.`,
				hint: "Install a supported Node.js release from https://nodejs.org/en/download, then run c8ctl setup again.",
			};
}

// ── Platform ───────────────────────────────────────────────────────

/**
 * Where Camunda 8 Run can be downloaded and run. Mirrors the platforms the
 * bundled cluster plugin can install for.
 */
const SUPPORTED_PLATFORMS: ReadonlySet<string> = new Set([
	"darwin",
	"linux",
	"win32",
]);
const SUPPORTED_ARCHS: ReadonlySet<string> = new Set(["x64", "arm64"]);

export function checkPlatform({
	platform = process.platform,
	arch = process.arch,
}: {
	platform?: string;
	arch?: string;
} = {}): PrerequisiteResult {
	const title = "Operating system";
	const ok = SUPPORTED_PLATFORMS.has(platform) && SUPPORTED_ARCHS.has(arch);
	return ok
		? { id: "platform", title, ok, detail: `${platform} ${arch}.` }
		: {
				id: "platform",
				title,
				ok,
				detail: `Camunda 8 Run is not available for ${platform} ${arch}.`,
				hint: "Camunda 8 Run supports macOS, Linux and Windows on x64 or arm64.",
			};
}

// ── Network ────────────────────────────────────────────────────────

const DEFAULT_DOWNLOAD_URL =
	"https://downloads.camunda.cloud/release/camunda/c8run/";
const DEFAULT_NETWORK_TIMEOUT_MS = 10_000;

/** The download base URL, honouring the same mirror override as the cluster plugin. */
function downloadBaseUrl(env: Env): string {
	return (env.C8CTL_C8RUN_DOWNLOAD_URL || DEFAULT_DOWNLOAD_URL).replace(
		/\/*$/,
		"/",
	);
}

/** A URL safe to print: credentials removed, falling back to the host. */
function displayUrl(url: string): string {
	try {
		const parsed = new URL(url);
		parsed.username = "";
		parsed.password = "";
		return parsed.toString();
	} catch {
		return "the download host";
	}
}

/** The first error code in an error's cause chain, e.g. ENOTFOUND. */
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

function networkHint(env: Env): string {
	if (env.C8CTL_C8RUN_DOWNLOAD_URL) {
		return (
			"C8CTL_C8RUN_DOWNLOAD_URL points the download at a mirror. Make sure that " +
			"server is reachable, or unset it to use the Camunda Download Center."
		);
	}
	if ((env.HTTPS_PROXY || env.https_proxy) && env.NODE_USE_ENV_PROXY !== "1") {
		return (
			"HTTPS_PROXY is set, but Node.js only uses it when NODE_USE_ENV_PROXY=1 is " +
			"set as well (Node.js 22.21+ or 24.5+). Set NODE_USE_ENV_PROXY=1 and try again."
		);
	}
	return (
		"Check your network connection. Behind a proxy? Set HTTPS_PROXY together with " +
		"NODE_USE_ENV_PROXY=1 (Node.js 22.21+ or 24.5+)."
	);
}

/**
 * Check that the Camunda 8 Run download host answers. Any HTTP response
 * counts as reachable; only a connection failure or timeout fails.
 */
export async function checkNetwork({
	fetch = globalThis.fetch,
	env = process.env,
	timeoutMs = DEFAULT_NETWORK_TIMEOUT_MS,
}: {
	fetch?: PrerequisiteFetch;
	env?: Env;
	timeoutMs?: number;
} = {}): Promise<PrerequisiteResult> {
	const title = "Network access";
	const url = downloadBaseUrl(env);
	const shown = displayUrl(url);
	try {
		await fetch(url, {
			method: "HEAD",
			signal: AbortSignal.timeout(timeoutMs),
		});
		return { id: "network", title, ok: true, detail: `${shown} is reachable.` };
	} catch (error) {
		const timedOut =
			error instanceof DOMException && error.name === "TimeoutError";
		const reason = timedOut
			? `timed out after ${timeoutMs / 1000}s`
			: (causeCode(error) ??
				(error instanceof Error ? error.message : String(error)));
		return {
			id: "network",
			title,
			ok: false,
			detail: `Could not reach ${shown} (${reason}).`,
			hint: networkHint(env),
		};
	}
}

// ── All checks ─────────────────────────────────────────────────────

export async function checkPrerequisites(
	options: {
		version?: string;
		range?: string;
		platform?: string;
		arch?: string;
		fetch?: PrerequisiteFetch;
		env?: Env;
		timeoutMs?: number;
	} = {},
): Promise<PrerequisiteResult[]> {
	return [
		checkNodeVersion(options),
		checkPlatform(options),
		await checkNetwork(options),
	];
}

/** Explain the failed checks and point at the manual setup instead. */
export function formatPrerequisiteFailures(
	results: readonly PrerequisiteResult[],
): string {
	const failed = results.filter((result) => !result.ok);
	return [
		"c8ctl setup cannot continue:",
		"",
		...failed.flatMap((result) => [
			`  ✗ ${result.title}: ${result.detail}`,
			...(result.hint ? [`    ${result.hint}`] : []),
		]),
		"",
		"To set up Camunda by hand instead:",
		...MANUAL_SETUP_LINKS.map((link) => `  ${link.label}: ${link.url}`),
	].join("\n");
}
