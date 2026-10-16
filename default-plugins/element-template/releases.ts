/**
 * OOTB element-template source: the `camunda/connectors` GitHub releases.
 *
 * Every connectors release publishes a
 * `connectors-bundle-templates-<tag>.tar.gz` asset containing one JSON
 * file per element template. We list the releases, keep the newest
 * release per minor line (8.7.x, 8.8.x, ...), and download those
 * bundles from `github.com/.../releases/download/...`.
 *
 * Why not `raw.githubusercontent.com` (the previous source, reached via
 * the marketplace index): that host is blocked in many enterprise
 * networks, while the release download host is generally reachable —
 * see camunda/c8ctl#530.
 *
 * The listing comes from the GitHub REST API, which allows only 60
 * unauthenticated requests per hour per IP. A `GITHUB_TOKEN`/`GH_TOKEN`
 * is sent when present, and a refused or unreachable listing falls back
 * to the releases Atom feed on `github.com`.
 */

import { gunzipSync } from "node:zlib";
import semver from "semver";
import { isRecord, type Logger, USER_AGENT } from "./helpers.ts";

const DEFAULT_RELEASES_URL =
	"https://api.github.com/repos/camunda/connectors/releases?per_page=100";

/**
 * Fallback when the REST listing is refused (unauthenticated rate limit)
 * or unreachable: the public Atom feed of the same releases. It is served
 * by `github.com`, not `api.github.com`, so the REST API rate limit does
 * not apply. It only lists the newest releases and carries neither asset
 * nor draft information, so it is a degraded source — see
 * `parseReleasesFeed()`.
 */
const DEFAULT_RELEASES_FEED_URL =
	"https://github.com/camunda/connectors/releases.atom";

/** Only this host receives the user's GitHub token. */
const GITHUB_API_HOST = "api.github.com";

/**
 * Listing statuses that mean "the API refused us", not "the listing is
 * broken": 403/429 are the rate limit, 401 a rejected token.
 */
const FALLBACK_STATUSES = new Set([401, 403, 429]);

/** Prefix of the release asset holding the element-template bundle. */
const TEMPLATES_ASSET_PREFIX = "connectors-bundle-templates-";
const TEMPLATES_ASSET_SUFFIX = ".tar.gz";

const RELEASES_FETCH_TIMEOUT_MS = 30_000; // 30 s for the release listing
const ASSET_FETCH_TIMEOUT_MS = 120_000; // 120 s per bundle download

/**
 * Decompression guard: the largest bundle we will unpack in memory.
 * Real bundles are <10 MB uncompressed; the cap keeps a malicious or
 * corrupt archive from exhausting the heap.
 */
const MAX_BUNDLE_BYTES = 128 * 1024 * 1024;

/**
 * How many minor lines to cache, newest first (8.10.x, 8.9.x, 8.8.x,
 * 8.7.x at the time of writing). Roughly Camunda's supported-version
 * window, and small enough that the newest release of every selected
 * line is always present in a single page of the release listing.
 */
const MAX_MINOR_LINES = 4;

export type ConnectorRelease = {
	/** Release tag, e.g. `8.8.18` or `8.10.0-alpha3`. */
	tag: string;
	/** Parsed semver of the tag. */
	version: string;
	/** `github.com` download URL of the element-template bundle asset. */
	assetUrl: string;
};

export function getReleasesUrl(): string {
	return process.env.C8CTL_CONNECTORS_RELEASES_URL || DEFAULT_RELEASES_URL;
}

export function getReleasesFeedUrl(): string {
	return (
		process.env.C8CTL_CONNECTORS_RELEASES_FEED_URL || DEFAULT_RELEASES_FEED_URL
	);
}

// ---------------------------------------------------------------------------
// Release selection
// ---------------------------------------------------------------------------

/**
 * Release candidates (`8.8.18-rc1`) are superseded within days and are
 * never what a user wants. Alphas are kept: for a minor that has not
 * had a stable release yet (`8.10.0-alpha3`), the alpha is the only
 * source of that line's templates.
 *
 * Note semver ranks `8.10.0-alpha5-rc3` *above* `8.10.0-alpha5` (more
 * prerelease identifiers win when the leading ones are equal), so the
 * filter has to be explicit rather than relying on ordering.
 */
