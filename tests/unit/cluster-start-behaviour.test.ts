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
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
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
			{ C8CTL_C8RUN_DOWNLOAD_URL: `http://127.0.0.1:${port}/c8run/` },
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
