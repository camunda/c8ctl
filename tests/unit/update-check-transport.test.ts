/**
 * Update-check transport must never keep the process alive: a stalled
 * registry connection is unref'd, and aborting it closes the socket.
 *
 * A plain TCP server that accepts but never answers stalls the TLS
 * handshake, which is the same shape as an unresponsive registry.
 */

import assert from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { pathToFileURL } from "node:url";
import { httpsTransport } from "../../src/core/update-check.ts";
import { asyncSpawn } from "../utils/spawn.ts";

let server: Server;
let url: string;
let sockets: Socket[];
let onConnection: Promise<Socket>;

beforeEach(async () => {
	sockets = [];
	let resolveConn: (s: Socket) => void = () => {};
	onConnection = new Promise((r) => {
		resolveConn = r;
	});
	server = createServer((socket) => {
		socket.unref();
		sockets.push(socket);
		resolveConn(socket);
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	url = `https://127.0.0.1:${address.port}/`;
});

afterEach(async () => {
	for (const s of sockets) s.destroy();
	await new Promise((r) => server.close(r));
});

const refedSockets = () =>
	process.getActiveResourcesInfo().filter((r) => r === "TCPSocketWrap").length;

describe("httpsTransport", () => {
	test("stalled connection does not hold the event loop", async () => {
		const before = refedSockets();
		const controller = new AbortController();
		const pending = httpsTransport(url, { signal: controller.signal });
		await onConnection;
		assert.strictEqual(refedSockets(), before);
		controller.abort();
		await assert.rejects(pending);
	});

	test("abort rejects promptly and closes the socket", async () => {
		const controller = new AbortController();
		const pending = httpsTransport(url, { signal: controller.signal });
		const serverSide = await onConnection;
		const closed = new Promise((r) => serverSide.once("close", r));
		const start = Date.now();
		controller.abort();
		await assert.rejects(pending, { name: "AbortError" });
		assert.ok(Date.now() - start < 1000);
		await closed;
	});
});

describe("CLI exit with stalled registry", () => {
	test("c8 --version exits promptly instead of waiting on the registry", async () => {
		const dir = mkdtempSync(join(tmpdir(), "c8ctl-update-exit-"));
		// Skip the once-per-day patient wait so the impatient abort path runs.
		writeFileSync(
			join(dir, "last-update-notification.json"),
			JSON.stringify({ lastPatientCheck: Date.now() }),
		);
		// Pretend to be a released build and route the registry to the stall server.
		const preload = join(dir, "preload.mjs");
		const runtimeUrl = pathToFileURL(resolve("src/core/runtime.ts")).href;
		writeFileSync(
			preload,
			[
				'import https from "node:https";',
				'import { syncBuiltinESMExports } from "node:module";',
				"const get = https.get;",
				"https.get = (_url, ...rest) => get(process.env.STALL_URL, ...rest);",
				"syncBuiltinESMExports();",
				`const { c8ctl } = await import(${JSON.stringify(runtimeUrl)});`,
				'c8ctl.env.version = "1.0.0";',
			].join("\n"),
		);

		const start = Date.now();
		const result = await asyncSpawn(
			"node",
			[
				"--experimental-strip-types",
				"--import",
				pathToFileURL(preload).href,
				"src/index.ts",
				"--version",
			],
			{
				env: { ...process.env, C8CTL_DATA_DIR: dir, CI: "", STALL_URL: url },
				// Safety net only; the assertion below is the correctness signal.
				timeout: 30_000,
			},
		);
		const elapsed = Date.now() - start;

		assert.strictEqual(result.status, 0, result.stderr);
		assert.match(result.stdout, /c8ctl v/);
		await onConnection;
		assert.ok(elapsed < 5000, `exit took ${elapsed}ms`);
	});
});