function isReleaseCandidate(version: string): boolean {
	const prerelease = semver.prerelease(version);
	if (!prerelease) return false;
	// Connectors tag RCs both as `8.8.18-rc1` (own identifier) and
	// `8.10.0-alpha5-rc3` (hyphen-joined into one identifier), so split
	// on `-` as well before matching.
	return prerelease
		.flatMap((part) => (typeof part === "string" ? part.split("-") : []))
		.some((part) => /^rc\d*$/i.test(part));
}

function findTemplatesAssetUrl(
	release: Record<string, unknown>,
): string | null {
	if (!Array.isArray(release.assets)) return null;
	for (const asset of release.assets) {
		if (!isRecord(asset)) continue;
		const { name, browser_download_url: url } = asset;
		if (typeof name !== "string" || typeof url !== "string") continue;
		if (
			name.startsWith(TEMPLATES_ASSET_PREFIX) &&
			name.endsWith(TEMPLATES_ASSET_SUFFIX)
		) {
			return url;
		}
	}
	return null;
}

/**
 * Narrow the GitHub releases payload to the releases that actually ship
 * an element-template bundle: published (not draft), tagged with a
 * parsable semver, not a release candidate, and carrying the asset.
 */
export function parseReleases(raw: unknown): ConnectorRelease[] {
	if (!Array.isArray(raw)) {
		throw new Error("Connector releases response is not a JSON array");
	}
	const releases: ConnectorRelease[] = [];
	for (const entry of raw) {
		if (!isRecord(entry)) continue;
		if (entry.draft === true) continue;
		const tag = entry.tag_name;
		if (typeof tag !== "string") continue;
		const version = selectableVersion(tag);
		if (!version) continue;
		const assetUrl = findTemplatesAssetUrl(entry);
		if (!assetUrl) continue;
		releases.push({ tag, version, assetUrl });
	}
	return releases;
}

/** The tag's semver, or `null` when it is unparsable or an RC. */
function selectableVersion(tag: string): string | null {
	const version = semver.valid(tag);
	return version && !isReleaseCandidate(version) ? version : null;
}

/** Decode the five predefined XML entities (`&amp;` last). */
function decodeXmlEntities(value: string): string {
	return value
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&quot;", '"')
		.replaceAll("&apos;", "'")
		.replaceAll("&amp;", "&");
}

/** Percent-decode a URL path segment; `null` when it is malformed. */
function decodeTagSegment(segment: string): string | null {
	try {
		return decodeURIComponent(segment);
	} catch {
		return null;
	}
}

/** `href` of an entry's `<link rel="alternate">` (or rel-less) element. */
function findAlternateHref(entry: string): string | null {
	for (const [link] of entry.matchAll(/<link\b[^>]*>/g)) {
		const rel = /\brel="([^"]*)"/.exec(link)?.[1] ?? "alternate";
		const href = /\bhref="([^"]*)"/.exec(link)?.[1];
		if (rel === "alternate" && href) return decodeXmlEntities(href);
	}
	return null;
}

/**
 * Narrow the `releases.atom` feed to the same `ConnectorRelease` shape
 * `parseReleases()` produces.
 *
 * Each entry links to `<repo>/releases/tag/<tag>`; the bundle asset URL
 * is derived from it as `<repo>/releases/download/<tag>/
 * connectors-bundle-templates-<tag>.tar.gz`, the URL the REST listing
 * reports as `browser_download_url`.
 *
 * What the feed cannot tell us, compared with the REST listing:
 * - whether the bundle asset is published yet — a release still being
 *   built yields a URL that 404s, which sync reports as one failed
 *   bundle;
 * - anything beyond the newest handful of releases — a minor line
 *   without a recent release is missing from the selection (its
 *   cached templates are kept, see `syncTemplates`).
 * Drafts are not public, so they never appear in the feed.
 */
