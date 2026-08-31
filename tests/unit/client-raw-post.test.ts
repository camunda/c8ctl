/**
 * Unit tests for `resolveAuthHeaders` and `rawPost`/`rawPostWithHeaders`
 * (src/core/client.ts), covering gateway-profile support (#547):
 *   - custom profile headers are merged into (and can override) the
 *     computed auth headers
 *   - `exactBaseUrl` is honored when building the request URL for a
 *     manually-issued REST call, not just for SDK-issued calls
 */

import assert from "node:assert";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
	rawPost,
	rawPostWithHeaders,
	resolveAuthHeaders,
} from "../../src/core/client.ts";
import { addProfile } from "../../src/core/config.ts";
import { makeMockClient } from "../utils/mocks.ts";

describe("resolveAuthHeaders — custom profile headers (#547)", () => {
	let testDataDir: string;
	let originalEnv: NodeJS.ProcessEnv;

	beforeEach(() => {
		testDataDir = join(tmpdir(), `c8ctl-auth-headers-${Date.now()}`);
		mkdirSync(testDataDir, { recursive: true });
		originalEnv = { ...process.env };
		process.env.C8CTL_DATA_DIR = testDataDir;
	});

	afterEach(() => {
		process.env = originalEnv;
		if (existsSync(testDataDir)) {
			rmSync(testDataDir, { recursive: true, force: true });
		}
	});

	test("merges a profile's custom headers alongside computed Basic auth", async () => {
		addProfile({
			name: "gateway-basic",
			baseUrl: "https://gateway.example.com/camunda-api",
			username: "demo",
			password: "demo",
			headers: { "X-Correlation-Id": "abc-123" },
		});

		const headers = await resolveAuthHeaders("gateway-basic");

		assert.strictEqual(headers["X-Correlation-Id"], "abc-123");
		assert.ok(headers.Authorization?.startsWith("Basic "));
	});

	test("a custom header overrides the computed Authorization header", async () => {
		addProfile({
			name: "gateway-override",
			baseUrl: "https://gateway.example.com/camunda-api",
			username: "demo",
			password: "demo",
			headers: { Authorization: "Bearer gateway-token" },
		});

		const headers = await resolveAuthHeaders("gateway-override");

		assert.strictEqual(headers.Authorization, "Bearer gateway-token");
	});

	test("a differently-cased custom header still overrides, not duplicates", async () => {
		addProfile({
			name: "gateway-case",
			baseUrl: "https://gateway.example.com/camunda-api",
			username: "demo",
			password: "demo",
			// Lowercase "authorization" must replace the computed
			// "Authorization" rather than sit alongside it — HTTP header
			// names are case-insensitive, and the SDK-fetch path
			// (buildGatewayFetch, via Headers.set) already behaves this way.
			headers: { authorization: "Bearer gateway-token" },
		});

		const headers = await resolveAuthHeaders("gateway-case");

		assert.strictEqual(headers.authorization, "Bearer gateway-token");
		assert.strictEqual(headers.Authorization, undefined);
		assert.strictEqual(Object.keys(headers).length, 2); // Content-Type + authorization
	});

	test("no headers field means no extra headers beyond Content-Type/Authorization", async () => {
		addProfile({
			name: "plain",
			baseUrl: "http://plain.example.com/v2",
			username: "demo",
			password: "demo",
		});

		const headers = await resolveAuthHeaders("plain");

		assert.deepStrictEqual(Object.keys(headers).sort(), [
			"Authorization",
			"Content-Type",
		]);
	});
});

describe("rawPostWithHeaders — exactBaseUrl (#547)", () => {
	let testDataDir: string;
	let originalEnv: NodeJS.ProcessEnv;
	let originalFetch: typeof globalThis.fetch;
	let capturedUrl: string | undefined;

	beforeEach(() => {
		testDataDir = join(tmpdir(), `c8ctl-raw-post-${Date.now()}`);
		mkdirSync(testDataDir, { recursive: true });
		originalEnv = { ...process.env };
		process.env.C8CTL_DATA_DIR = testDataDir;

		capturedUrl = undefined;
		originalFetch = globalThis.fetch;
		globalThis.fetch = async (input: string | URL | Request) => {
			capturedUrl = typeof input === "string" ? input : input.toString();
			return new Response(JSON.stringify({ ok: true }), { status: 200 });
		};
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		process.env = originalEnv;
		if (existsSync(testDataDir)) {
			rmSync(testDataDir, { recursive: true, force: true });
		}
	});

	test("targets the profile's exact base URL when exactBaseUrl is set", async () => {
		addProfile({
			name: "gateway-exact",
			baseUrl: "https://gateway.example.com/camunda-api",
			exactBaseUrl: true,
		});

		const client = makeMockClient();
		await rawPost(
			client,
			"/element-instances/wait-states/search",
			{},
			"gateway-exact",
		);

		assert.strictEqual(
			capturedUrl,
			"https://gateway.example.com/camunda-api/element-instances/wait-states/search",
		);
	});

	test("appends /v2 as usual when exactBaseUrl is not set", async () => {
		addProfile({
			name: "gateway-default",
			baseUrl: "https://gateway.example.com/camunda-api",
		});

		const client = makeMockClient();
		await rawPost(
			client,
			"/element-instances/wait-states/search",
			{},
			"gateway-default",
		);

		assert.strictEqual(
			capturedUrl,
			"https://gateway.example.com/camunda-api/v2/element-instances/wait-states/search",
		);
	});

	test("does not double-slash the URL when baseUrl already ends with /v2/ (trailing slash)", async () => {
		addProfile({
			name: "gateway-trailing-slash",
			baseUrl: "https://gateway.example.com/camunda-api/v2/",
		});

		const client = makeMockClient();
		await rawPost(
			client,
			"/element-instances/wait-states/search",
			{},
			"gateway-trailing-slash",
		);

		assert.strictEqual(
			capturedUrl,
			"https://gateway.example.com/camunda-api/v2/element-instances/wait-states/search",
		);
	});

	test("falls back to the client's own resolved address when no profile is given", async () => {
		const client = makeMockClient({
			getConfig: () => ({
				restAddress: "https://from-client-config.example.com/v2",
			}),
		});

		await rawPostWithHeaders(
			client,
			"/element-instances/wait-states/search",
			{},
			{ "Content-Type": "application/json" },
		);

		assert.strictEqual(
			capturedUrl,
			"https://from-client-config.example.com/v2/element-instances/wait-states/search",
		);
	});
});
