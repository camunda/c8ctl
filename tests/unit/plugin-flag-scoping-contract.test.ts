/**
 * Plugin flag scoping contract tests for #373.
 *
 * Pins the contract that a plugin verb's flag namespace is scoped to
 * `GLOBAL_FLAGS ∪ plugin.flags` — NOT the global union of every verb's
 * flags in the registry. Today's flat-namespace parser unions every
 * verb's flags via `deriveParseArgsOptions()` and uses that union as
 * the blacklist for plugin flags, which silently breaks plugins that
 * happen to declare a flag name shared with any built-in verb (e.g.
 * `--limit`, which lives in `SEARCH_FLAGS`).
 *
 * The motivating user story:
 *
 *   > A contributed plugin wants to use `--limit` but can't because it
 *   > is used by core (`search`).
 *
 * `--limit` is not in `GLOBAL_FLAGS`. Under per-verb scoping it must
 * reach the plugin handler when the user invokes the plugin verb. Under
 * the current flat parser, the plugin pre-parse blocks it and prints a
 * `Plugin flag --limit conflicts with a built-in flag and will not be
 * parsed` warning — exactly the wrong outcome.
 *
 * RED phase: tests assert the desired post-#373 behaviour and are
 * expected to FAIL against `main`. They become GREEN when the per-verb
 * flag scoping refactor lands.
 *
 * The fixture lives at
 * `tests/fixtures/plugins/plugin-with-verb-scoped-flag/`. It is installed
 * per-test into a temp `C8CTL_DATA_DIR` so other tests can't see it.
 */

import assert from "node:assert";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { GLOBAL_FLAGS } from "../../src/command-registry.ts";
import { isRecord } from "../../src/logger.ts";
import { asyncSpawn, type SpawnResult } from "../utils/spawn.ts";

const FIXTURE_DIR = join(
	process.cwd(),
	"tests",
	"fixtures",
	"plugins",
	"plugin-with-verb-scoped-flag",
);
const PLUGIN_PKG_NAME = "c8ctl-plugin-verb-scoped-flag";
const PLUGIN_VERB = "verb-scoped-demo";

let testDataDir: string;

beforeEach(() => {
	testDataDir = mkdtempSync(join(tmpdir(), "c8ctl-flag-scope-"));
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

/** Spawn the CLI with the per-test data dir + plugin install. */
async function c8Plugin(...args: string[]): Promise<SpawnResult> {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		CAMUNDA_BASE_URL: "http://test-cluster/v2",
		HOME: "/tmp/c8ctl-test-nonexistent-home",
		C8CTL_DATA_DIR: testDataDir,
	};
	// Mirror tests/utils/cli.ts: scrub debug env vars so host environment
	// can't add stderr noise that breaks our warning-shape assertions.
	delete env.DEBUG;
	delete env.C8CTL_DEBUG;
	delete env.NODE_DEBUG;
	delete env.NODE_OPTIONS;
	return asyncSpawn(
		"node",
		["--experimental-strip-types", "src/index.ts", ...args],
		{
			env,
			timeout: 10_000,
		},
	);
}

function parseJsonRecord(stdout: string): Record<string, unknown> {
	const trimmed = stdout.trim();
	// The CLI may emit multiple JSON objects (e.g. a warning followed by
	// the handler payload). Walk lines and return the LAST line that
	// parses as an object — the handler payload is always last.
	const lines = trimmed.split("\n").filter((l) => l.length > 0);
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i];
		if (line === undefined) continue;
		try {
			const parsed: unknown = JSON.parse(line);
			if (isRecord(parsed)) return parsed;
		} catch {
			// Not JSON; keep walking.
		}
	}
	throw new Error(`No JSON object found in stdout:\n${stdout}`);
}

// ─── A. Sanity: the fixture loads and dispatches at all ──────────────────────

describe("plugin flag scoping contract: fixture is loadable", () => {
	test("plugin verb is dispatched (sanity check)", async () => {
		// If this fails, the entire suite is meaningless — every other test
		// here depends on the fixture being installed and reachable.
		const result = await c8Plugin(PLUGIN_VERB);
		assert.strictEqual(
			result.status,
			0,
			`expected exit 0, got ${result.status}. stderr: ${result.stderr}`,
		);
		const parsed = parseJsonRecord(result.stdout);
		assert.ok(
			isRecord(parsed.flags),
			`expected handler payload with .flags, got: ${JSON.stringify(parsed)}`,
		);
	});
});

// ─── B. The motivating bug: --limit is verb-scoped, not global ───────────────

