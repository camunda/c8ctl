/**
 * Unit tests for the `c8ctl setup` done-checks: is Camunda 8 Run
 * installed, and is the local cluster healthy.
 *
 * Built-in code cannot import the cluster plugin, so the install checks
 * reimplement its rules. The equivalence tests below compare them with the
 * plugin's own functions on the host platform; CI runs them on macOS,
 * Linux and Windows.
 */

import assert from "node:assert";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
	c8runCacheDir,
	checkLocalClusterHealth,
	type HealthFetch,
	installedCamunda8RunVersions,
	isCamunda8RunInstalled,
	LOCAL_CLUSTER_HEALTH_URL,
} from "../../src/utils/index.ts";

// @ts-expect-error — JS plugin has no declaration file
const plugin = await import("../../default-plugins/cluster/c8ctl-plugin.js");

const BINARY = process.platform === "win32" ? "c8run.exe" : "c8run";

let cacheDir: string;
beforeEach(() => {
	cacheDir = mkdtempSync(join(tmpdir(), "c8ctl-detectors-"));
});
afterEach(() => {
	rmSync(cacheDir, { recursive: true, force: true });
});

function writeBinary(...segments: string[]): void {
	const dir = join(cacheDir, ...segments.slice(0, -1));
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, segments.at(-1) ?? ""), "");
}

