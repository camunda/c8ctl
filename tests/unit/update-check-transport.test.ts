/**
 * Update-check transport must never keep the process alive: a stalled
 * registry connection is unref'd, and aborting it closes the socket.
 *
 * A plain TCP server that accepts but never answers stalls the TLS
 * handshake, which is the same shape as an unresponsive registry.
 */

import assert from "node:assert";
import { createServer, type Server, type Socket } from "node:net";
import { afterEach, beforeEach, describe, test } from "node:test";
import { httpsTransport } from "../../src/core/update-check.ts";

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

	// The CLI aborts from a microtask chain, before Node's nextTick hands the
	// socket to the request. A pooling agent then keeps the orphaned socket
	// (connecting, ref'd) until its 5s idle timeout — against a blackholed
	// registry that held every command open for 5s.
	test("abort before the socket is assigned closes the socket", async () => {
		const controller = new AbortController();
		const pending = httpsTransport(url, { signal: controller.signal });
		controller.abort();
		await assert.rejects(pending, { name: "AbortError" });
		// Either no connection is made at all, or it is closed right away.
		const closed = onConnection.then(
			(s) => new Promise((r) => s.once("close", r)),
		);
		await Promise.race([closed, new Promise((r) => setTimeout(r, 500))]);
		assert.ok(
			sockets.every((s) => s.closed),
			"socket outlived the aborted request",
		);
	});
});
