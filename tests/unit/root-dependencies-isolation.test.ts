/**
 * Architectural guard for issue #405.
 *
 * The published CLI must stay self-contained while keeping its runtime
 * dependency surface minimal: only the genuinely core packages belong in the
 * root `package.json#dependencies`. Every dependency a *default plugin* needs
 * at runtime must be declared in that plugin's own `package.json` and inlined
 * into its esbuild bundle at build time (see `scripts/build-plugins.mjs` and
 * `scripts/build-bpmnlint-vendor.mjs`) — never leaked back into the root
 * dependency list.
 *
 * If a new core dependency is genuinely required by `src/**`, add it to
 * `CORE_DEPENDENCIES` below with justification. If a dependency is only used
 * by a plugin, declare it in that plugin's `package.json` instead.
 */

import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, test } from "node:test";

const PROJECT_ROOT = resolve(import.meta.dirname, "..", "..");

/** Packages allowed in root `dependencies` — imported by `src/**`. */
const CORE_DEPENDENCIES = [
	"@camunda8/orchestration-cluster-api",
	"@modelcontextprotocol/sdk",
];

/** Default plugins that declare their own runtime dependencies. */
const PLUGIN_NAMES = ["bpmn", "feel", "element-template", "cluster"];

function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === "object" && !Array.isArray(value);
}

function readPackageJson(relPath: string): Record<string, unknown> {
	const raw = readFileSync(join(PROJECT_ROOT, relPath), "utf-8");
	const parsed: unknown = JSON.parse(raw);
	if (!isRecord(parsed)) {
		throw new Error(`${relPath} is not a JSON object`);
	}
	return parsed;
}

function dependencyNames(pkg: Record<string, unknown>): string[] {
	const deps = pkg.dependencies;
	if (deps == null) return [];
	if (!isRecord(deps)) {
		throw new Error("dependencies is not an object");
	}
	return Object.keys(deps);
}

describe("architectural guard: root dependencies stay core-only (#405)", () => {
	const root = readPackageJson("package.json");

	test("root dependencies are exactly the core set", () => {
		const actual = dependencyNames(root).sort();
		const expected = [...CORE_DEPENDENCIES].sort();
		assert.deepStrictEqual(
			actual,
			expected,
			"Root package.json#dependencies must list only core packages. " +
				"Plugin-only dependencies belong in the plugin's own package.json " +
				"(they are esbuild-bundled into the published artifact).",
		);
	});

	test("no default-plugin dependency leaks into root dependencies", () => {
		const rootDeps = new Set(dependencyNames(root));
		for (const name of PLUGIN_NAMES) {
			const pkg = readPackageJson(
				join("default-plugins", name, "package.json"),
			);
			for (const dep of dependencyNames(pkg)) {
				assert.ok(
					!rootDeps.has(dep),
					`'${dep}' is declared by the '${name}' plugin but also appears ` +
						"in root dependencies. Remove it from the root — the plugin " +
						"bundle inlines it.",
				);
			}
		}
	});
});
