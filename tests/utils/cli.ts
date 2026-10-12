/**
 * Shared test utilities for CLI behavioural (dry-run) tests.
 *
 * Provides a subprocess helper that invokes the CLI with a deterministic
 * environment and a JSON parser for dry-run output.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { asyncSpawn, asyncSpawnWithStdin, type SpawnResult } from "./spawn.ts";

const CLI = resolve(import.meta.dirname, "../../src/index.ts");

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
 * Options recognised by the test `c8WithOptions()` helper.
 *
 * `timeout` is forwarded to `asyncSpawn` and ultimately to Node's `execFile`,
 * which SIGTERMs the child after the deadline. It defaults to
 * {@link DEFAULT_CLI_TIMEOUT} so a regression cannot stall the suite.
 * `stdin` is written to the child and then closed. `nodeArgs` go to `node`
 * before the CLI path (e.g. `--import <preload>`), which avoids quoting paths
 * into `NODE_OPTIONS`. `env` is merged over the deterministic test env; an
 * `undefined` value removes the variable. `cwd` sets the working directory.
 */
export interface C8Options {
	timeout?: number;
	stdin?: string;
	nodeArgs?: string[];
	env?: Record<string, string | undefined>;
	cwd?: string;
}

export const DEFAULT_CLI_TIMEOUT = 60_000;

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
export function c8(...args: string[]): Promise<SpawnResult> {
	return c8WithOptions({}, ...args);
}

/**
 * Like `c8()`, but merges `extraEnv` over the deterministic test env.
 * Use this to point the CLI at a local stub server (override
 * `CAMUNDA_BASE_URL`) so error paths that need a real HTTP response —
 * e.g. an HTTP 413 from the cluster ingress — can be exercised without a
 * live cluster.
 */
export function c8WithEnv(
	extraEnv: Record<string, string>,
	...args: string[]
): Promise<SpawnResult> {
	return c8WithOptions({ env: extraEnv }, ...args);
}

/**
 * Like `c8()`, but accepts {@link C8Options}: a timeout (default
 * {@link DEFAULT_CLI_TIMEOUT}), stdin, extra node args, extra env and a cwd.
 */
export async function c8WithOptions(
	opts: C8Options,
	...args: string[]
): Promise<SpawnResult> {
	const env: NodeJS.ProcessEnv = { ...buildChildEnv(), ...opts.env };
	for (const [key, value] of Object.entries(opts.env ?? {})) {
		if (value === undefined) delete env[key];
	}
	const argv = [
		"--experimental-strip-types",
		...(opts.nodeArgs ?? []),
		CLI,
		...args,
	];
	const options = {
		env,
		timeout: opts.timeout ?? DEFAULT_CLI_TIMEOUT,
		...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
	};
	const { stdin } = opts;
	return stdin === undefined
		? asyncSpawn("node", argv, options)
		: asyncSpawnWithStdin(
				"node",
				argv,
				(stream) => {
					stream.write(stdin);
				},
				options,
			);
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
