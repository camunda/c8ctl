/**
 * Unit tests for Camunda SDK environment-variable compatibility.
 *
 * c8ctl documents `CAMUNDA_BASE_URL` as the cluster-address variable, but the
 * Camunda SDKs (JS, Java, Python) and most `.env` files use
 * `CAMUNDA_REST_ADDRESS`. c8ctl accepts it as an alias (with `CAMUNDA_BASE_URL`
 * winning when both are set) and honours `CAMUNDA_AUTH_STRATEGY`
 * (NONE/BASIC/OAUTH) so an SDK project's environment works unchanged.
 */

import assert from "node:assert";
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, test } from "node:test";
import { createClient } from "../../src/core/client.ts";
import {
	addProfile,
	resolveAuthStrategy,
	resolveClusterConfig,
} from "../../src/core/config.ts";
import { c8ctl } from "../../src/core/runtime.ts";
import { isRecord } from "../utils/guards.ts";

/**
 * The SDK module is dual ESM/CJS, so a require-cache stub cannot intercept
 * `createClient`'s static import. Instead these tests capture the SDK's
 * *effective* configuration by pointing it at a real in-process HTTP server
 * and observing the requests that come out — the same end-to-end signal the
 * issue reports (a request arriving at the configured address, with or
 * without an Authorization header).
 */

interface CapturedRequest {
	method?: string;
	url?: string;
	headers: Record<string, string | string[] | undefined>;
}

function getServerPort(server: Server): number {
	const addr = server.address();
	if (isRecord(addr) && typeof addr.port === "number") {
		return addr.port;
	}
	throw new Error("mock server has no port (not listening?)");
}

/** A minimal topology response the SDK can parse successfully. */
const MOCK_TOPOLOGY = {
	brokers: [],
	clusterSize: 0,
	partitionsCount: 0,
	replicationFactor: 0,
	gatewayVersion: "8.9.0",
};

async function startCapturingServer(): Promise<{
	url: string;
	requests: CapturedRequest[];
	close: () => Promise<void>;
}> {
	const requests: CapturedRequest[] = [];
	const server: Server = createServer((req, res) => {
		requests.push({ method: req.method, url: req.url, headers: req.headers });
		res.setHeader("content-type", "application/json");
		res.end(JSON.stringify(MOCK_TOPOLOGY));
	});
	await new Promise<void>((res, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => res());
	});
	return {
		url: `http://127.0.0.1:${getServerPort(server)}`,
		requests,
		close: () => new Promise<void>((res) => server.close(() => res())),
	};
}

/** A client built by `createClient` exposes the generated API surface. */
interface TopologyClient {
	getTopology: () => Promise<unknown>;
}

function isTopologyClient(client: unknown): client is TopologyClient {
	return (
		isRecord(client) &&
		"getTopology" in client &&
		typeof client.getTopology === "function"
	);
}

/**
 * Build a client via `createClient` under the given CAMUNDA_* environment
 * and issue one topology request, returning what the server received. The
 * literal string `"$SERVER_URL"` in any env value is replaced with the
 * capturing server's address, so the test can point the SDK at it.
 */
