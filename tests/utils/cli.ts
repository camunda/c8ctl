/**
 * Shared test utilities for CLI behavioural (dry-run) tests.
 *
 * Provides a subprocess helper that invokes the CLI with a deterministic
 * environment and a JSON parser for dry-run output.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asyncSpawn, type SpawnResult } from "./spawn.ts";

const CLI = "src/index.ts";

/**
 * A shared temp data dir with outputMode set to "json" so that tests
 * produce deterministic output regardless of the host environment.
 */
const TEST_DATA_DIR = mkdtempSync(join(tmpdir(), "c8ctl-test-"));
writeFileSync(
	join(TEST_DATA_DIR, "session.json"),
	JSON.stringify({ outputMode: "json" }),
);

/**
 * Options recognised by the test `c8()` / `c8WithOptions()` helpers.
 *
 * `timeout` is forwarded to `asyncSpawn` and ultimately to Node's `execFile`,
 * which SIGTERMs the child after the deadline. Use it for invocations that
 * could legitimately hang (e.g. long-running verbs on a regression of the
 * --help gate) so the test fails fast instead of stalling the suite.
 */
export interface C8Options {
	timeout?: number;
}

/**
 * Build the env passed to every spawned CLI process.
 *
 * Sanitises DEBUG / C8CTL_DEBUG / NODE_DEBUG / NODE_OPTIONS so a developer or
 * CI runner that exports a debug variable doesn't add stray stderr output that
 * breaks tests asserting on a clean stderr (e.g. the --help contract sweep).
 * The prod CLI's own logging is unaffected — these are debug-only env vars
 * consulted by Node and by the CLI's verbose-logging path.
 */
function buildChildEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		CAMUNDA_BASE_URL: "http://test-cluster/v2",
		HOME: "/tmp/c8ctl-test-nonexistent-home",
		C8CTL_DATA_DIR: TEST_DATA_DIR,
	};
	delete env.DEBUG;
	delete env.C8CTL_DEBUG;
	delete env.NODE_DEBUG;
	delete env.NODE_OPTIONS;
	return env;
}

/**
 * Invoke the CLI as a subprocess with a test-friendly environment.
 * Sets CAMUNDA_BASE_URL so commands resolve a cluster config without
 * needing a real profile or running cluster.
 * Forces JSON output mode via C8CTL_DATA_DIR so tests are deterministic.
 */
export async function c8(...args: string[]): Promise<SpawnResult> {
	return asyncSpawn("node", ["--experimental-strip-types", CLI, ...args], {
		env: buildChildEnv(),
	});
}

/**
 * Like `c8()`, but accepts a `timeout` (and any future options). Use this
 * for invocations that could hang under regression so the test fails fast
 * instead of stalling the suite (e.g. long-running verbs against the --help
 * gate).
 */
export async function c8WithOptions(
	opts: C8Options,
	...args: string[]
): Promise<SpawnResult> {
	return asyncSpawn("node", ["--experimental-strip-types", CLI, ...args], {
		env: buildChildEnv(),
		...(opts.timeout !== undefined ? { timeout: opts.timeout } : {}),
	});
}

/**
 * Parse the JSON dry-run payload from CLI stdout.
 * Throws a descriptive error if stdout is not valid JSON.
 */
export function parseJson(result: SpawnResult): Record<string, unknown> {
	try {
		return JSON.parse(result.stdout);
	} catch {
		throw new Error(
			`Failed to parse JSON from stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
		);
	}
}
