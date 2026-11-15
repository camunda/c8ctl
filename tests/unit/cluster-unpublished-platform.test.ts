/**
 * The cluster plugin refuses to download Camunda 8 Run for a platform the
 * Camunda Download Center publishes no build for, instead of requesting an
 * archive that does not exist.
 *
 * Published builds: darwin-aarch64, darwin-x86_64, linux-x86_64 and
 * windows-x86_64. A mirror (C8CTL_C8RUN_DOWNLOAD_URL) may host others.
 */

import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { c8WithOptions } from "../utils/cli.ts";

// @ts-expect-error — JS plugin has no declaration file
const plugin = await import("../../default-plugins/cluster/c8ctl-plugin.js");

// The no-mirror cases pass `mirror: ""` explicitly: `undefined` would fall
// back to the developer's C8CTL_C8RUN_DOWNLOAD_URL.
describe("unpublishedPlatformMessage()", () => {
	for (const [platform, arch] of [
		["darwin", "x64"],
		["darwin", "arm64"],
		["linux", "x64"],
		["win32", "x64"],
	]) {
		test(`accepts ${platform} ${arch}`, () => {
			assert.strictEqual(
				plugin.unpublishedPlatformMessage({
					platform,
					arch,
					mirror: "",
				}),
				null,
			);
		});
	}

	for (const [platform, arch] of [
		["linux", "arm64"],
		["win32", "arm64"],
		["freebsd", "x64"],
	]) {
		test(`explains that ${platform} ${arch} has no build`, () => {
			const message = plugin.unpublishedPlatformMessage({
				platform,
				arch,
				mirror: "",
			});
			assert.match(message ?? "", new RegExp(`${platform} ${arch}`));
			assert.match(
				message ?? "",
				/macOS \(x64, arm64\), Linux \(x64\) and Windows \(x64\)/,
			);
			assert.match(message ?? "", /C8CTL_C8RUN_DOWNLOAD_URL/);
		});
	}

	test("allows any platform when a mirror is configured", () => {
		assert.strictEqual(
			plugin.unpublishedPlatformMessage({
				platform: "linux",
				arch: "arm64",
				mirror: "https://mirror.example/c8run/",
			}),
			null,
		);
	});
});

/**
 * Preload for the CLI subprocess: report Linux arm64, and replace fetch
 * with a stub that records any request and fails it.
 */
const LINUX_ARM64 = `data:text/javascript,${encodeURIComponent(`
import os from "node:os";
import { writeSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
os.platform = () => "linux";
os.arch = () => "arm64";
syncBuiltinESMExports();
globalThis.fetch = async (url) => {
	writeSync(2, "FETCH-STUB " + String(url) + "\\n");
	throw new TypeError("fetch failed");
};
`)}`;

describe("cluster install on a platform with no published build", () => {
	let dataDir: string;
	beforeEach(() => {
		dataDir = mkdtempSync(join(tmpdir(), "c8ctl-unpublished-"));
	});
	afterEach(() => {
		rmSync(dataDir, { recursive: true, force: true });
	});

	test("fails with the explanation before requesting the archive", async () => {
		const result = await c8WithOptions(
			{
				nodeArgs: ["--import", LINUX_ARM64],
				env: {
					C8CTL_DATA_DIR: dataDir,
					C8CTL_OUTPUT_MODE: "text",
					C8CTL_C8RUN_DOWNLOAD_URL: undefined,
					// An empty cache, so an installed 8.9.0 cannot skip the download path.
					C8RUN_CACHE_DIR: join(dataDir, "c8run-cache"),
				},
			},
			"cluster",
			"install",
			"8.9.0",
		);
		assert.notStrictEqual(result.status, 0);
		assert.match(result.stderr, /not published for linux arm64/);
		assert.doesNotMatch(
			result.stderr,
			/FETCH-STUB .*camunda8-run/,
			"no archive request should be made",
		);
	});
});
