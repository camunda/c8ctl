/**
 * Unit tests for CLI self-update notification (update-check module)
 */

import assert from "node:assert";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { c8ctl } from "../../src/core/runtime.ts";
import {
	_resetForTesting,
	_setSpawnerForTesting,
	CHECK_INTERVAL_MS,
	detectChannel,
	isNewer,
	printUpdateNotification,
	runUpdateCheck,
	startUpdateCheck,
} from "../../src/core/update-check.ts";

// ── Pure function tests ─────────────────────────────────────────────────────

describe("detectChannel", () => {
	test('stable version returns "latest"', () => {
		assert.strictEqual(detectChannel("1.2.3"), "latest");
	});

	test('alpha prerelease returns "alpha"', () => {
		assert.strictEqual(detectChannel("1.2.3-alpha.5"), "alpha");
	});

	test('other prerelease returns "latest"', () => {
		assert.strictEqual(detectChannel("1.2.3-beta.1"), "latest");
	});

	test('version containing alpha outside prerelease returns "latest"', () => {
		// Edge case: "alpha" appears in the string but not as a prerelease tag
		assert.strictEqual(detectChannel("1.0.0-alphabeta.1"), "latest");
	});
});

describe("isNewer", () => {
	test("higher major is newer", () => {
		assert.ok(isNewer("1.0.0", "2.0.0"));
	});

	test("same major, higher minor is newer", () => {
		assert.ok(isNewer("1.0.0", "1.1.0"));
	});

	test("same minor, higher patch is newer", () => {
		assert.ok(isNewer("1.0.0", "1.0.1"));
	});

	test("same version is not newer", () => {
		assert.ok(!isNewer("1.0.0", "1.0.0"));
	});

	test("lower version is not newer", () => {
		assert.ok(!isNewer("2.0.0", "1.0.0"));
	});

	test("higher alpha prerelease number is newer", () => {
		assert.ok(isNewer("1.0.0-alpha.5", "1.0.0-alpha.6"));
	});

	test("same alpha prerelease number is not newer", () => {
		assert.ok(!isNewer("1.0.0-alpha.5", "1.0.0-alpha.5"));
	});

	test("lower alpha prerelease number is not newer", () => {
		assert.ok(!isNewer("1.0.0-alpha.6", "1.0.0-alpha.5"));
	});

	test("stable release is newer than same-version alpha", () => {
		assert.ok(isNewer("1.0.0-alpha.5", "1.0.0"));
	});

	test("alpha is not newer than same-version stable", () => {
		assert.ok(!isNewer("1.0.0", "1.0.0-alpha.5"));
	});

	test("higher major alpha is newer than lower stable", () => {
		assert.ok(isNewer("1.0.0", "2.0.0-alpha.1"));
	});
});

// ── Stateful tests: CLI side (cache only) and worker side (registry) ────────

let tempDir: string;
let consoleLogOutput: string[];
let spawned: number;
let fetchCalls: number;
let registry: () => Promise<Response>;
let originalLog: typeof console.log;
let originalFetch: typeof globalThis.fetch;
let originalOutputMode: typeof c8ctl.outputMode;
let originalCI: string | undefined;
let originalDataDir: string | undefined;

const distTags = (tags: Record<string, string>) => async () =>
	new Response(JSON.stringify({ "dist-tags": tags }), { status: 200 });

const checkFile = () => join(tempDir, "update-check.json");
const notificationFile = () => join(tempDir, "last-update-notification.json");
const readCheck = () => JSON.parse(readFileSync(checkFile(), "utf-8"));
const writeCheck = (state: unknown) =>
	writeFileSync(checkFile(), JSON.stringify(state));
const output = () => consoleLogOutput.join("\n");

/** One CLI invocation: start the check, run the "command", print. */
function invoke(version: string): void {
	_resetForTesting();
	_setSpawnerForTesting(() => spawned++);
	startUpdateCheck(version);
	printUpdateNotification();
}

/** What the detached worker does, run in-process. */
const worker = runUpdateCheck;

