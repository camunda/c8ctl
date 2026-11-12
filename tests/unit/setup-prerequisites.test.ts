/**
 * Unit tests for the `c8ctl setup` prerequisite checks.
 *
 * The checks take their inputs (Node.js version, platform, fetch and
 * environment) as parameters, so every outcome is tested without the
 * real runtime or network.
 */

import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
	checkNetwork,
	checkNodeVersion,
	checkPlatform,
	checkPrerequisites,
	formatPrerequisiteFailures,
	MANUAL_SETUP_LINKS,
	type PrerequisiteFetch,
	REQUIRED_NODE_RANGE,
} from "../../src/utils/index.ts";

const DEFAULT_HOST = "https://downloads.camunda.cloud/release/camunda/c8run/";

/** A fetch stub that records requests and answers with `respond`. */
function stubFetch(respond: (url: string) => Promise<unknown>) {
	const calls: { url: string; method: string; redirect: string }[] = [];
	const fetch: PrerequisiteFetch = (url, init) => {
		calls.push({ url, method: init.method, redirect: init.redirect });
		return respond(url);
	};
	return { fetch, calls };
}

function connectionError(code: string): Error {
	return new TypeError("fetch failed", {
		cause: Object.assign(new Error(code), { code }),
	});
}

describe("checkNodeVersion()", () => {
	test("the required range is the engines.node range in package.json", () => {
		const pkg = JSON.parse(
			readFileSync(
				join(import.meta.dirname, "..", "..", "package.json"),
				"utf-8",
			),
		);
		assert.strictEqual(REQUIRED_NODE_RANGE, pkg.engines.node);
	});

	test("passes for a version in range", () => {
		const result = checkNodeVersion({ version: "24.20.0", range: ">=22.18.0" });
		assert.strictEqual(result.ok, true);
		assert.match(result.detail, /24\.20\.0/);
	});

	test("passes for the exact minimum", () => {
		assert.strictEqual(
			checkNodeVersion({ version: "22.18.0", range: ">=22.18.0" }).ok,
			true,
		);
	});

	test("fails for an older version, naming both versions and how to fix it", () => {
		const result = checkNodeVersion({ version: "22.17.1", range: ">=22.18.0" });
		assert.strictEqual(result.ok, false);
		assert.match(result.detail, /22\.17\.1/);
		assert.match(result.detail, />=22\.18\.0/);
		assert.match(result.hint ?? "", /nodejs\.org/);
	});

	test("accepts prerelease builds that are otherwise in range", () => {
		assert.strictEqual(
			checkNodeVersion({ version: "25.0.0-nightly2026111", range: ">=22.18.0" })
				.ok,
			true,
		);
	});
});

describe("checkPlatform()", () => {
	for (const platform of ["darwin", "linux", "win32"] as const) {
		for (const arch of ["x64", "arm64"]) {
			test(`supports ${platform} ${arch}`, () => {
				assert.strictEqual(checkPlatform({ platform, arch }).ok, true);
			});
		}
	}

	for (const [platform, arch] of [
		["freebsd", "x64"],
		["aix", "ppc64"],
		["linux", "ia32"],
		["linux", "s390x"],
	] as const) {
		test(`rejects ${platform} ${arch}, naming it`, () => {
			const result = checkPlatform({ platform, arch });
			assert.strictEqual(result.ok, false);
			assert.match(result.detail, new RegExp(`${platform}.*${arch}`));
		});
	}
});

