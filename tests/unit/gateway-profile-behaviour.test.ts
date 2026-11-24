/**
 * CLI behavioural tests for gateway-fronted profiles (#547).
 *
 * These spawn the real CLI against a local mock HTTP server (rather than a
 * running Camunda 8 instance) and inspect exactly what the server received,
 * end to end through the real SDK client — proving `--header` and
 * `--exactBaseUrl` work through the full request path, not just through the
 * `buildGatewayFetch` unit in isolation, and that a profile which uses
 * neither flag is unaffected.
 */

import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, test } from "node:test";
import type { Profile } from "../../src/core/config.ts";
import { isRecord } from "../utils/guards.ts";
import { asyncSpawn } from "../utils/spawn.ts";

const CLI = resolve(import.meta.dirname, "..", "..", "src", "index.ts");

interface CapturedRequest {
	method?: string;
	url?: string;
	headers: Record<string, string | string[] | undefined>;
}

/**
 * Find the one job-activation request among everything the mock server
 * received. Asserting via this helper — rather than checking
 * `requests.length === 1` and indexing `requests[0]` — keeps these tests
 * robust if the SDK ever issues an additional harmless request (e.g. a
 * topology check) alongside the activation request under test.
 */
function findActivationRequest(requests: CapturedRequest[]): CapturedRequest {
	const matches = requests.filter((r) => r.url?.endsWith("/jobs/activation"));
	assert.strictEqual(
		matches.length,
		1,
		`expected exactly one /jobs/activation request, got ${matches.length}: ${JSON.stringify(requests)}`,
	);
	return matches[0];
}

function getServerPort(server: Server): number {
	const addr = server.address();
	if (isRecord(addr) && typeof addr.port === "number") {
		return addr.port;
	}
	throw new Error("mock server has no port (not listening?)");
}

/**
 * Start a mock HTTP server that records every request it receives and
 * answers with `responseBody` as JSON.
 */
async function startCapturingMockServer(responseBody: unknown): Promise<{
	url: string;
	requests: CapturedRequest[];
	close: () => Promise<void>;
}> {
	const requests: CapturedRequest[] = [];
	const server: Server = createServer((req, res) => {
		requests.push({ method: req.method, url: req.url, headers: req.headers });
		res.setHeader("content-type", "application/json");
		res.end(JSON.stringify(responseBody));
	});
	await new Promise<void>((res, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => res());
	});
	const port = getServerPort(server);
	return {
		url: `http://127.0.0.1:${port}`,
		requests,
		close: () => new Promise<void>((res) => server.close(() => res())),
	};
}

/** A minimal job activation response the SDK can parse successfully. */
const MOCK_JOB = {
	jobKey: "1",
	type: "my-job-type",
	retries: 3,
	processInstanceKey: "1",
	worker: "c8ctl",
	deadline: Date.now() + 60000,
	elementId: "task1",
	processDefinitionId: "process1",
	processDefinitionVersion: 1,
	processDefinitionKey: "pd1",
	tenantId: "<default>",
	variables: {},
};

/**
 * Spawn the CLI against a temp data dir pre-seeded with the given profile,
 * running `activate jobs my-job-type --profile <name>`. No credentials are
 * configured on the profile, so the SDK uses CAMUNDA_AUTH_STRATEGY=NONE.
 */
async function activateJobsUnderProfile(
	dataDir: string,
	profile: Profile,
): ReturnType<typeof asyncSpawn> {
	writeFileSync(
		join(dataDir, "profiles.json"),
		JSON.stringify({ profiles: [profile] }),
	);
	writeFileSync(
		join(dataDir, "session.json"),
		JSON.stringify({ outputMode: "json" }),
	);
	return asyncSpawn(
		"node",
		[
			"--experimental-strip-types",
			CLI,
			"activate",
			"jobs",
			"my-job-type",
			"--profile",
			profile.name,
		],
		{
			env: {
				...process.env,
				HOME: "/tmp/c8ctl-test-nonexistent-home",
				C8CTL_DATA_DIR: dataDir,
			},
		},
	);
}

describe("CLI behavioural: gateway profile headers + exactBaseUrl (#547)", () => {
	let server: {
		url: string;
		requests: CapturedRequest[];
		close: () => Promise<void>;
	} | null = null;
	let dataDir: string | null = null;

	afterEach(async () => {
		if (server) {
			await server.close();
			server = null;
		}
		if (dataDir) {
			rmSync(dataDir, { recursive: true, force: true });
			dataDir = null;
		}
	});

	test("attaches --header to the real request", async () => {
		server = await startCapturingMockServer({ jobs: [MOCK_JOB] });
		dataDir = mkdtempSync(join(tmpdir(), "c8ctl-gateway-headers-"));

		const result = await activateJobsUnderProfile(dataDir, {
			name: "gateway",
			baseUrl: `${server.url}/v2`,
			headers: { "X-Api-Key": "secret" },
		});

		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const activation = findActivationRequest(server.requests);
		assert.strictEqual(activation.headers["x-api-key"], "secret");
	});

	test("--exactBaseUrl targets the profile's base URL without appending /v2", async () => {
		server = await startCapturingMockServer({ jobs: [MOCK_JOB] });
		dataDir = mkdtempSync(join(tmpdir(), "c8ctl-gateway-exact-"));

		const result = await activateJobsUnderProfile(dataDir, {
			name: "gateway",
			baseUrl: server.url,
			exactBaseUrl: true,
		});

		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const activation = findActivationRequest(server.requests);
		assert.strictEqual(activation.url, "/jobs/activation");
	});

	test("combines --header and --exactBaseUrl on the same request", async () => {
		server = await startCapturingMockServer({ jobs: [MOCK_JOB] });
		dataDir = mkdtempSync(join(tmpdir(), "c8ctl-gateway-combo-"));

		const result = await activateJobsUnderProfile(dataDir, {
			name: "gateway",
			baseUrl: server.url,
			exactBaseUrl: true,
			headers: { "X-Api-Key": "secret", "X-Correlation-Id": "abc-123" },
		});

		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const activation = findActivationRequest(server.requests);
		assert.strictEqual(activation.url, "/jobs/activation");
		assert.strictEqual(activation.headers["x-api-key"], "secret");
		assert.strictEqual(activation.headers["x-correlation-id"], "abc-123");
	});

	test("a profile using neither flag behaves exactly as before", async () => {
		server = await startCapturingMockServer({ jobs: [MOCK_JOB] });
		dataDir = mkdtempSync(join(tmpdir(), "c8ctl-gateway-plain-"));

		const result = await activateJobsUnderProfile(dataDir, {
			name: "plain",
			baseUrl: `${server.url}/v2`,
		});

		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		// baseUrl already carries /v2, as every profile is expected to today
		// — the request path is unaffected by this change.
		const activation = findActivationRequest(server.requests);
		assert.strictEqual(activation.url, "/v2/jobs/activation");
		assert.strictEqual(activation.headers["x-api-key"], undefined);
	});
});
