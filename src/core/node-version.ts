/**
 * Runtime check of the Node.js version against c8ctl's `engines.node`.
 *
 * npm only warns about `engines` at install time (and not at all for a
 * global install unless `engine-strict` is set), so an outdated Node.js can
 * run c8ctl and fail later with an unrelated-looking error.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import semver from "semver";
import { isRecord } from "./logger.ts";

function readRequiredNodeRange(): string | undefined {
	try {
		// Two levels below the package root in both src/core/ and dist/core/.
		const packageJson = join(
			dirname(fileURLToPath(import.meta.url)),
			"..",
			"..",
			"package.json",
		);
		const pkg: unknown = JSON.parse(readFileSync(packageJson, "utf-8"));
		const node = isRecord(pkg) && isRecord(pkg.engines) && pkg.engines.node;
		return typeof node === "string" ? node : undefined;
	} catch {
		return undefined;
	}
}

/** The Node.js range from c8ctl's `engines.node`. */
export const REQUIRED_NODE_RANGE = readRequiredNodeRange();

/**
 * Describe why `version` does not satisfy `range`, or `null` when it does or
 * when the range is unknown or unparseable (nothing can be concluded then).
 */
export function describeUnsupportedNode({
	version = process.versions.node,
	range = REQUIRED_NODE_RANGE,
}: {
	version?: string;
	range?: string;
} = {}): string | null {
	if (!range || !semver.validRange(range)) return null;
	if (semver.satisfies(version, range)) return null;
	return `Node.js ${version} is not supported; c8ctl needs ${range}. Some commands may fail. Upgrade Node.js from https://nodejs.org/.`;
}
