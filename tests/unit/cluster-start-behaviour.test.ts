/**
 * CLI behavioural smoke tests for `c8ctl cluster start`.
 *
 * These tests exercise the full dispatch path by spawning the CLI
 * as a subprocess. They verify that error output is clear and actionable
 * when cluster startup fails.
 *
 * The download center is redirected via C8CTL_C8RUN_DOWNLOAD_URL to a local
 * endpoint so the outcome never depends on reaching downloads.camunda.cloud
 * (#598).
 */

import assert from "node:assert";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { c8WithEnv } from "../utils/cli.ts";

function listen(server: Server): Promise<number> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (address === null || typeof address === "string") {
				reject(new Error("Expected a TCP address"));
				return;
			}
			resolve((address satisfies AddressInfo).port);
		});
	});
}

describe("CLI behavioural: cluster start failure", () => {
	let server: Server;
	let baseUrl: string;

	before(async () => {
		server = createServer((_req, res) => {
			res.writeHead(404);
			res.end("Not Found");
		});
		baseUrl = `http://127.0.0.1:${await listen(server)}/c8run/`;
	});

	after(() => {
		server.close();
	});

	test("start with nonexistent version exits with error and logs actionable message", async () => {
		const result = await c8WithEnv(
			{ C8CTL_C8RUN_DOWNLOAD_URL: baseUrl },
			"cluster",
			"start",
			"--c8-version",
			"0.0.0-nonexistent",
		);

		assert.notStrictEqual(result.status, 0, "Should exit with non-zero status");
		const combined = result.stdout + result.stderr;
		assert.ok(
			combined.includes("Failed to start cluster"),
			`Expected "Failed to start cluster" in output, got:\n${combined}`,
		);
		assert.ok(
			combined.includes("HTTP 404"),
			`Expected HTTP 404 path in output, got:\n${combined}`,
		);
		assert.ok(
			combined.includes("check the version exists") ||
				combined.includes("try a different version"),
			`Expected actionable hint in output, got:\n${combined}`,
		);
	});

	test("start when download center is unreachable logs a connectivity hint", async () => {
		// Bind then close a server to obtain a port that refuses connections.
		const closed = createServer();
		const port = await listen(closed);
		await new Promise<void>((resolve) => closed.close(() => resolve()));

		const result = await c8WithEnv(
			{
				C8CTL_C8RUN_DOWNLOAD_URL: `http://127.0.0.1:${port}/c8run/`,
				// Connection failures are retried; keep the backoff short.
				C8CTL_C8RUN_DOWNLOAD_RETRY_DELAY_MS: "1",
			},
			"cluster",
			"start",
			"--c8-version",
			"0.0.0-nonexistent",
		);

		assert.notStrictEqual(result.status, 0, "Should exit with non-zero status");
		const combined = result.stdout + result.stderr;
		assert.ok(
			combined.includes("Cannot reach the Camunda Download Center"),
			`Expected network-failure path in output, got:\n${combined}`,
		);
		assert.ok(
			combined.includes("check your network connection"),
			`Expected connectivity hint in output, got:\n${combined}`,
		);
	});
});

describe("CLI behavioural: cluster start with a dropping download", () => {
	const PAYLOAD = Buffer.alloc(2 * 1024 * 1024, 1);
	let server: Server;
	let baseUrl: string;
	let requests = 0;
	let cacheDir: string;

	before(async () => {
		// Every response announces the full archive, sends half, then kills
		// the socket — the shape of the reported "TypeError: terminated".
		server = createServer((_req, res) => {
			requests++;
			res.writeHead(200, {
				"content-length": PAYLOAD.length,
				etag: '"c8run-drop"',
			});
			res.write(PAYLOAD.subarray(0, PAYLOAD.length / 2), () => {
				setTimeout(() => res.socket?.destroy(), 20);
			});
		});
		baseUrl = `http://127.0.0.1:${await listen(server)}/c8run/`;
		cacheDir = mkdtempSync(join(tmpdir(), "c8ctl-cluster-drop-"));
	});

	after(() => {
		server.close();
		rmSync(cacheDir, { recursive: true, force: true });
	});

	const start = (...extra: string[]) =>
		c8WithEnv(
			{
				C8CTL_C8RUN_DOWNLOAD_URL: baseUrl,
				C8CTL_C8RUN_DOWNLOAD_RETRY_DELAY_MS: "1",
				C8RUN_CACHE_DIR: cacheDir,
			},
			"cluster",
			"start",
			"--c8-version",
			"0.0.0-drop",
			...extra,
		);

	test("retries 3 times, then fails with the cause, the URL and actionable hints", async () => {
		requests = 0;
		const result = await start();

		assert.notStrictEqual(result.status, 0, "Should exit with non-zero status");
		const combined = result.stdout + result.stderr;
		assert.strictEqual(requests, 4, `expected 1 + 3 attempts:\n${combined}`);
		for (const expected of [
			"Retrying (1/3)",
			"Retrying (3/3)",
			"Failed to start cluster",
			"Download failed after 4 attempts",
			`${baseUrl}0.0.0-drop/`,
			"NODE_USE_ENV_PROXY=1",
			"C8CTL_C8RUN_DOWNLOAD_URL",
		]) {
			assert.ok(
				combined.includes(expected),
				`Expected "${expected}" in output, got:\n${combined}`,
			);
		}
		assert.match(
			combined,
			/the connection was (closed by the server or a proxy|closed unexpectedly)/,
		);
		assert.ok(
			!combined.includes("[verbose]"),
			`verbose diagnostics must not appear without --verbose:\n${combined}`,
		);
		assert.deepStrictEqual(
			readdirSync(cacheDir).filter((f) => /\.(zip|tar\.gz)$/.test(f)),
			[],
			"the incomplete archive must be removed",
		);
	});

	test("--verbose adds HTTP download diagnostics", async () => {
		const result = await start("--verbose");

		assert.notStrictEqual(result.status, 0, "Should exit with non-zero status");
		const combined = result.stdout + result.stderr;
		for (const expected of [
			"[verbose] Download URL: ",
			"[verbose] Node.js v",
			"NODE_USE_ENV_PROXY=",
			"[verbose] Proxy environment: ",
			"[verbose] Attempt 1/4 started",
			"[verbose] Request headers: Range: bytes=",
			"[verbose] Response: HTTP 200 OK",
			"[verbose] Response headers: content-length: ",
			"[verbose]   caused by: TypeError: terminated",
			"[verbose] Attempt 4/4 failed after ",
		]) {
			assert.ok(
				combined.includes(expected),
				`Expected "${expected}" in --verbose output, got:\n${combined}`,
			);
		}
	});
});
