/**
 * Unit tests for CLI self-update notification (update-check module)
 */

import assert from "node:assert";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { c8ctl } from "../../src/runtime.ts";
import {
	_resetForTesting,
	detectChannel,
	isNewer,
	printUpdateNotification,
	startUpdateCheck,
} from "../../src/update-check.ts";

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

// ── Integration tests with mocked fetch ─────────────────────────────────────

describe("startUpdateCheck + printUpdateNotification", () => {
	let consoleLogOutput: string[];
	let originalLog: typeof console.log;
	let originalFetch: typeof globalThis.fetch;
	let originalOutputMode: typeof c8ctl.outputMode;
	let originalCI: string | undefined;
	let originalDataDir: string | undefined;
	let tempDir: string;

	beforeEach(() => {
		_resetForTesting();

		// Capture console.log
		consoleLogOutput = [];
		originalLog = console.log;
		console.log = (...args: unknown[]) => {
			consoleLogOutput.push(args.join(" "));
		};

		// Save originals
		originalFetch = globalThis.fetch;
		originalOutputMode = c8ctl.outputMode;
		originalCI = process.env.CI;
		originalDataDir = process.env.C8CTL_DATA_DIR;

		// Set up temp cache dir to avoid polluting the real one
		tempDir = join(
			tmpdir(),
			`c8ctl-update-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(tempDir, { recursive: true });
		process.env.C8CTL_DATA_DIR = tempDir;

		// Clear CI flag
		delete process.env.CI;

		c8ctl.outputMode = "text";
	});

	afterEach(() => {
		console.log = originalLog;
		globalThis.fetch = originalFetch;
		c8ctl.outputMode = originalOutputMode;

		if (originalCI !== undefined) {
			process.env.CI = originalCI;
		} else {
			delete process.env.CI;
		}

		if (originalDataDir !== undefined) {
			process.env.C8CTL_DATA_DIR = originalDataDir;
		} else {
			delete process.env.C8CTL_DATA_DIR;
		}

		// Clean up temp dir
		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch {
			/* best effort */
		}

		_resetForTesting();
	});

	test("notifies when a newer stable version is available", async () => {
		globalThis.fetch = async () =>
			new Response(
				JSON.stringify({
					"dist-tags": { latest: "2.0.0", alpha: "3.0.0-alpha.1" },
				}),
				{ status: 200 },
			);

		startUpdateCheck("1.0.0");
		await printUpdateNotification();

		const output = consoleLogOutput.join("\n");
		assert.ok(
			output.includes("newer version"),
			`Expected update notice, got: ${output}`,
		);
		assert.ok(output.includes("1.0.0"), "Should mention current version");
		assert.ok(output.includes("2.0.0"), "Should mention remote version");
		assert.ok(
			output.includes("npm install -g @camunda8/cli"),
			"Should show install command",
		);
	});

	test("notifies when a newer alpha version is available", async () => {
		globalThis.fetch = async () =>
			new Response(
				JSON.stringify({
					"dist-tags": { latest: "1.0.0", alpha: "2.0.0-alpha.10" },
				}),
				{ status: 200 },
			);

		startUpdateCheck("2.0.0-alpha.5");
		await printUpdateNotification();

		const output = consoleLogOutput.join("\n");
		assert.ok(
			output.includes("newer version"),
			`Expected update notice, got: ${output}`,
		);
		assert.ok(
			output.includes("2.0.0-alpha.5"),
			"Should mention current version",
		);
		assert.ok(
			output.includes("2.0.0-alpha.10"),
			"Should mention remote version",
		);
		assert.ok(
			output.includes("@camunda8/cli@alpha"),
			"Should show alpha install command",
		);
	});

	test("does not notify when already on latest", async () => {
		globalThis.fetch = async () =>
			new Response(
				JSON.stringify({
					"dist-tags": { latest: "1.0.0" },
				}),
				{ status: 200 },
			);

		startUpdateCheck("1.0.0");
		await printUpdateNotification();

		const output = consoleLogOutput.join("\n");
		assert.ok(
			!output.includes("newer version"),
			`Should not notify, got: ${output}`,
		);
	});

	test("does not notify for the same version twice (once-per-version cache)", async () => {
		globalThis.fetch = async () =>
			new Response(
				JSON.stringify({
					"dist-tags": { latest: "2.0.0" },
				}),
				{ status: 200 },
			);

		// First run — should notify
		startUpdateCheck("1.0.0");
		await printUpdateNotification();
		assert.ok(
			consoleLogOutput.join("\n").includes("newer version"),
			"First run should notify",
		);

		// Reset state for second run
		consoleLogOutput = [];
		_resetForTesting();

		// Second run — cache should suppress
		startUpdateCheck("1.0.0");
		await printUpdateNotification();
		assert.ok(
			!consoleLogOutput.join("\n").includes("newer version"),
			"Second run should be suppressed by cache",
		);
	});

	test("notifies again when a new version is published (cache invalidation)", async () => {
		// First: notify about 2.0.0
		globalThis.fetch = async () =>
			new Response(
				JSON.stringify({
					"dist-tags": { latest: "2.0.0" },
				}),
				{ status: 200 },
			);

		startUpdateCheck("1.0.0");
		await printUpdateNotification();
		assert.ok(
			consoleLogOutput.join("\n").includes("2.0.0"),
			"Should notify about 2.0.0",
		);

		// Reset for next run
		consoleLogOutput = [];
		_resetForTesting();

		// Second: new version 3.0.0 published — should notify again
		globalThis.fetch = async () =>
			new Response(
				JSON.stringify({
					"dist-tags": { latest: "3.0.0" },
				}),
				{ status: 200 },
			);

		startUpdateCheck("1.0.0");
		// Give the microtask queue time to process the instantly-resolving fetch
		await new Promise((resolve) => setTimeout(resolve, 10));
		await printUpdateNotification();
		assert.ok(
			consoleLogOutput.join("\n").includes("3.0.0"),
			"Should notify about 3.0.0",
		);
	});

	test("suppressed in CI environment", async () => {
		process.env.CI = "true";

		globalThis.fetch = async () =>
			new Response(
				JSON.stringify({
					"dist-tags": { latest: "2.0.0" },
				}),
				{ status: 200 },
			);

		startUpdateCheck("1.0.0");
		await printUpdateNotification();

		const output = consoleLogOutput.join("\n");
		assert.ok(!output.includes("newer version"), "Should not notify in CI");
	});

	test("suppressed in JSON output mode", async () => {
		c8ctl.outputMode = "json";

		globalThis.fetch = async () =>
			new Response(
				JSON.stringify({
					"dist-tags": { latest: "2.0.0" },
				}),
				{ status: 200 },
			);

		startUpdateCheck("1.0.0");
		await printUpdateNotification();

		const output = consoleLogOutput.join("\n");
		assert.ok(
			!output.includes("newer version"),
			"Should not notify in JSON mode",
		);
	});

	test("suppressed for development placeholder version", async () => {
		globalThis.fetch = async () => {
			assert.fail("Should not fetch for placeholder version");
			return new Response("", { status: 500 });
		};

		startUpdateCheck("0.0.0-semantically-released");
		await printUpdateNotification();

		const output = consoleLogOutput.join("\n");
		assert.ok(
			!output.includes("newer version"),
			"Should not notify for placeholder",
		);
	});

	test("silently handles fetch failure (offline)", async () => {
		globalThis.fetch = async () => {
			throw new Error("Network error");
		};

		startUpdateCheck("1.0.0");
		// Should not throw
		await printUpdateNotification();

		const output = consoleLogOutput.join("\n");
		assert.ok(
			!output.includes("newer version"),
			"Should not notify on fetch failure",
		);
	});

	test("silently handles non-200 response", async () => {
		globalThis.fetch = async () => new Response("Not Found", { status: 404 });

		startUpdateCheck("1.0.0");
		await printUpdateNotification();

		const output = consoleLogOutput.join("\n");
		assert.ok(!output.includes("newer version"), "Should not notify on 404");
	});

	test("silently handles malformed JSON response", async () => {
		globalThis.fetch = async () => new Response("not json", { status: 200 });

		startUpdateCheck("1.0.0");
		await printUpdateNotification();

		const output = consoleLogOutput.join("\n");
		assert.ok(
			!output.includes("newer version"),
			"Should not notify on malformed response",
		);
	});

	test("silently handles missing dist-tags in response", async () => {
		globalThis.fetch = async () =>
			new Response(JSON.stringify({}), { status: 200 });

		startUpdateCheck("1.0.0");
		await printUpdateNotification();

		const output = consoleLogOutput.join("\n");
		assert.ok(
			!output.includes("newer version"),
			"Should not notify with missing dist-tags",
		);
	});

	test("cache file is written with the notified version", async () => {
		globalThis.fetch = async () =>
			new Response(
				JSON.stringify({
					"dist-tags": { latest: "2.0.0" },
				}),
				{ status: 200 },
			);

		startUpdateCheck("1.0.0");
		await printUpdateNotification();

		const cachePath = join(tempDir, "last-update-notification.json");
		assert.ok(existsSync(cachePath), "Cache file should be created");

		const cache = JSON.parse(readFileSync(cachePath, "utf-8"));
		assert.strictEqual(cache.notifiedVersion, "2.0.0");
	});

	test("alpha channel user checks alpha dist-tag, not latest", async () => {
		globalThis.fetch = async () => {
			return new Response(
				JSON.stringify({
					"dist-tags": { latest: "1.0.0", alpha: "2.0.0-alpha.10" },
				}),
				{ status: 200 },
			);
		};

		startUpdateCheck("2.0.0-alpha.5");
		await printUpdateNotification();

		const output = consoleLogOutput.join("\n");
		// Should check the alpha tag and find 2.0.0-alpha.10
		assert.ok(output.includes("2.0.0-alpha.10"), "Should find alpha update");
		// Should NOT recommend stable install (without @alpha suffix)
		assert.ok(
			output.includes("@camunda8/cli@alpha"),
			"Should show alpha install command",
		);
		// Should NOT recommend stable install (without @alpha suffix).
		// Use regex with word boundary to distinguish @camunda8/cli from @camunda8/cli@alpha.
		assert.ok(
			!/npm install -g @camunda8\/cli(?!@)/.test(output),
			"Should not recommend stable install for alpha user",
		);
	});
});

// ── Patient / impatient timing tests ────────────────────────────────────────

describe("patient vs impatient check timing", () => {
	let consoleLogOutput: string[];
	let originalLog: typeof console.log;
	let originalFetch: typeof globalThis.fetch;
	let originalOutputMode: typeof c8ctl.outputMode;
	let originalCI: string | undefined;
	let originalDataDir: string | undefined;
	let tempDir: string;

	beforeEach(() => {
		_resetForTesting();
		consoleLogOutput = [];
		originalLog = console.log;
		console.log = (...args: unknown[]) => {
			consoleLogOutput.push(args.join(" "));
		};
		originalFetch = globalThis.fetch;
		originalOutputMode = c8ctl.outputMode;
		originalCI = process.env.CI;
		originalDataDir = process.env.C8CTL_DATA_DIR;
		tempDir = join(
			tmpdir(),
			`c8ctl-patience-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(tempDir, { recursive: true });
		process.env.C8CTL_DATA_DIR = tempDir;
		delete process.env.CI;
		c8ctl.outputMode = "text";
	});

	afterEach(() => {
		console.log = originalLog;
		globalThis.fetch = originalFetch;
		c8ctl.outputMode = originalOutputMode;
		if (originalCI !== undefined) {
			process.env.CI = originalCI;
		} else {
			delete process.env.CI;
		}
		if (originalDataDir !== undefined) {
			process.env.C8CTL_DATA_DIR = originalDataDir;
		} else {
			delete process.env.C8CTL_DATA_DIR;
		}
		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch {
			/* best effort */
		}
		_resetForTesting();
	});

	test("first invocation is patient (no previous check)", async () => {
		// Use an instantly-resolving fetch — even a patient check should work
		globalThis.fetch = async () =>
			new Response(
				JSON.stringify({
					"dist-tags": { latest: "2.0.0" },
				}),
				{ status: 200 },
			);

		startUpdateCheck("1.0.0");
		await printUpdateNotification();

		const output = consoleLogOutput.join("\n");
		assert.ok(
			output.includes("newer version"),
			"First invocation should be patient and notify",
		);

		// Should have persisted the patient check timestamp
		const cachePath = join(tempDir, "last-update-notification.json");
		const cache = JSON.parse(readFileSync(cachePath, "utf-8"));
		assert.ok(cache.lastPatientCheck, "Should record patient check timestamp");
		assert.ok(
			typeof cache.lastPatientCheck === "number",
			"Timestamp should be a number",
		);
	});

	test("impatient check aborts pending fetch without delay", async () => {
		// Write a recent patient check timestamp to force impatient mode
		const cachePath = join(tempDir, "last-update-notification.json");
		writeFileSync(
			cachePath,
			JSON.stringify({ lastPatientCheck: Date.now() }),
			"utf-8",
		);

		// Use a slow fetch that never resolves quickly
		let fetchAborted = false;
		globalThis.fetch = async (
			_input: string | URL | Request,
			init?: RequestInit,
		) => {
			return new Promise((resolve, reject) => {
				// If aborted before resolving, record it
				init?.signal?.addEventListener("abort", () => {
					fetchAborted = true;
					reject(new DOMException("Aborted", "AbortError"));
				});
				// Never resolve naturally — simulates slow/offline network
			});
		};

		startUpdateCheck("1.0.0");
		await printUpdateNotification();

		// Should have aborted the fetch, not waited for PATIENT_TIMEOUT_MS
		assert.ok(fetchAborted, "Fetch should have been aborted");

		const output = consoleLogOutput.join("\n");
		assert.ok(
			!output.includes("newer version"),
			"Should not show notification when aborted",
		);
	});

	test("patient check after 24h waits for slow fetch", async () => {
		// Write an old patient check timestamp (>24h ago) to trigger patient mode
		const cachePath = join(tempDir, "last-update-notification.json");
		const oneDayAgo = Date.now() - 25 * 60 * 60 * 1000;
		writeFileSync(
			cachePath,
			JSON.stringify({ lastPatientCheck: oneDayAgo }),
			"utf-8",
		);

		// Use a fetch that resolves after a short delay (simulates slow network)
		globalThis.fetch = async () => {
			await new Promise((resolve) => setTimeout(resolve, 50));
			return new Response(
				JSON.stringify({
					"dist-tags": { latest: "2.0.0" },
				}),
				{ status: 200 },
			);
		};

		startUpdateCheck("1.0.0");
		await printUpdateNotification();

		const output = consoleLogOutput.join("\n");
		assert.ok(
			output.includes("newer version"),
			"Patient check should wait and notify",
		);

		// Patient timestamp should be updated
		const cache = JSON.parse(readFileSync(cachePath, "utf-8"));
		assert.ok(
			cache.lastPatientCheck > oneDayAgo,
			"Patient timestamp should be updated",
		);
	});

	test("already-resolved fetch works even in impatient mode", async () => {
		// Write a recent patient check timestamp to force impatient mode
		const cachePath = join(tempDir, "last-update-notification.json");
		writeFileSync(
			cachePath,
			JSON.stringify({ lastPatientCheck: Date.now() }),
			"utf-8",
		);

		// Use an instantly-resolving fetch
		globalThis.fetch = async () =>
			new Response(
				JSON.stringify({
					"dist-tags": { latest: "2.0.0" },
				}),
				{ status: 200 },
			);

		startUpdateCheck("1.0.0");

		// Give the microtask queue time to process the fetch
		await new Promise((resolve) => setTimeout(resolve, 10));

		await printUpdateNotification();

		const output = consoleLogOutput.join("\n");
		assert.ok(
			output.includes("newer version"),
			"Already-resolved fetch should notify even in impatient mode",
		);
	});

	test("once-per-version cache survives across patient and impatient runs", async () => {
		// First run: patient, finds update 2.0.0
		globalThis.fetch = async () =>
			new Response(
				JSON.stringify({
					"dist-tags": { latest: "2.0.0" },
				}),
				{ status: 200 },
			);

		startUpdateCheck("1.0.0");
		await printUpdateNotification();
		assert.ok(
			consoleLogOutput.join("\n").includes("2.0.0"),
			"First run should notify",
		);

		// Second run: impatient (recent patient check), same version
		consoleLogOutput = [];
		_resetForTesting();

		globalThis.fetch = async () =>
			new Response(
				JSON.stringify({
					"dist-tags": { latest: "2.0.0" },
				}),
				{ status: 200 },
			);

		startUpdateCheck("1.0.0");
		// Give fetch time to complete
		await new Promise((resolve) => setTimeout(resolve, 10));
		await printUpdateNotification();

		assert.ok(
			!consoleLogOutput.join("\n").includes("newer version"),
			"Second run should be suppressed by version cache",
		);
	});
});