describe("plugin flag scoping contract: verb-scoped built-in flags do not block plugins", () => {
	test("--limit is not a global flag (precondition for the contract)", () => {
		// If --limit ever moves to GLOBAL_FLAGS the contract changes shape:
		// the plugin would then have to use a different name. Pin the
		// precondition so a future global-promotion is caught loudly.
		assert.ok(
			!Object.hasOwn(GLOBAL_FLAGS, "limit"),
			"--limit must remain a verb-scoped flag (currently in SEARCH_FLAGS) for #373's contract to apply.",
		);
	});

	test("plugin verb's --limit reaches the handler with the user-supplied value", async () => {
		// The motivating user story: a plugin declares its own --limit and
		// the user invokes the plugin verb with --limit=42. Today the
		// plugin pre-parse blocks --limit (because the flat union sees it
		// in SEARCH_FLAGS) and the handler is called with empty flags.
		// Under per-verb scoping, --limit is parsed against the plugin's
		// own flag table and the value reaches the handler.
		const result = await c8Plugin(PLUGIN_VERB, "--limit=42");
		assert.strictEqual(
			result.status,
			0,
			`expected exit 0, got ${result.status}. stderr: ${result.stderr}`,
		);
		const parsed = parseJsonRecord(result.stdout);
		assert.ok(
			isRecord(parsed.flags),
			`expected handler payload, got: ${JSON.stringify(parsed)}`,
		);
		assert.strictEqual(
			parsed.flags.limit,
			"42",
			`expected flags.limit === "42" to reach plugin handler, got: ${JSON.stringify(parsed.flags)}`,
		);
	});

	test("no warning is printed about --limit conflicting with a built-in", async () => {
		// Today the plugin pre-parse prints `Plugin flag --limit conflicts
		// with a built-in flag and will not be parsed`. Under the scoped
		// model that warning is wrong — there is no conflict in the
		// plugin's namespace — and must not appear.
		const result = await c8Plugin(PLUGIN_VERB, "--limit=42");
		const combined = `${result.stdout}\n${result.stderr}`;
		assert.ok(
			!combined.includes("--limit conflicts with a built-in flag"),
			`expected no built-in-conflict warning for plugin's --limit. got:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
		);
	});

	test("class-scoped: every verb-scoped flag the plugin declares reaches the handler", async () => {
		// Class-scoped guard against the same defect recurring on a sibling
		// flag. The fixture declares both --limit AND --between (also in
		// SEARCH_FLAGS). Today both are blocked; under per-verb scoping
		// both must round-trip.
		const result = await c8Plugin(
			PLUGIN_VERB,
			"--limit=7",
			"--between=2024-01-01..2024-12-31",
		);
		assert.strictEqual(
			result.status,
			0,
			`expected exit 0, got ${result.status}. stderr: ${result.stderr}`,
		);
		const parsed = parseJsonRecord(result.stdout);
		assert.ok(
			isRecord(parsed.flags),
			`expected handler payload, got: ${JSON.stringify(parsed)}`,
		);
		assert.deepStrictEqual(
			{ limit: parsed.flags.limit, between: parsed.flags.between },
			{ limit: "7", between: "2024-01-01..2024-12-31" },
			`expected both verb-scoped flags to reach the handler. got: ${JSON.stringify(parsed.flags)}`,
		);
	});
});

// ─── C. Globals still belong to the host, not the plugin ─────────────────────

describe("plugin flag scoping contract: GLOBAL_FLAGS remain host-owned", () => {
	test("--profile (a global) is consumed by the host even on a plugin verb", async () => {
		// The mirror of the contract above: a global flag is owned by the
		// host's stage-1 parse; the plugin must NOT see it in flags. This
		// already works today (the host always strips globals before
		// invoking the plugin) and the contract pins it so the per-verb
		// scoping refactor cannot accidentally hand globals to plugins.
		const result = await c8Plugin(
			"--profile=__nonexistent__",
			PLUGIN_VERB,
			"--limit=1",
		);
		assert.strictEqual(
			result.status,
			0,
			`expected exit 0, got ${result.status}. stderr: ${result.stderr}`,
		);
		const parsed = parseJsonRecord(result.stdout);
		assert.ok(
			isRecord(parsed.flags),
			`expected handler payload, got: ${JSON.stringify(parsed)}`,
		);
		assert.ok(
			!("profile" in parsed.flags),
			`expected --profile to be consumed by the host, not visible to the plugin. got flags: ${JSON.stringify(parsed.flags)}`,
		);
	});
});

// ─── D. Boolean-vs-string global collision must not shift positionals ────────

describe("plugin flag scoping contract: global-string collision keeps plugin positionals intact", () => {
	// Class-scoped guard for the edge case Copilot raised on PR #376:
	// when a plugin declares a flag whose name collides with a GLOBAL
	// string flag (e.g. --profile) but types it as `boolean`, the host
	// must still consume the global's value token from argv. Otherwise
	// the leftover value drifts into the plugin's positional args.
	//
	// Today the plugin pre-parse blocks the colliding name and the
	// downstream `stripBlockedFlagTokens` decides whether to also strip
	// the following token by consulting the *plugin's* declared type.
	// Boolean → don't strip → value leaks into positionals. The fix is
	// to consult the GLOBAL type (string) for blocked-because-global
	// flags, or to let parseArgs consume the token via the merged
	// options table directly (mergedOptions still carries the global's
	// type for that name).
	test("plugin's positional args are not shifted by a global-string flag's value", async () => {
		const result = await c8Plugin(
			"boolean-profile-collision",
			"--profile",
			"some-profile-value",
			"pos1",
		);
		assert.strictEqual(
			result.status,
			0,
			`expected exit 0, got ${result.status}. stderr: ${result.stderr}`,
		);
		const parsed = parseJsonRecord(result.stdout);
		assert.ok(
			Array.isArray(parsed.args),
			`expected handler payload with .args, got: ${JSON.stringify(parsed)}`,
		);
		assert.deepStrictEqual(
			parsed.args,
			["pos1"],
			`expected positional args to be ["pos1"]. The global --profile's value ("some-profile-value") must be consumed by the host, not leak into plugin positionals. got: ${JSON.stringify(parsed.args)}`,
		);
		assert.ok(
			isRecord(parsed.flags) && !("profile" in parsed.flags),
			`expected plugin flags to NOT include profile (it's a global). got: ${JSON.stringify(parsed.flags)}`,
		);
	});
});
