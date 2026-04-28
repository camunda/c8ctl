/**
 * Pure search helpers extracted from `src/commands/search.ts` so tests
 * can import them without violating the test→commands import boundary
 * (#291). Search command handlers in `src/commands/search.ts` re-import
 * these.
 */

import type { Logger } from "./logger.ts";

/** Default page size the Camunda REST API uses when no explicit limit is set */
export const API_DEFAULT_PAGE_SIZE = 100;

/**
 * Detect wildcard characters (* or ?) in a string value and return
 * a $like filter object for the API. Returns the plain string for exact match.
 *
 * Supported wildcards (per Camunda REST API LikeFilter):
 *   * — matches zero, one, or multiple characters
 *   ? — matches exactly one character
 *   Escape with backslash: \* or \?
 */
export const hasUnescapedWildcard = (value: string): boolean =>
	/(?<!\\)[*?]/.test(value);

export const toStringFilter = (value: string): string | { $like: string } =>
	hasUnescapedWildcard(value) ? { $like: value } : value;

/**
 * Convert a wildcard pattern (* and ?) to a case-insensitive RegExp.
 * Handles escaped wildcards (\* and \?).
 */
export const wildcardToRegex = (
	pattern: string,
	caseInsensitive = true,
): RegExp => {
	let regex = "";
	for (let i = 0; i < pattern.length; i++) {
		if (
			pattern[i] === "\\" &&
			i + 1 < pattern.length &&
			(pattern[i + 1] === "*" || pattern[i + 1] === "?")
		) {
			regex += pattern[i + 1] === "*" ? "\\*" : "\\?";
			i++;
		} else if (pattern[i] === "*") {
			regex += ".*";
		} else if (pattern[i] === "?") {
			regex += ".";
		} else {
			regex += pattern[i].replace(/[[\]{}()+.,\\^$|#]/g, "\\$&");
		}
	}
	return new RegExp(`^${regex}$`, caseInsensitive ? "i" : "");
};

/**
 * Test if a value matches a wildcard pattern case-insensitively.
 * Without wildcards, performs exact case-insensitive match.
 */
export const matchesCaseInsensitive = (
	value: unknown,
	pattern: string,
): boolean => {
	if (value == null || typeof value !== "string") return false;
	return wildcardToRegex(pattern).test(value);
};

/**
 * Test if a value matches a wildcard pattern case-sensitively.
 * Without wildcards, performs exact case-sensitive match.
 */
export const matchesCaseSensitive = (
	value: unknown,
	pattern: string,
): boolean => {
	if (value == null || typeof value !== "string") return false;
	return wildcardToRegex(pattern, false).test(value);
};

/**
 * Log a "no results" message with 🕳️ emoji and contextual hint.
 */
export function logNoResults(
	logger: Logger,
	resourceName: string,
	hasFilters: boolean,
	unknownFlags?: string[],
): void {
	if (unknownFlags && unknownFlags.length > 0) {
		const flagList = unknownFlags.map((f) => `--${f}`).join(", ");
		logger.info(
			`🕳️ No ${resourceName} found matching the criteria (ignored unknown flag(s): ${flagList})`,
		);
	} else {
		logger.info(`🕳️ No ${resourceName} found matching the criteria`);
	}
	if (!hasFilters) {
		logger.info(
			'No filters were applied. Use "c8ctl help search" to see available filter flags.',
		);
	}
}

/**
 * Log the result count with a truncation warning when the count matches the API default page size.
 */
export function logResultCount(
	logger: Logger,
	count: number,
	resourceName: string,
	hasFilters: boolean,
): void {
	logger.info(`Found ${count} ${resourceName}`);
	if (count === API_DEFAULT_PAGE_SIZE && !hasFilters) {
		logger.warn(
			`Showing first ${API_DEFAULT_PAGE_SIZE} results (API default page size). More results may exist — add filters to narrow down.`,
		);
	} else if (count === API_DEFAULT_PAGE_SIZE) {
		logger.warn(
			`Result count equals the API default page size (${API_DEFAULT_PAGE_SIZE}). There may be more results.`,
		);
	}
}
