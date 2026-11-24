/**
 * CLI behavioural tests for SDK-style environment variables.
 *
 * The Camunda SDKs address a cluster with `CAMUNDA_REST_ADDRESS` and select
 * authentication with `CAMUNDA_AUTH_STRATEGY`; c8ctl historically read only
 * `CAMUNDA_BASE_URL` and derived the strategy from whichever credentials were
 * present. These tests spawn the real CLI against a local mock server to
 * prove the SDK variables are honoured end to end through the real client —
 * including the `mcp-proxy` path, where the silent
 * fallback to the `local` profile surfaced as "connection refused on
 * localhost".
 */

import assert from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, test } from "node:test";
import { isRecord } from "../utils/guards.ts";
import { pollUntil } from "../utils/polling.ts";
import { asyncSpawn } from "../utils/spawn.ts";

const CLI = resolve(import.meta.dirname, "..", "..", "src", "index.ts");
const FIXTURE_BPMN = resolve(
	import.meta.dirname,
	"..",
	"fixtures",
	"mini-process.bpmn",
);

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

/**
 * Start a mock MCP endpoint that records requests and answers the MCP
 * `initialize` handshake with a minimal valid response.
 */
async function startMcpMockServer(): Promise<{
	url: string;
	requests: CapturedRequest[];
	close: () => Promise<void>;
}> {
	const requests: CapturedRequest[] = [];
	const server: Server = createServer((req, res) => {
		requests.push({ method: req.method, url: req.url, headers: req.headers });
		res.setHeader("content-type", "application/json");
		res.end(
			JSON.stringify({
				jsonrpc: "2.0",
				id: 0,
				result: {
					protocolVersion: "2025-03-26",
					capabilities: { tools: {} },
					serverInfo: { name: "mock", version: "0.0.0" },
				},
			}),
		);
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

/** An isolated, profile-free data dir so env vars drive resolution. */
function makeDataDir(outputMode: "json" | "text" = "json"): string {
	const dataDir = mkdtempSync(join(tmpdir(), "c8ctl-sdk-env-"));
	writeFileSync(join(dataDir, "session.json"), JSON.stringify({ outputMode }));
	return dataDir;
}

describe("CLI behavioural: SDK env vars", () => {
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

	test("mcp-proxy connects to CAMUNDA_REST_ADDRESS with CAMUNDA_AUTH_STRATEGY=NONE", async () => {
		server = await startMcpMockServer();
		dataDir = makeDataDir();

		const child = spawn(
			process.execPath,
			["--experimental-strip-types", CLI, "mcp-proxy"],
			{
				env: {
					...process.env,
					HOME: "/tmp/c8ctl-test-nonexistent-home",
					C8CTL_DATA_DIR: dataDir,
					CAMUNDA_BASE_URL: undefined,
					CAMUNDA_REST_ADDRESS: server.url,
					CAMUNDA_AUTH_STRATEGY: "NONE",
				},
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		const exited = new Promise<number | null>((res) => {
			child.once("close", (code) => res(code));
		});
		let exitCode: number | null | undefined;
		void exited.then((code) => {
			exitCode = code;
		});

		try {
			// The deterministic readiness signal is the proxy's own
			// "started successfully" log line, emitted only after the
			// remote handshake and shutdown-handler registration complete.
			// The deadline is a failure safety net for a loaded runner, not
			// a correctness signal.
			const started = await pollUntil(
				async () =>
					stderr.includes("MCP proxy started successfully") ||
					exitCode !== undefined,
				20_000,
				50,
			);
			assert.ok(
				started && exitCode === undefined,
				`expected the proxy to report a completed startup, exit=${exitCode} stderr: ${stderr}`,
			);
		} finally {
			if (process.platform === "win32") {
				child.stdin.end();
			} else {
				child.kill("SIGTERM");
			}
		}
		const code = await exited;
		if (process.platform !== "win32") {
			assert.match(
				stderr,
				/Received SIGTERM, shutting down gracefully/,
				"expected the SIGTERM handler to run",
			);
			assert.strictEqual(
				code,
				0,
				`expected a clean shutdown on SIGTERM, stderr: ${stderr}`,
			);
		}

		const initialize = server.requests.find((r) =>
			r.url?.endsWith("/mcp/cluster"),
		);
		assert.ok(
			initialize,
			`expected a request to /mcp/cluster, got: ${JSON.stringify(server.requests)}`,
		);
		// CAMUNDA_AUTH_STRATEGY=NONE: no Authorization header even though the
		// default local profile would have sent demo:demo basic auth.
		assert.strictEqual(initialize.headers.authorization, undefined);
	});

	test("mcp-proxy keeps an invalid CAMUNDA_AUTH_STRATEGY error off stdout", async () => {
		dataDir = makeDataDir("text");

		const result = await asyncSpawn(
			"node",
			["--experimental-strip-types", CLI, "mcp-proxy"],
			{
				env: {
					...process.env,
					HOME: "/tmp/c8ctl-test-nonexistent-home",
					C8CTL_DATA_DIR: dataDir,
					CAMUNDA_BASE_URL: undefined,
					CAMUNDA_REST_ADDRESS: "http://127.0.0.1:1",
					CAMUNDA_AUTH_STRATEGY: "KERBEROS",
				},
			},
		);

		assert.strictEqual(result.status, 1, `stderr: ${result.stderr}`);
		// stdout is the MCP protocol channel — nothing may be written there.
		assert.strictEqual(result.stdout, "");
		assert.match(result.stderr, /CAMUNDA_AUTH_STRATEGY/);
	});

	test("deploy treats CAMUNDA_REST_ADDRESS as an environment-selected target", async () => {
		dataDir = makeDataDir();
		const env = {
			...process.env,
			HOME: "/tmp/c8ctl-test-nonexistent-home",
			C8CTL_DATA_DIR: dataDir,
			CAMUNDA_BASE_URL: undefined,
			CAMUNDA_REST_ADDRESS: undefined,
		};
		for (const name of ["one", "two"]) {
			const added = await asyncSpawn(
				"node",
				[
					"--experimental-strip-types",
					CLI,
					"add",
					"profile",
					name,
					`--baseUrl=http://${name}.example.com/v2`,
				],
				{ env },
			);
			assert.strictEqual(added.status, 0, `stderr: ${added.stderr}`);
		}

		// With several saved profiles and no active one, deploy only skips
		// its profile prompt when the environment selects the cluster.
		// --dry-run stops before any network I/O.
		const result = await asyncSpawn(
			"node",
			["--experimental-strip-types", CLI, "deploy", FIXTURE_BPMN, "--dry-run"],
			{
				env: {
					...env,
					CAMUNDA_REST_ADDRESS: "http://127.0.0.1:1",
				},
			},
		);

		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assert.doesNotMatch(result.stderr, /Multiple profiles configured/);
	});

	test("CAMUNDA_BASE_URL wins over CAMUNDA_REST_ADDRESS when both are set", async () => {
		server = await startCapturingJobServer();
		dataDir = makeDataDir();

		const result = await asyncSpawn(
			"node",
			["--experimental-strip-types", CLI, "activate", "jobs", "my-job-type"],
			{
				env: {
					...process.env,
					HOME: "/tmp/c8ctl-test-nonexistent-home",
					C8CTL_DATA_DIR: dataDir,
					CAMUNDA_BASE_URL: `${server.url}/v2`,
					CAMUNDA_REST_ADDRESS: "http://127.0.0.1:1",
					CAMUNDA_AUTH_STRATEGY: "NONE",
				},
			},
		);

		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const activation = server.requests.find((r) =>
			r.url?.endsWith("/jobs/activation"),
		);
		assert.ok(
			activation,
			`expected a request to the CAMUNDA_BASE_URL server, got: ${JSON.stringify(server.requests)}`,
		);
	});

	test("CAMUNDA_AUTH_STRATEGY=BASIC authenticates with CAMUNDA_USERNAME/CAMUNDA_PASSWORD", async () => {
		server = await startCapturingJobServer();
		dataDir = makeDataDir();

		const result = await asyncSpawn(
			"node",
			["--experimental-strip-types", CLI, "activate", "jobs", "my-job-type"],
			{
				env: {
					...process.env,
					HOME: "/tmp/c8ctl-test-nonexistent-home",
					C8CTL_DATA_DIR: dataDir,
					CAMUNDA_BASE_URL: `${server.url}/v2`,
					CAMUNDA_AUTH_STRATEGY: "BASIC",
					CAMUNDA_USERNAME: "alice",
					CAMUNDA_PASSWORD: "s3cret",
				},
			},
		);

		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		const activation = server.requests.find((r) =>
			r.url?.endsWith("/jobs/activation"),
		);
		assert.ok(activation, "expected a /jobs/activation request");
		assert.strictEqual(
			activation.headers.authorization,
			`Basic ${Buffer.from("alice:s3cret").toString("base64")}`,
		);
	});

	test("SDK-only credential vars without an address variable warn about the local fallback", async () => {
		dataDir = makeDataDir();

		const result = await asyncSpawn(
			"node",
			["--experimental-strip-types", CLI, "get", "topology"],
			{
				env: {
					...process.env,
					HOME: "/tmp/c8ctl-test-nonexistent-home",
					C8CTL_DATA_DIR: dataDir,
					CAMUNDA_BASE_URL: undefined,
					CAMUNDA_REST_ADDRESS: undefined,
					CAMUNDA_CLIENT_ID: "id",
					CAMUNDA_CLIENT_SECRET: "secret",
				},
			},
		);

		// The command itself fails (nothing listens on localhost:8080) — the
		// assertion is on the warning that explains why.
		assert.match(result.stderr, /CAMUNDA_CLIENT_ID/);
		assert.match(result.stderr, /CAMUNDA_BASE_URL|CAMUNDA_REST_ADDRESS/);
		assert.match(result.stderr, /localhost:8080/);
	});

	async function startCapturingJobServer(): Promise<{
		url: string;
		requests: CapturedRequest[];
		close: () => Promise<void>;
	}> {
		const requests: CapturedRequest[] = [];
		const jobServer: Server = createServer((req, res) => {
			requests.push({ method: req.method, url: req.url, headers: req.headers });
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ jobs: [MOCK_JOB] }));
		});
		await new Promise<void>((res, reject) => {
			jobServer.once("error", reject);
			jobServer.listen(0, "127.0.0.1", () => res());
		});
		const port = getServerPort(jobServer);
		return {
			url: `http://127.0.0.1:${port}`,
			requests,
			close: () => new Promise<void>((res) => jobServer.close(() => res())),
		};
	}
});
