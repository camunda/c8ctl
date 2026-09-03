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
 */

import { gunzipSync } from "node:zlib";
import semver from "semver";
import { isRecord, USER_AGENT } from "./helpers.ts";

const DEFAULT_RELEASES_URL =
	"https://api.github.com/repos/camunda/connectors/releases?per_page=100";

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
		const version = semver.valid(tag);
		if (!version || isReleaseCandidate(version)) continue;
		const assetUrl = findTemplatesAssetUrl(entry);
		if (!assetUrl) continue;
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

/**
 * Fetch the connector releases and reduce them to the newest release
 * per minor line.
 */
export async function fetchConnectorReleases(): Promise<ConnectorRelease[]> {
	const url = getReleasesUrl();
	const response = await fetch(url, {
		headers: {
			"User-Agent": USER_AGENT,
			Accept: "application/vnd.github+json",
		},
		signal: AbortSignal.timeout(RELEASES_FETCH_TIMEOUT_MS),
	});
	if (!response.ok) {
		// 403/429 from api.github.com is almost always the unauthenticated
		// rate limit (60 requests/hour/IP), which a user can wait out or
		// route around with a mirror.
		const hint =
			response.status === 403 || response.status === 429
				? "\nThe GitHub API rate limit may be exhausted — retry later, or point " +
					"C8CTL_CONNECTORS_RELEASES_URL at a mirror of the release listing."
				: "";
		throw new Error(
			`HTTP ${response.status} ${response.statusText} for ${url}${hint}`,
		);
	}
	return selectLatestPerMinor(parseReleases(await response.json()));
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
