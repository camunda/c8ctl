/**
 * CLI behavioural smoke tests for `c8ctl cluster start`.
 *
 * These tests exercise the full dispatch path by spawning the CLI
 * as a subprocess. They verify that error output is clear and actionable
 * when cluster startup fails, and that `--verbose` reaches the download.
 * Download behaviour itself (retry, resume, messages, diagnostics) is
 * unit-tested in `cluster-download.test.ts` and not re-asserted here.
 *
 * The download center is redirected via C8CTL_C8RUN_DOWNLOAD_URL to a local
 * endpoint so the outcome never depends on reaching downloads.camunda.cloud
 * (#598).
 */

import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { c8WithEnv } from "../utils/cli.ts";
import { listenOnLoopback, sendHalfThenDrop } from "../utils/http-server.ts";

describe("CLI behavioural: cluster start failure", () => {
	let server: Server;
	let baseUrl: string;

	before(async () => {
		server = createServer((_req, res) => {
			res.writeHead(404);
			res.end("Not Found");
		});
		baseUrl = `http://127.0.0.1:${await listenOnLoopback(server)}/c8run/`;
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
		const port = await listenOnLoopback(closed);
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

	test("start with a malformed C8CTL_C8RUN_DOWNLOAD_URL names the variable instead of throwing Invalid URL", async () => {
		const result = await c8WithEnv(
			{ C8CTL_C8RUN_DOWNLOAD_URL: "not a url/" },
			"cluster",
			"start",
			"--c8-version",
			"0.0.0-nonexistent",
		);

		const combined = result.stdout + result.stderr;
		assert.strictEqual(result.status, 1, combined);
		assert.match(
			combined,
			/Cannot download from \(invalid URL\): not a valid URL\. Check C8CTL_C8RUN_DOWNLOAD_URL\./,
		);
		assert.doesNotMatch(combined, /TypeError/);
	});
});

describe("CLI behavioural: cluster start with a dropping download", () => {
	let server: Server;
	let baseUrl: string;
	let cacheDir: string;

	before(async () => {
		// Every response sends half the archive and then kills the socket, so
		// every attempt fails like the reported "TypeError: terminated".
		const payload = Buffer.alloc(64 * 1024, 1);
		server = createServer((_req, res) =>
			sendHalfThenDrop(res, payload, { etag: '"c8run-drop"' }),
		);
		baseUrl = `http://127.0.0.1:${await listenOnLoopback(server)}/c8run/`;
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

	test("start exits 1 and prints the download failure with its cause and the manual-download hint", async () => {
		const result = await start();

		const combined = result.stdout + result.stderr;
		assert.strictEqual(result.status, 1, combined);
		assert.match(combined, /Failed to start cluster: Error: Download failed /);
		assert.match(combined, /Cause: (UND_ERR_SOCKET|ECONNRESET): /);
		// Supplied by the handler, not by downloadWithRetry.
		assert.match(
			combined,
			/Or download camunda8-run-0\.0\.0-drop-\S+ yourself/,
		);
		assert.ok(
			!combined.includes("[verbose]"),
			`no download diagnostics without --verbose:\n${combined}`,
		);
	});

	test("start --verbose turns on the download diagnostics", async () => {
		const result = await start("--verbose");

		const combined = result.stdout + result.stderr;
		assert.strictEqual(result.status, 1, combined);
		assert.ok(
			combined.includes(`[verbose] Download URL: ${baseUrl}0.0.0-drop/`),
			`Expected the download diagnostics in --verbose output, got:\n${combined}`,
		);
	});
});
