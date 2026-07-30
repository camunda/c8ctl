/**
 * Contract: plugins can run npm through the c8ctl runtime.
 *
 * `npm()` (src/utils/shared/npm-exec.ts) is the only sanctioned way to
 * invoke npm from this codebase — on Windows a bare `npm` spawn is ENOENT
 * and `npm.cmd` alone is EINVAL under the CVE-2024-27980 hardening, so the
 * helper routes through cmd.exe with per-argument quoting. Plugins install
 * and query packages too, and without an exposed runner they can only
 * hand-roll a spawn that breaks on Windows.
 *
 * These tests drive a fixture plugin through the real CLI, so they pin the
 * whole path: `c8ctl.init()` runs before plugin code, `globalThis.c8ctl`
 * carries the runner, and it actually executes npm.
 */

import assert from "node:assert";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { isRecord } from "../../src/core/logger.ts";
import { asyncSpawn, type SpawnResult } from "../utils/spawn.ts";

const FIXTURE_DIR = join(
	process.cwd(),
	"tests",
	"fixtures",
	"plugins",
	"plugin-with-npm",
);
const PLUGIN_PKG_NAME = "c8ctl-plugin-npm-runtime";

let testDataDir: string;

beforeEach(() => {
	testDataDir = mkdtempSync(join(tmpdir(), "c8ctl-plugin-npm-"));
	writeFileSync(
		join(testDataDir, "session.json"),
		JSON.stringify({ outputMode: "json" }),
	);
	const installDir = join(
		testDataDir,
		"plugins",
		"node_modules",
		PLUGIN_PKG_NAME,
	);
	mkdirSync(installDir, { recursive: true });
	cpSync(FIXTURE_DIR, installDir, { recursive: true });
});

afterEach(() => {
	rmSync(testDataDir, { recursive: true, force: true });
});

async function c8Plugin(...args: string[]): Promise<SpawnResult> {
	// HOME/USERPROFILE are redirected into the per-test temp dir rather than
	// pointed at a nonexistent path (as sibling plugin tests do): npm resolves
	// ~/.npmrc from the home directory, so this isolates the spawned npm from
	// the developer's real npm config without handing it a broken HOME.
	// USERPROFILE matters on Windows, where os.homedir() reads it (#488).
	const env: NodeJS.ProcessEnv = {
		...process.env,
		CAMUNDA_BASE_URL: "http://test-cluster/v2",
		C8CTL_DATA_DIR: testDataDir,
		HOME: testDataDir,
		USERPROFILE: testDataDir,
	};
	delete env.DEBUG;
	delete env.C8CTL_DEBUG;
	delete env.NODE_DEBUG;
	delete env.NODE_OPTIONS;
	return asyncSpawn(
		"node",
		["--experimental-strip-types", "src/index.ts", ...args],
		// Generous: spawning npm on a loaded CI runner is slow. This is a
		// safety net, not a correctness assertion — do not tighten it into
		// a race.
		{ env, timeout: 60_000 },
	);
}

/** Walk stdout from the end for the last line that parses to a record. */
function lastJsonRecord(stdout: string): Record<string, unknown> {
	const lines = stdout
		.trim()
		.split("\n")
		.filter((l) => l.length > 0);
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i];
		if (line === undefined) continue;
		try {
			const parsed: unknown = JSON.parse(line);
			if (isRecord(parsed)) return parsed;
		} catch {
			// keep walking
		}
	}
	throw new Error(`No JSON object found in stdout:\n${stdout}`);
}

describe("plugin runtime: c8ctl.npm()", () => {
	test("is exposed on globalThis.c8ctl by the time plugin code runs", async () => {
		const result = await c8Plugin("npm-shape");
		assert.strictEqual(
			result.status,
			0,
			`expected exit 0, got ${result.status}. stderr: ${result.stderr}`,
		);
		assert.strictEqual(lastJsonRecord(result.stdout).npmType, "function");
	});

	test("runs npm and captures its stdout", async () => {
		const result = await c8Plugin("npm-version");
		assert.strictEqual(
			result.status,
			0,
			`expected exit 0, got ${result.status}. stderr: ${result.stderr}`,
		);
		const version = lastJsonRecord(result.stdout).version;
		assert.ok(
			typeof version === "string" && /^\d+\.\d+\.\d+/.test(version),
			`expected a semver from 'npm --version', got: ${JSON.stringify(version)}`,
		);
	});
});
