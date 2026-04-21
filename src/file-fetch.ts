/**
 * Read file content from a local path or URL.
 *
 * Supports:
 * - Local file paths (absolute or relative)
 * - https:// URLs (fetched directly)
 * - GitHub blob URLs (auto-rewritten to raw.githubusercontent.com)
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

/**
 * Detect whether a string looks like a URL (starts with http:// or https://).
 */
export function isUrl(input: string): boolean {
	return input.startsWith("https://") || input.startsWith("http://");
}

/**
 * Rewrite a GitHub blob URL to the raw content URL.
 *
 * Converts:
 *   https://github.com/<owner>/<repo>/blob/<ref>/<path>
 * To:
 *   https://raw.githubusercontent.com/<owner>/<repo>/refs/heads/<ref>/<path>
 */
export function toRawGitHubUrl(url: string): string {
	const match = url.match(
		/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/,
	);
	if (match) {
		const [, owner, repo, rest] = match;
		return `https://raw.githubusercontent.com/${owner}/${repo}/refs/heads/${rest}`;
	}
	return url;
}

/**
 * Fetch text content from a URL, with GitHub blob URL rewriting.
 */
export async function fetchUrl(url: string): Promise<string> {
	const resolvedUrl = toRawGitHubUrl(url);
	const response = await fetch(resolvedUrl);
	if (!response.ok) {
		throw new Error(`Failed to fetch ${resolvedUrl}: HTTP ${response.status}`);
	}
	return response.text();
}

/**
 * Read text content from a local file path or URL.
 *
 * - URLs (http/https) are fetched, with GitHub blob URL rewriting
 * - Local paths are resolved and read from disk
 */
export async function readFileOrUrl(input: string): Promise<string> {
	if (isUrl(input)) {
		return fetchUrl(input);
	}
	const resolved = resolvePath(input);
	if (!existsSync(resolved)) {
		throw new Error(`File not found: ${input}`);
	}
	return readFileSync(resolved, "utf-8");
}