beforeEach(() => {
	consoleLogOutput = [];
	spawned = 0;
	fetchCalls = 0;
	registry = distTags({ latest: "2.0.0" });
	originalFetch = globalThis.fetch;
	globalThis.fetch = async () => {
		fetchCalls++;
		return registry();
	};
	originalLog = console.log;
	console.log = (...args: unknown[]) => {
		consoleLogOutput.push(args.join(" "));
	};
	originalOutputMode = c8ctl.outputMode;
	originalCI = process.env.CI;
	originalDataDir = process.env.C8CTL_DATA_DIR;
	tempDir = mkdtempSync(join(tmpdir(), "c8ctl-update-test-"));
	process.env.C8CTL_DATA_DIR = tempDir;
	delete process.env.CI;
	c8ctl.outputMode = "text";
});

afterEach(() => {
	console.log = originalLog;
	globalThis.fetch = originalFetch;
	c8ctl.outputMode = originalOutputMode;
	if (originalCI !== undefined) process.env.CI = originalCI;
	else delete process.env.CI;
	if (originalDataDir !== undefined)
		process.env.C8CTL_DATA_DIR = originalDataDir;
	else delete process.env.C8CTL_DATA_DIR;
	rmSync(tempDir, { recursive: true, force: true });
	_resetForTesting();
});

describe("startUpdateCheck (CLI side)", () => {
	test("never contacts the registry itself", () => {
		invoke("1.0.0");
		writeCheck({ checkedAt: 0, versions: { latest: "2.0.0" } });
		invoke("1.0.0");
		assert.strictEqual(fetchCalls, 0);
	});

	test("spawns the worker when there is no previous check", () => {
		invoke("1.0.0");
		assert.strictEqual(spawned, 1);
	});

	test("does not spawn when the last check is recent", () => {
		writeCheck({ checkedAt: Date.now(), versions: {} });
		invoke("1.0.0");
		assert.strictEqual(spawned, 0);
	});

	test("spawns again once the check interval has passed", () => {
		writeCheck({ checkedAt: Date.now() - CHECK_INTERVAL_MS, versions: {} });
		invoke("1.0.0");
		assert.strictEqual(spawned, 1);
	});

	test("ignores a corrupt check file", () => {
		writeFileSync(checkFile(), "not json");
		invoke("1.0.0");
		assert.strictEqual(spawned, 1);
		assert.ok(!output().includes("newer version"));
	});
});

describe("printUpdateNotification (from cached check)", () => {
	const fresh = (versions: Record<string, string>) =>
		writeCheck({ checkedAt: Date.now(), versions });

	test("notifies when a newer stable version is cached", () => {
		fresh({ latest: "2.0.0", alpha: "3.0.0-alpha.1" });
		invoke("1.0.0");
		assert.ok(output().includes("newer version"), output());
		assert.ok(output().includes("1.0.0"), "Should mention current version");
		assert.ok(output().includes("2.0.0"), "Should mention remote version");
		assert.ok(output().includes("npm install -g @camunda8/cli"));
	});

	test("alpha builds compare against the alpha dist-tag", () => {
		fresh({ latest: "1.0.0", alpha: "2.0.0-alpha.10" });
		invoke("2.0.0-alpha.5");
		assert.ok(output().includes("2.0.0-alpha.5"));
		assert.ok(output().includes("2.0.0-alpha.10"));
		assert.ok(output().includes("@camunda8/cli@alpha"));
		assert.ok(
			!/npm install -g @camunda8\/cli(?!@)/.test(output()),
			"Should not recommend stable install for alpha user",
		);
	});

	test("does not notify when already on latest", () => {
		fresh({ latest: "1.0.0" });
		invoke("1.0.0");
		assert.ok(!output().includes("newer version"), output());
	});

	test("does not notify for the same version twice", () => {
		fresh({ latest: "2.0.0" });
		invoke("1.0.0");
		assert.ok(output().includes("newer version"));
		consoleLogOutput = [];
		invoke("1.0.0");
		assert.ok(!output().includes("newer version"), output());
	});

	test("notifies again when a newer version is cached", () => {
		fresh({ latest: "2.0.0" });
		invoke("1.0.0");
		consoleLogOutput = [];
		fresh({ latest: "3.0.0" });
		invoke("1.0.0");
		assert.ok(output().includes("3.0.0"), output());
	});

	test("records the notified version", () => {
		fresh({ latest: "2.0.0" });
		invoke("1.0.0");
		const cache = JSON.parse(readFileSync(notificationFile(), "utf-8"));
		assert.strictEqual(cache.notifiedVersion, "2.0.0");
	});

	test("suppressed in JSON output mode, without consuming the notice", () => {
		fresh({ latest: "2.0.0" });
		c8ctl.outputMode = "json";
		invoke("1.0.0");
		assert.ok(!output().includes("newer version"));
		assert.ok(!existsSync(notificationFile()));
	});

	test("suppressed in CI: no notice, no worker", () => {
		process.env.CI = "true";
		fresh({ latest: "2.0.0" });
		invoke("1.0.0");
		assert.ok(!output().includes("newer version"));
		assert.strictEqual(spawned, 0);
	});

	test("suppressed for the development placeholder version", () => {
		fresh({ latest: "2.0.0" });
		invoke("0.0.0-semantically-released");
		assert.ok(!output().includes("newer version"));
		assert.strictEqual(spawned, 0);
	});
});

