/**
 * Connector release archive recovery for forbidden marketplace template refs.
 *
 * The marketplace index remains authoritative. This module selects an archive
 * compatible with that index and exposes only indexed template versions.
 */

import { strFromU8, unzipSync } from "fflate";
import semver from "semver";
import { isRecord, type Logger, type Template, USER_AGENT } from "./helpers.ts";

const DEFAULT_CONNECTOR_RELEASES_URL =
	"https://api.github.com/repos/camunda/connectors/releases?per_page=100";
const FETCH_TIMEOUT_MS = 30_000; // 30 s per HTTP request

export type MarketplaceTemplateEntry = {
	id: string;
	version: number;
	ref: string;
	engine: { camunda?: string } | undefined;
};

type ConnectorRelease = {
	tag: string;
	major: number;
	minor: number;
	archiveUrl: string;
};

type ArchivedTemplate = {
	name: string;
	template: Template;
};

export type MarketplaceReleaseArchive = {
	url: string;
	templates: Map<string, ArchivedTemplate[]>;
};

export class HttpResponseError extends Error {
	readonly status: number;

	constructor(status: number, statusText: string, url: string) {
		super(`HTTP ${status} ${statusText} for ${url}`);
		this.name = "HttpResponseError";
		this.status = status;
	}
}

export function isForbiddenResponse(error: unknown): boolean {
	return error instanceof HttpResponseError && error.status === 403;
}

async function fetchResponse(
	url: string,
	headers: Record<string, string> = {},
): Promise<Response> {
	const response = await fetch(url, {
		headers: { "User-Agent": USER_AGENT, ...headers },
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new HttpResponseError(response.status, response.statusText, url);
	}
	return response;
}

async function fetchJson(
	url: string,
	headers: Record<string, string> = {},
): Promise<unknown> {
	return (await fetchResponse(url, headers)).json();
}

async function fetchBytes(url: string): Promise<Uint8Array> {
	return new Uint8Array(await (await fetchResponse(url)).arrayBuffer());
}

function isTemplateLike(value: unknown): value is Template {
	return isRecord(value) && Array.isArray(value.properties);
}

function templateKey(id: string, version: number): string {
	return `${id}@${version}`;
}

function getEntryKey(entry: MarketplaceTemplateEntry): string {
	return templateKey(entry.id, entry.version);
}

function getTemplateKey(template: Template): string | null {
	if (
		typeof template.id !== "string" ||
		typeof template.version !== "number" ||
		!Number.isFinite(template.version)
	) {
		return null;
	}
	return templateKey(template.id, template.version);
}

function getEngineLine(
	entries: MarketplaceTemplateEntry[],
): { major: number; minor: number } | null {
	let latest: { major: number; minor: number } | null = null;
	for (const entry of entries) {
		const constraint = entry.engine?.camunda;
		if (!constraint) continue;
		const match = constraint.match(/(\d+)\.(\d+)/);
		if (!match) continue;
		const major = Number(match[1]);
		const minor = Number(match[2]);
		if (
			latest === null ||
			major > latest.major ||
			(major === latest.major && minor > latest.minor)
		) {
			latest = { major, minor };
		}
	}
	return latest;
}

function getArchiveFileNames(entry: MarketplaceTemplateEntry): Set<string> {
	const names = new Set<string>();
	try {
		const pathname = new URL(entry.ref).pathname;
		const basename = pathname.slice(pathname.lastIndexOf("/") + 1);
		if (!basename.endsWith(".json")) return names;
		const stem = basename.slice(0, -".json".length);
		names.add(`${stem}-${entry.version}.json`);
		names.add(basename);
	} catch {
		// The index ref remains the primary source; an invalid ref simply
		// prevents filename-based disambiguation in the archive fallback.
	}
	return names;
}

function parseConnectorRelease(value: unknown): ConnectorRelease | null {
	if (!isRecord(value) || value.draft === true) return null;
	if (typeof value.tag_name !== "string") return null;
	const parsed = semver.parse(value.tag_name);
	if (!parsed) return null;
	if (!Array.isArray(value.assets)) return null;

	const assetName = `connectors-bundle-templates-${value.tag_name}.zip`;
	for (const asset of value.assets) {
		if (!isRecord(asset) || asset.name !== assetName) continue;
		if (typeof asset.browser_download_url !== "string") continue;
		return {
			tag: value.tag_name,
			major: parsed.major,
			minor: parsed.minor,
			archiveUrl: asset.browser_download_url,
		};
	}
	return null;
}

async function getConnectorArchiveUrl(
	entries: MarketplaceTemplateEntry[],
): Promise<string> {
	const raw = await fetchJson(DEFAULT_CONNECTOR_RELEASES_URL, {
		Accept: "application/vnd.github+json",
	});
	if (!Array.isArray(raw)) {
		throw new Error("GitHub releases response is not an array");
	}

	const releases = raw
		.map(parseConnectorRelease)
		.filter((release): release is ConnectorRelease => release !== null);
	const engineLine = getEngineLine(entries);
	const compatible = engineLine
		? releases.filter(
				(release) =>
					release.major === engineLine.major &&
					release.minor === engineLine.minor,
			)
		: releases;
	if (compatible.length === 0) {
		const line = engineLine
			? `Camunda ${engineLine.major}.${engineLine.minor}`
			: "the marketplace catalogue";
		throw new Error(`No connector template release found for ${line}`);
	}

	compatible.sort((a, b) => semver.rcompare(a.tag, b.tag));
	return compatible[0].archiveUrl;
}

export async function fetchReleaseArchive({
	entries,
	logger,
}: {
	entries: MarketplaceTemplateEntry[];
	logger: Logger;
}): Promise<MarketplaceReleaseArchive> {
	const url = await getConnectorArchiveUrl(entries);
	logger.info(`Fetching connector template release archive from ${url} ...`);
	let files: Record<string, Uint8Array>;
	try {
		files = unzipSync(await fetchBytes(url));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Failed to read connector template archive ${url}: ${message}`,
		);
	}

	const wanted = new Set(entries.map(getEntryKey));
	const templates = new Map<string, ArchivedTemplate[]>();
	for (const [name, bytes] of Object.entries(files)) {
		if (!name.toLowerCase().endsWith(".json")) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(strFromU8(bytes));
		} catch {
			continue;
		}
		if (!isTemplateLike(parsed)) continue;
		const key = getTemplateKey(parsed);
		if (!key || !wanted.has(key)) continue;
		const candidates = templates.get(key) || [];
		candidates.push({ name, template: parsed });
		templates.set(key, candidates);
	}
	return { url, templates };
}

export function getArchivedTemplate(
	entry: MarketplaceTemplateEntry,
	archive: MarketplaceReleaseArchive,
): Template {
	const candidates = archive.templates.get(getEntryKey(entry)) || [];
	if (candidates.length === 0) {
		throw new Error(
			`Release archive ${archive.url} does not contain ${getEntryKey(entry)}`,
		);
	}
	if (candidates.length === 1) return candidates[0].template;

	const expectedNames = getArchiveFileNames(entry);
	const named = candidates.filter((candidate) =>
		expectedNames.has(
			candidate.name.slice(candidate.name.lastIndexOf("/") + 1),
		),
	);
	if (named.length === 1) return named[0].template;

	throw new Error(
		`Release archive ${archive.url} contains ambiguous entries for ${getEntryKey(entry)}`,
	);
}