describe("c8runCacheDir()", () => {
	test("C8RUN_CACHE_DIR wins on every platform", () => {
		for (const platform of ["darwin", "linux", "win32"]) {
			assert.strictEqual(
				c8runCacheDir({
					env: { C8RUN_CACHE_DIR: "/custom" },
					platform,
					home: "/home/u",
				}),
				"/custom",
			);
		}
	});

	test("macOS uses ~/Library/Caches/c8run", () => {
		assert.strictEqual(
			c8runCacheDir({ env: {}, platform: "darwin", home: "/Users/u" }),
			join("/Users/u", "Library", "Caches", "c8run"),
		);
	});

	test("Linux uses XDG_CACHE_HOME, else ~/.cache", () => {
		assert.strictEqual(
			c8runCacheDir({
				env: { XDG_CACHE_HOME: "/xdg" },
				platform: "linux",
				home: "/home/u",
			}),
			join("/xdg", "c8run"),
		);
		assert.strictEqual(
			c8runCacheDir({ env: {}, platform: "linux", home: "/home/u" }),
			join("/home/u", ".cache", "c8run"),
		);
	});

	test("Windows uses LOCALAPPDATA, else ~/AppData/Local", () => {
		assert.strictEqual(
			c8runCacheDir({
				env: { LOCALAPPDATA: "/lad" },
				platform: "win32",
				home: "/home/u",
			}),
			join("/lad", "c8run", "cache"),
		);
		assert.strictEqual(
			c8runCacheDir({ env: {}, platform: "win32", home: "/home/u" }),
			join("/home/u", "AppData", "Local", "c8run", "cache"),
		);
	});

	test("matches the cluster plugin on this platform", () => {
		const saved = {
			C8RUN_CACHE_DIR: process.env.C8RUN_CACHE_DIR,
			XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
			LOCALAPPDATA: process.env.LOCALAPPDATA,
		};
		try {
			for (const env of [
				{ C8RUN_CACHE_DIR: "/custom" },
				{ XDG_CACHE_HOME: "/xdg", LOCALAPPDATA: "/lad" },
				{},
			]) {
				for (const key of Object.keys(saved)) delete process.env[key];
				Object.assign(process.env, env);
				assert.strictEqual(
					c8runCacheDir(),
					plugin.getCacheDir(),
					JSON.stringify(env),
				);
			}
		} finally {
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});
});

describe("isCamunda8RunInstalled()", () => {
	const layouts: [string, () => void, boolean][] = [
		["no install directory", () => {}, false],
		[
			"an empty install directory",
			() => mkdirSync(join(cacheDir, "c8run-8.9")),
			false,
		],
		[
			"a binary in a versioned subdirectory",
			() => writeBinary("c8run-8.9", "c8run-8.9.3", BINARY),
			true,
		],
		[
			"a binary directly in the install directory",
			() => writeBinary("c8run-8.9", BINARY),
			true,
		],
		[
			"another platform's binary only",
			() =>
				writeBinary("c8run-8.9", BINARY === "c8run" ? "c8run.exe" : "c8run"),
			false,
		],
		["a different version only", () => writeBinary("c8run-8.8", BINARY), false],
	];

	for (const [name, arrange, expected] of layouts) {
		test(`${name}: ${expected} (same as the cluster plugin)`, () => {
			arrange();
			const ours = isCamunda8RunInstalled({ version: "8.9", cacheDir });
			assert.strictEqual(ours, expected);
			assert.strictEqual(
				ours,
				plugin.isC8RunInstalled({ version: "8.9", cacheDir }),
			);
		});
	}

	test("uses c8run.exe on Windows", () => {
		writeBinary("c8run-8.9", "c8run.exe");
		assert.strictEqual(
			isCamunda8RunInstalled({ version: "8.9", cacheDir, platform: "win32" }),
			true,
		);
		assert.strictEqual(
			isCamunda8RunInstalled({ version: "8.9", cacheDir, platform: "linux" }),
			false,
		);
	});
});

describe("installedCamunda8RunVersions()", () => {
	test("lists only versions whose binary exists, in version order", () => {
		writeBinary("c8run-8.10.0", BINARY);
		writeBinary("c8run-8.9", "c8run-8.9.2", BINARY);
		writeBinary("c8run-8.8.1", BINARY);
		mkdirSync(join(cacheDir, "c8run-8.11.0-alpha1")); // half-extracted
		mkdirSync(join(cacheDir, "not-c8run"));
		assert.deepStrictEqual(installedCamunda8RunVersions({ cacheDir }), [
			"8.8.1",
			"8.9",
			"8.10.0",
		]);
	});

	test("is empty when the cache does not exist", () => {
		assert.deepStrictEqual(
			installedCamunda8RunVersions({ cacheDir: join(cacheDir, "missing") }),
			[],
		);
	});
});

describe("checkLocalClusterHealth()", () => {
	const respond =
		(response: () => Promise<Response>): HealthFetch =>
		() =>
			response();

	test("probes the same health URL the cluster plugin waits on", () => {
		const source = readFileSync(
			join(
				import.meta.dirname,
				"..",
				"..",
				"default-plugins",
				"cluster",
				"c8ctl-plugin.js",
			),
			"utf-8",
		);
		assert.ok(
			source.includes(`'${LOCAL_CLUSTER_HEALTH_URL}'`),
			LOCAL_CLUSTER_HEALTH_URL,
		);
	});

	test("healthy when the health endpoint reports UP", async () => {
		const calls: string[] = [];
		const result = await checkLocalClusterHealth({
			fetch: async (url) => {
				calls.push(url);
				return Response.json({ status: "UP" });
			},
		});
		assert.deepStrictEqual(result, { healthy: true, detail: "status UP" });
		assert.deepStrictEqual(calls, [LOCAL_CLUSTER_HEALTH_URL]);
	});

	for (const [name, fetch, detail] of [
		[
			"reports DOWN",
			respond(async () => Response.json({ status: "DOWN" })),
			/status DOWN/,
		],
		[
			"answers 503",
			respond(async () => new Response(null, { status: 503 })),
			/HTTP 503/,
		],
		[
			"answers with non-JSON",
			respond(async () => new Response("<html>")),
			/unexpected response/,
		],
		[
			"is not running",
			respond(async () => {
				throw new TypeError("fetch failed", {
					cause: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }),
				});
			}),
			/not reachable \(ECONNREFUSED\)/,
		],
	] as const) {
		test(`not healthy when the cluster ${name}`, async () => {
			const result = await checkLocalClusterHealth({ fetch });
			assert.strictEqual(result.healthy, false);
			assert.match(result.detail, detail);
		});
	}

	test("not healthy when the request times out", async () => {
		const result = await checkLocalClusterHealth({
			fetch: (_url, init) =>
				new Promise((_resolve, reject) => {
					init.signal.addEventListener("abort", () =>
						reject(init.signal.reason),
					);
				}),
			timeoutMs: 20,
		});
		assert.deepStrictEqual(result, {
			healthy: false,
			detail: "not reachable (timed out after 0.02s)",
		});
	});
});
