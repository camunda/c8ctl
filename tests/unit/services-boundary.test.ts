/**
 * Architectural guard: the `services` layer is the embedding contract.
 *
 * Hosts other than the CLI, such as Desktop Modeler, import
 * services into their own long-lived process. A service therefore
 * gets everything host-specific from its `C8ctlContext` and must not:
 *
 * - read or write the CLI runtime (`c8ctl.<field>`: session profile and
 *   tenant, output mode, per-invocation flags);
 * - read the process environment or arguments, or change the working
 *   directory's meaning (`process.env`, `process.argv`, `process.cwd`);
 * - exit the process or print (`process.exit`, `process.stdout`,
 *   `process.stderr`, `console.*`).
 *
 * The behavioral side (a service run with a poisoned runtime and a
 * bogus host environment) is covered by `internal.test.ts`.
 */

import assert from "node:assert";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, test } from "node:test";
import { findRuntimeGlobalReads } from "../utils/no-runtime-global-reads.ts";

const PROJECT_ROOT = resolve(import.meta.dirname, "..", "..");
const SERVICES_DIR = join(PROJECT_ROOT, "src", "services");
const INTERNAL_DIR = join(PROJECT_ROOT, "src", "internal");
/** The parts of the contract that live in core. */
const CORE_CONTRACT_FILES = ["context.ts", "target.ts"].map((name) =>
	join(PROJECT_ROOT, "src", "core", name),
);

const FORBIDDEN: readonly { object: string; fields: readonly string[] }[] = [
	{
		object: "c8ctl",
		fields: [
			"activeProfile",
			"activeTenant",
			"outputMode",
			"dryRun",
			"verbose",
			"quiet",
			"resolvedBaseUrl",
			"env",
			"getLogger",
			"createClient",
			"resolveTenantId",
			"getUserDataDir",
			"getModelerDataDir",
		],
	},
	{
		object: "process",
		fields: ["env", "argv", "cwd", "exit", "exitCode", "stdout", "stderr"],
	},
	{ object: "console", fields: ["log", "error", "warn", "info", "debug"] },
];

function listTsFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true, recursive: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
		.map((entry) => join(entry.parentPath, entry.name))
		.sort();
}

describe("architectural guard: services read nothing but their context", () => {
	test("no services file reads the CLI runtime, the process, or the console", () => {
		const violations: string[] = [];
		for (const file of [
			...listTsFiles(SERVICES_DIR),
			...listTsFiles(INTERNAL_DIR),
			...CORE_CONTRACT_FILES,
		]) {
			for (const { object, fields } of FORBIDDEN) {
				for (const read of findRuntimeGlobalReads(file, fields, object)) {
					const rel = file.slice(PROJECT_ROOT.length + 1).split(/[\\/]/);
					violations.push(`  - ${rel.join("/")}:${read.line} — ${read.text}`);
				}
			}
		}
		assert.deepStrictEqual(
			violations,
			[],
			"Services are imported by other hosts and must take host state " +
				"from their C8ctlContext (signal, onProgress, data dirs, fetch, " +
				`env). Found:\n${violations.join("\n")}`,
		);
	});
});