describe("runUpdateCheck (worker side)", () => {
	test("records every dist-tag from one response", async () => {
		registry = distTags({ latest: "2.0.0", alpha: "3.0.0-alpha.1" });
		await worker();
		assert.deepStrictEqual(readCheck().versions, {
			latest: "2.0.0",
			alpha: "3.0.0-alpha.1",
		});
		assert.ok(Date.now() - readCheck().checkedAt < 5000);
	});

	test("replaces, not merges, the cached versions", async () => {
		// Concurrent workers then can't lose each other's results: each one
		// writes a complete, equally fresh set.
		writeCheck({ checkedAt: 0, versions: { latest: "1.0.0", beta: "0.1.0" } });
		registry = distTags({ latest: "2.0.0", alpha: "3.0.0-alpha.1" });
		await worker();
		assert.deepStrictEqual(readCheck().versions, {
			latest: "2.0.0",
			alpha: "3.0.0-alpha.1",
		});
	});

	const failures: Record<string, () => Promise<Response>> = {
		"network error": async () => {
			throw new Error("Network error");
		},
		"non-200 response": async () => new Response("Not Found", { status: 404 }),
		"malformed JSON": async () => new Response("not json", { status: 200 }),
		"missing dist-tags": async () =>
			new Response(JSON.stringify({}), { status: 200 }),
	};
	for (const [name, failing] of Object.entries(failures)) {
		test(`${name}: records the attempt, keeps the last known version`, async () => {
			writeCheck({ checkedAt: 0, versions: { latest: "2.0.0" } });
			registry = failing;
			await worker();
			assert.deepStrictEqual(readCheck().versions, { latest: "2.0.0" });
			assert.ok(readCheck().checkedAt > 0, "attempt throttles respawns");
		});
	}
});

describe("CLI and worker together", () => {
	test("a version found by the worker is announced on the next run", async () => {
		invoke("1.0.0");
		assert.ok(!output().includes("newer version"), "nothing cached yet");
		assert.strictEqual(spawned, 1);

		await worker();

		invoke("1.0.0");
		assert.ok(output().includes("2.0.0"), output());
		assert.strictEqual(spawned, 1, "fresh check: no respawn");
	});

	test("a check from a stable build also serves alpha builds", async () => {
		registry = distTags({ latest: "2.0.0", alpha: "3.0.0-alpha.2" });
		invoke("1.0.0");
		await worker();

		invoke("3.0.0-alpha.1");
		assert.ok(output().includes("3.0.0-alpha.2"), output());
		assert.strictEqual(spawned, 1, "fresh check: no respawn");
	});
});
