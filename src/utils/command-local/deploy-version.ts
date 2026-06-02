/**
 * Pure version-comparison logic for the deploy/watch server-version check.
 *
 * Extracted from `src/commands/helpers/deploy-helpers.ts` so unit tests
 * can exercise version parsing without a live server connection.
 */

/**
 * Minimum Camunda version that supports deploying additional file extensions
 * beyond .bpmn, .dmn, and .form.
 */
export const MIN_EXTENDED_EXTENSIONS_VERSION: readonly [number, number] = [
	8, 10,
];

/**
 * Parse a Camunda gateway version string and return whether it meets or
 * exceeds the minimum version for extended extension support.
 *
 * Handles pre-release suffixes (`8.10.0-alpha1`, `8.10-SNAPSHOT`),
 * plain semver (`8.10.0`, `9.0.0`), and returns `null` for unparseable
 * strings so the caller can decide on a fallback.
 */
export function meetsMinExtensionVersion(version: string): boolean | null {
	const match = version.match(/^(\d+)\.(\d+)/);
	if (!match) return null;

	const major = Number(match[1]);
	const minor = Number(match[2]);
	const [reqMajor, reqMinor] = MIN_EXTENDED_EXTENSIONS_VERSION;
	return major > reqMajor || (major === reqMajor && minor >= reqMinor);
}
