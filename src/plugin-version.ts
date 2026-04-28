/**
 * Pure helpers extracted from `src/commands/plugins.ts` so tests can
 * import them without violating the test→commands import boundary
 * (#291). Plugin command handlers in `src/commands/plugins.ts` re-import
 * these.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Get installed plugin version from package.json
 */
export function getInstalledPluginVersion(
	nodeModulesPath: string,
	packageName: string,
): string | null {
	const packagePath = join(nodeModulesPath, ...packageName.split("/"));
	const packageJsonPath = join(packagePath, "package.json");

	if (!existsSync(packageJsonPath)) {
		return null;
	}

	try {
		const pkgJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
		return typeof pkgJson.version === "string" ? pkgJson.version : null;
	} catch {
		return null;
	}
}

/**
 * Extract version from a registry source like package@version
 */
export function getVersionFromSource(
	source: string,
	packageName: string,
): string | null {
	const packagePrefix = `${packageName}@`;
	if (!source.startsWith(packagePrefix)) {
		return null;
	}

	const version = source.slice(packagePrefix.length).trim();
	return version.length > 0 ? version : null;
}