describe("checkNetwork()", () => {
	for (const status of [200, 301, 403, 404]) {
		test(`any HTTP response (${status}) means the host is reachable`, async () => {
			const { fetch, calls } = stubFetch(
				async () => new Response(null, { status }),
			);
			const result = await checkNetwork({ fetch, env: {} });
			assert.strictEqual(result.ok, true, result.detail);
			// Redirects are not followed: the redirect itself is the answer.
			assert.deepStrictEqual(calls, [
				{ url: DEFAULT_HOST, method: "HEAD", redirect: "manual" },
			]);
		});
	}

	test("a connection failure fails, naming the host and the cause", async () => {
		const { fetch } = stubFetch(async () => {
			throw connectionError("ENOTFOUND");
		});
		const result = await checkNetwork({ fetch, env: {} });
		assert.strictEqual(result.ok, false);
		assert.match(result.detail, /downloads\.camunda\.cloud/);
		assert.match(result.detail, /ENOTFOUND/);
		assert.match(result.hint ?? "", /NODE_USE_ENV_PROXY=1/);
	});

	test("an unanswered request times out and fails", async () => {
		const fetch: PrerequisiteFetch = (_url, init) =>
			new Promise((_resolve, reject) => {
				init.signal.addEventListener("abort", () => reject(init.signal.reason));
			});
		const result = await checkNetwork({ fetch, env: {}, timeoutMs: 20 });
		assert.strictEqual(result.ok, false);
		assert.match(result.detail, /timed out/);
	});

	test("HTTPS_PROXY without NODE_USE_ENV_PROXY gets the specific proxy hint", async () => {
		const { fetch } = stubFetch(async () => {
			throw connectionError("ECONNREFUSED");
		});
		const result = await checkNetwork({
			fetch,
			env: { HTTPS_PROXY: "http://proxy.example:3128" },
		});
		assert.match(result.hint ?? "", /HTTPS_PROXY is set/);
	});

	test("checks the C8CTL_C8RUN_DOWNLOAD_URL mirror when it is set", async () => {
		const { fetch, calls } = stubFetch(async () => {
			throw connectionError("ECONNREFUSED");
		});
		const result = await checkNetwork({
			fetch,
			env: { C8CTL_C8RUN_DOWNLOAD_URL: "https://mirror.example/c8run" },
		});
		assert.strictEqual(calls[0].url, "https://mirror.example/c8run/");
		assert.match(result.detail, /mirror\.example/);
		assert.match(result.hint ?? "", /C8CTL_C8RUN_DOWNLOAD_URL/);
	});

	test("a query string or fragment in a mirror URL is not shown", async () => {
		for (const respond of [
			async () => new Response(null, { status: 200 }),
			async () => {
				throw connectionError("ECONNREFUSED");
			},
		]) {
			const { fetch } = stubFetch(respond);
			const result = await checkNetwork({
				fetch,
				env: {
					C8CTL_C8RUN_DOWNLOAD_URL:
						"https://mirror.example/c8run?token=abc123#part",
				},
			});
			assert.doesNotMatch(`${result.detail} ${result.hint}`, /abc123|part/);
			assert.match(result.detail, /mirror\.example\/c8run\/?\?<redacted>/);
		}
	});

	for (const [url, problem] of [
		["https://user:secret@mirror.example/c8run", /contains credentials/],
		["not a url", /not a valid URL/],
		["ftp://mirror.example/c8run", /unsupported protocol ftp:/],
	] as const) {
		test(`a mirror URL that cannot work fails without a request: ${url}`, async () => {
			const { fetch, calls } = stubFetch(async () => new Response(null));
			const result = await checkNetwork({
				fetch,
				env: { C8CTL_C8RUN_DOWNLOAD_URL: url },
			});
			assert.strictEqual(result.ok, false);
			assert.strictEqual(calls.length, 0);
			assert.match(result.detail, problem);
			assert.doesNotMatch(`${result.detail} ${result.hint}`, /secret/);
		});
	}

	test("a credentials mirror URL never reaches the real fetch or prints the password", async () => {
		const result = await checkNetwork({
			env: {
				C8CTL_C8RUN_DOWNLOAD_URL: "https://user:secret@mirror.example/c8run",
			},
		});
		assert.strictEqual(result.ok, false);
		assert.doesNotMatch(formatPrerequisiteFailures([result]), /secret/);
	});

	test("an error without a code is reported generically, not by its message", async () => {
		const { fetch } = stubFetch(async () => {
			throw new Error("boom at https://user:hunter2@mirror.example/");
		});
		const result = await checkNetwork({ fetch, env: {} });
		assert.strictEqual(result.ok, false);
		assert.match(result.detail, /connection failed/);
		assert.doesNotMatch(result.detail, /hunter2|boom/);
	});
});

describe("checkPrerequisites()", () => {
	test("runs every check in order", async () => {
		const { fetch } = stubFetch(
			async () => new Response(null, { status: 200 }),
		);
		const results = await checkPrerequisites({
			version: "24.20.0",
			platform: "linux",
			arch: "x64",
			fetch,
			env: {},
		});
		assert.deepStrictEqual(
			results.map((r) => [r.id, r.ok]),
			[
				["node", true],
				["platform", true],
				["network", true],
			],
		);
	});
});

describe("formatPrerequisiteFailures()", () => {
	test("lists only the failed checks, then the manual setup links", async () => {
		const { fetch } = stubFetch(async () => {
			throw connectionError("ENOTFOUND");
		});
		const results = await checkPrerequisites({
			version: "24.20.0",
			platform: "freebsd",
			arch: "x64",
			fetch,
			env: {},
		});
		const text = formatPrerequisiteFailures(results);
		assert.doesNotMatch(text, /Node\.js version/);
		assert.match(text, /freebsd/);
		assert.match(text, /downloads\.camunda\.cloud/);
		for (const link of MANUAL_SETUP_LINKS) {
			assert.ok(text.includes(link.url), `missing ${link.url}`);
		}
	});

	test("manual setup links point at docs.camunda.io pages", () => {
		for (const link of MANUAL_SETUP_LINKS) {
			assert.match(link.url, /^https:\/\/docs\.camunda\.io\/docs\/.+\/$/);
		}
	});
});