export function parseReleasesFeed(xml: string): ConnectorRelease[] {
	if (!/<feed\b/.test(xml)) {
		throw new Error("Connector releases feed is not an Atom feed");
	}
	const releases: ConnectorRelease[] = [];
	for (const [, entry] of xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/g)) {
		const href = findAlternateHref(entry);
		const match = href ? /\/releases\/tag\/([^/?#]+)$/.exec(href) : null;
		if (!href || !match) continue;
		const tag = decodeTagSegment(match[1]);
		const version = tag ? selectableVersion(tag) : null;
		if (!tag || !version) continue;
		const asset = `${TEMPLATES_ASSET_PREFIX}${tag}${TEMPLATES_ASSET_SUFFIX}`;
		const assetUrl = new URL(
			`../download/${encodeURIComponent(tag)}/${encodeURIComponent(asset)}`,
			href,
		).href;
		releases.push({ tag, version, assetUrl });
	}
	return releases;
}

/**
 * Keep the newest release of each of the `MAX_MINOR_LINES` newest minor
 * lines, newest line first.
 *
 * Older patches of a minor add nothing: every bundle is cumulative, so
 * `8.8.18` already contains every template version `8.8.17` shipped.
 * Across minors the bundles do differ (a template version added in
 * 8.9 is absent from the 8.8 line), which is why we keep one release
 * per minor rather than just the newest release overall.
 *
 * The line cap keeps the selection deterministic: the newest release of
 * each of the newest lines is always within one page of the listing,
 * whereas an EOL line's newest release drifts down the listing until it
 * falls off the page and would silently disappear from the selection.
 */
export function selectLatestPerMinor(
	releases: ConnectorRelease[],
): ConnectorRelease[] {
	const latest = new Map<string, ConnectorRelease>();
	for (const release of releases) {
		const key = `${semver.major(release.version)}.${semver.minor(release.version)}`;
		const current = latest.get(key);
		if (!current || semver.gt(release.version, current.version)) {
			latest.set(key, release);
		}
	}
	return [...latest.values()]
		.sort((a, b) => semver.rcompare(a.version, b.version))
		.slice(0, MAX_MINOR_LINES);
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export type ConnectorReleaseListing = {
	/** Newest release per minor line, newest line first. */
	releases: ConnectorRelease[];
	/**
	 * `false` when the releases came from the Atom feed fallback, which
	 * only covers the newest releases: a minor line may be missing, so
	 * callers must not treat absence from `releases` as "dropped".
	 */
	complete: boolean;
};

const RATE_LIMIT_HINT =
	"The GitHub API rate limit (60 requests per hour per IP without a token) " +
	"may be exhausted — set GITHUB_TOKEN (or GH_TOKEN) to authenticate the " +
	"release listing, retry later, or point C8CTL_CONNECTORS_RELEASES_URL at " +
	"a mirror of the release listing.";

/**
 * Request headers for the REST release listing. The user's GitHub token
 * (`GITHUB_TOKEN`, then `GH_TOKEN` — the variables `gh` and GitHub
 * Actions use) raises the rate limit from 60 to 5000 requests/hour. It
 * is only ever sent to `api.github.com` over HTTPS, never to a mirror
 * configured via `C8CTL_CONNECTORS_RELEASES_URL`.
 */
function listingHeaders(url: string): Record<string, string> {
	const headers: Record<string, string> = {
		"User-Agent": USER_AGENT,
		Accept: "application/vnd.github+json",
	};
	const token = (process.env.GITHUB_TOKEN || process.env.GH_TOKEN)?.trim();
	const { protocol, hostname } = new URL(url);
	if (token && protocol === "https:" && hostname === GITHUB_API_HOST) {
		headers.Authorization = `Bearer ${token}`;
	}
	return headers;
}

/** `fetch failed` alone says nothing — append the underlying cause. */
function errorMessage(error: unknown): string {
	if (!(error instanceof Error)) return String(error);
	const cause = error.cause instanceof Error ? error.cause.message : "";
	return cause ? `${error.message} (${cause})` : error.message;
}

/** List the releases from the Atom feed (see `parseReleasesFeed`). */
async function fetchReleasesFeed(): Promise<ConnectorRelease[]> {
	const url = getReleasesFeedUrl();
	const response = await fetch(url, {
		headers: {
			"User-Agent": USER_AGENT,
			Accept: "application/atom+xml",
		},
		signal: AbortSignal.timeout(RELEASES_FETCH_TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new Error(
			`HTTP ${response.status} ${response.statusText} for ${url}`,
		);
	}
	return parseReleasesFeed(await response.text());
}

/**
 * Fetch the connector releases and reduce them to the newest release
 * per minor line.
 *
 * When the REST listing is refused (401/403/429 — in practice the
 * unauthenticated rate limit) or unreachable, fall back to the Atom feed
 * at `C8CTL_CONNECTORS_RELEASES_FEED_URL` and report the listing as
 * incomplete. Any other HTTP error (e.g. a broken mirror) is reported
 * as is.
 */
export async function fetchConnectorReleases({
	logger,
}: {
	logger: Logger;
}): Promise<ConnectorReleaseListing> {
	const url = getReleasesUrl();
	const headers = listingHeaders(url);
	let response: Response;
	try {
		response = await fetch(url, {
			headers,
			signal: AbortSignal.timeout(RELEASES_FETCH_TIMEOUT_MS),
		});
	} catch (error) {
		return fetchFeedFallback({
			logger,
			reason: `${url} is unreachable: ${errorMessage(error)}`,
			hint: "",
		});
	}
	if (response.ok) {
		return {
			releases: selectLatestPerMinor(parseReleases(await response.json())),
			complete: true,
		};
	}
	const reason = `HTTP ${response.status} ${response.statusText} for ${url}`;
	if (!FALLBACK_STATUSES.has(response.status)) {
		throw new Error(reason);
	}
	const hint =
		response.status === 401 && headers.Authorization
			? "\nGitHub rejected the token from GITHUB_TOKEN/GH_TOKEN — check or unset it."
			: `\n${RATE_LIMIT_HINT}`;
	return fetchFeedFallback({ logger, reason, hint });
}

async function fetchFeedFallback({
	logger,
	reason,
	hint,
}: {
	logger: Logger;
	reason: string;
	hint: string;
}): Promise<ConnectorReleaseListing> {
	const feedUrl = getReleasesFeedUrl();
	logger.warn(
		`Could not list connector releases (${reason}). Falling back to ${feedUrl}, which only lists the newest releases.`,
	);
	try {
		return {
			releases: selectLatestPerMinor(await fetchReleasesFeed()),
			complete: false,
		};
	} catch (error) {
		throw new Error(
			`${reason}\nThe fallback release feed failed too: ${errorMessage(error)}${hint}`,
		);
	}
}

/** Download a release asset as raw bytes. */
export async function fetchReleaseAsset(url: string): Promise<Uint8Array> {
	const response = await fetch(url, {
		headers: { "User-Agent": USER_AGENT },
		signal: AbortSignal.timeout(ASSET_FETCH_TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new Error(
			`HTTP ${response.status} ${response.statusText} for ${url}`,
		);
	}
	return new Uint8Array(await response.arrayBuffer());
}

// ---------------------------------------------------------------------------
// tar.gz extraction
//
// Node ships gzip but no tar reader, and the bundles are plain ustar
// archives of regular files, so a ~40-line reader beats a dependency.
// ---------------------------------------------------------------------------

const TAR_BLOCK_SIZE = 512;

export type TarEntry = { name: string; content: string };

/** Read a NUL-padded fixed-width tar header field. */
function readTarString(tar: Buffer, offset: number, length: number): string {
	const raw = tar.toString("utf-8", offset, offset + length);
	const nul = raw.indexOf("\0");
	return nul === -1 ? raw : raw.slice(0, nul);
}

/**
 * Extract every `*.json` file from a gzipped ustar archive.
 *
 * Directory entries, long-name extensions and other non-regular
 * entries are skipped rather than failing the whole bundle — the
 * connectors bundle is a flat list of JSON files.
 */
export function extractJsonEntries(gzipped: Uint8Array): TarEntry[] {
	const tar = gunzipSync(gzipped, { maxOutputLength: MAX_BUNDLE_BYTES });
	const entries: TarEntry[] = [];
	let offset = 0;
	while (offset + TAR_BLOCK_SIZE <= tar.length) {
		// Two consecutive zero blocks mark the end of the archive; a
		// single one is enough for us to stop reading.
		if (tar.subarray(offset, offset + TAR_BLOCK_SIZE).every((b) => b === 0)) {
			break;
		}
		const name = readTarString(tar, offset, 100);
		const prefix = readTarString(tar, offset + 345, 155);
		const sizeField = readTarString(tar, offset + 124, 12).trim();
		const size = Number.parseInt(sizeField, 8);
		if (!Number.isFinite(size) || size < 0) {
			throw new Error(
				`Malformed tar header (bad size field) at byte ${offset}`,
			);
		}
		const typeFlag = String.fromCharCode(tar[offset + 156]);
		const dataStart = offset + TAR_BLOCK_SIZE;
		const dataEnd = dataStart + size;
		if (dataEnd > tar.length) {
			throw new Error(`Truncated tar entry '${name}' at byte ${offset}`);
		}
		const fullName = prefix ? `${prefix}/${name}` : name;
		// '0' and '\0' are the two encodings of "regular file".
		if ((typeFlag === "0" || typeFlag === "\0") && fullName.endsWith(".json")) {
			entries.push({
				name: fullName,
				content: tar.toString("utf-8", dataStart, dataEnd),
			});
		}
		offset = dataStart + Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
	}
	return entries;
}