async function captureSdkRequest(
	env: Record<string, string | undefined>,
): Promise<CapturedRequest> {
	const server = await startCapturingServer();
	const resolvedEnv = Object.fromEntries(
		Object.entries(env).map(([key, value]) => [
			key,
			value?.replaceAll("$SERVER_URL", server.url),
		]),
	);
	const previous: Record<string, string | undefined> = {};
	for (const [key, value] of Object.entries(resolvedEnv)) {
		previous[key] = process.env[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	const previousProfile = c8ctl.activeProfile;
	c8ctl.activeProfile = undefined;

	try {
		const client: unknown = createClient();
		assert.ok(
			isTopologyClient(client),
			"createClient must return a client exposing getTopology",
		);
		await client.getTopology();
	} finally {
		c8ctl.activeProfile = previousProfile;
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await server.close();
	}

	const topology = server.requests.find((r) => r.url?.endsWith("/topology"));
	assert.ok(
		topology,
		`expected a /topology request, got: ${JSON.stringify(server.requests)}`,
	);
	return topology;
}

describe("SDK environment variable compatibility", () => {
	let originalEnv: NodeJS.ProcessEnv;
	let originalStderr: typeof console.error;
	let stderrSpy: string[];

	beforeEach(() => {
		originalEnv = { ...process.env };
		c8ctl.activeProfile = undefined;
		c8ctl.outputMode = "text";
		stderrSpy = [];
		originalStderr = console.error;
		console.error = (...args: unknown[]) => {
			stderrSpy.push(args.join(" "));
		};
	});

	afterEach(() => {
		process.env = originalEnv;
		c8ctl.activeProfile = undefined;
		console.error = originalStderr;
	});

	function clearCamundaEnv(): void {
		for (const key of Object.keys(process.env)) {
			if (key.startsWith("CAMUNDA_")) delete process.env[key];
		}
	}

	describe("CAMUNDA_REST_ADDRESS as an alias for CAMUNDA_BASE_URL", () => {
		test("resolveClusterConfig uses CAMUNDA_REST_ADDRESS when CAMUNDA_BASE_URL is unset", () => {
			clearCamundaEnv();
			process.env.CAMUNDA_REST_ADDRESS = "http://localhost:8088";

			const config = resolveClusterConfig();

			assert.strictEqual(config.baseUrl, "http://localhost:8088");
		});

		test("CAMUNDA_BASE_URL wins when both address variables are set", () => {
			clearCamundaEnv();
			process.env.CAMUNDA_BASE_URL = "https://base-url.example.com";
			process.env.CAMUNDA_REST_ADDRESS = "https://rest-address.example.com";

			const config = resolveClusterConfig();

			assert.strictEqual(config.baseUrl, "https://base-url.example.com");
		});

		test("CAMUNDA_REST_ADDRESS combines with the other CAMUNDA_* credential variables", () => {
			clearCamundaEnv();
			process.env.CAMUNDA_REST_ADDRESS = "http://localhost:8088";
			process.env.CAMUNDA_CLIENT_ID = "id";
			process.env.CAMUNDA_CLIENT_SECRET = "secret";

			const config = resolveClusterConfig();

			assert.strictEqual(config.baseUrl, "http://localhost:8088");
			assert.strictEqual(config.clientId, "id");
			assert.strictEqual(config.clientSecret, "secret");
		});

		test("the SDK request goes to the CAMUNDA_REST_ADDRESS server", async () => {
			const request = await captureSdkRequest({
				CAMUNDA_BASE_URL: undefined,
				CAMUNDA_REST_ADDRESS: "$SERVER_URL",
				CAMUNDA_AUTH_STRATEGY: "NONE",
			});
			// The SDK appends /v2 to a bare address — the request landing on the
			// capturing server at all is what proves the alias was honoured.
			assert.ok(request.url?.endsWith("/topology"));
		});

		test("an active session profile still wins over CAMUNDA_REST_ADDRESS", () => {
			clearCamundaEnv();
			process.env.CAMUNDA_REST_ADDRESS = "http://localhost:8088";
			addProfile({
				name: "local",
				baseUrl: "http://localhost:8080/v2",
				username: "demo",
				password: "demo",
			});
			c8ctl.activeProfile = "local";

			const config = resolveClusterConfig();

			assert.strictEqual(config.baseUrl, "http://localhost:8080/v2");
		});
	});

	describe("CAMUNDA_AUTH_STRATEGY", () => {
		test("resolveClusterConfig surfaces CAMUNDA_AUTH_STRATEGY", () => {
			clearCamundaEnv();
			process.env.CAMUNDA_REST_ADDRESS = "http://localhost:8088";
			process.env.CAMUNDA_AUTH_STRATEGY = "NONE";

			const config = resolveClusterConfig();

			assert.strictEqual(config.authStrategy, "NONE");
		});

		test("CAMUNDA_AUTH_STRATEGY=NONE sends no Authorization header even when credentials are set", async () => {
			const request = await captureSdkRequest({
				CAMUNDA_BASE_URL: "$SERVER_URL/v2",
				CAMUNDA_AUTH_STRATEGY: "NONE",
				CAMUNDA_CLIENT_ID: "id",
				CAMUNDA_CLIENT_SECRET: "secret",
			});

			assert.strictEqual(request.headers.authorization, undefined);
		});

		test("CAMUNDA_AUTH_STRATEGY=BASIC authenticates with CAMUNDA_USERNAME/CAMUNDA_PASSWORD", async () => {
			const request = await captureSdkRequest({
				CAMUNDA_BASE_URL: "$SERVER_URL/v2",
				CAMUNDA_AUTH_STRATEGY: "BASIC",
				CAMUNDA_USERNAME: "user",
				CAMUNDA_PASSWORD: "pass",
			});

			assert.strictEqual(
				request.headers.authorization,
				`Basic ${Buffer.from("user:pass").toString("base64")}`,
			);
		});

		test("CAMUNDA_AUTH_STRATEGY=OAUTH fetches a token from CAMUNDA_OAUTH_URL", async () => {
			// The mock answers every request — including the token endpoint —
			// with the topology payload. The SDK cannot parse a token out of
			// that, so the call fails; the observable signal is that the SDK
			// *attempted* OAuth (a POST to the token URL), which only happens
			// when the OAUTH strategy and its credentials flowed through.
			const server = await startCapturingServer();
			const previous: Record<string, string | undefined> = {};
			const env: Record<string, string | undefined> = {
				CAMUNDA_BASE_URL: `${server.url}/v2`,
				CAMUNDA_AUTH_STRATEGY: "OAUTH",
				CAMUNDA_CLIENT_ID: "id",
				CAMUNDA_CLIENT_SECRET: "secret",
				CAMUNDA_OAUTH_URL: `${server.url}/oauth/token`,
				CAMUNDA_TOKEN_AUDIENCE: "audience",
				// Keep the (doomed) token fetch fast — the mock answers with a
				// non-token payload, so the SDK would otherwise back off and retry
				// for ~15s before giving up.
				CAMUNDA_OAUTH_RETRY_MAX: "1",
				CAMUNDA_OAUTH_TIMEOUT_MS: "1000",
			};
			for (const [key, value] of Object.entries(env)) {
				previous[key] = process.env[key];
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			const previousProfile = c8ctl.activeProfile;
			c8ctl.activeProfile = undefined;
			try {
				const client: unknown = createClient();
				assert.ok(isTopologyClient(client));
				await client.getTopology().catch(() => {});
			} finally {
				c8ctl.activeProfile = previousProfile;
				for (const [key, value] of Object.entries(previous)) {
					if (value === undefined) delete process.env[key];
					else process.env[key] = value;
				}
				await server.close();
			}

			const tokenRequest = server.requests.find((r) =>
				r.url?.endsWith("/oauth/token"),
			);
			assert.ok(
				tokenRequest,
				`expected an OAuth token request, got: ${JSON.stringify(server.requests.map((r) => r.url))}`,
			);
		});

		test("without CAMUNDA_AUTH_STRATEGY the strategy is derived from the credentials present", async () => {
			const request = await captureSdkRequest({
				CAMUNDA_BASE_URL: "$SERVER_URL/v2",
				CAMUNDA_AUTH_STRATEGY: undefined,
				CAMUNDA_USERNAME: "user",
				CAMUNDA_PASSWORD: "pass",
			});

			assert.strictEqual(
				request.headers.authorization,
				`Basic ${Buffer.from("user:pass").toString("base64")}`,
			);
		});

		test("resolveAuthStrategy rejects an unsupported value with an actionable error", () => {
			assert.throws(
				() => resolveAuthStrategy("KERBEROS"),
				/CAMUNDA_AUTH_STRATEGY.*NONE.*BASIC.*OAUTH/s,
			);
		});
	});

	describe("SDK-only variable warning", () => {
		test("warns when SDK-only CAMUNDA_* variables are set but no address variable is", () => {
			clearCamundaEnv();
			process.env.CAMUNDA_CLIENT_ID = "id";
			process.env.CAMUNDA_CLIENT_SECRET = "secret";

			const config = resolveClusterConfig();

			assert.strictEqual(config.baseUrl, "http://localhost:8080/v2");
			const warnings = stderrSpy.join("\n");
			assert.match(warnings, /CAMUNDA_CLIENT_ID/);
			assert.match(warnings, /CAMUNDA_BASE_URL|CAMUNDA_REST_ADDRESS/);
			assert.match(warnings, /localhost:8080/);
		});

		test("does not warn when an address variable is set", () => {
			clearCamundaEnv();
			process.env.CAMUNDA_REST_ADDRESS = "http://localhost:8088";
			process.env.CAMUNDA_CLIENT_ID = "id";
			process.env.CAMUNDA_CLIENT_SECRET = "secret";

			resolveClusterConfig();

			assert.strictEqual(stderrSpy.join("\n"), "");
		});

		test("does not warn when no CAMUNDA_* variables are set at all", () => {
			clearCamundaEnv();

			resolveClusterConfig();

			assert.strictEqual(stderrSpy.join("\n"), "");
		});
	});
});
