/**
 * Local HTTP server fixtures for tests that need a real socket rather than a
 * fetch mock — e.g. to reproduce the errors undici actually raises when a
 * connection is dropped mid-body.
 */

import type { Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Bind `server` to a kernel-assigned port on 127.0.0.1 and resolve with it.
 * Port 0 never collides and never hits a "bad port".
 */
export function listenOnLoopback(server: Server): Promise<number> {
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

/**
 * Answer 200 announcing the full `payload`, send its first half, then destroy
 * the socket — the shape of a connection dropped by a proxy or load balancer,
 * which undici surfaces as `TypeError: terminated`.
 */
export function sendHalfThenDrop(
	res: ServerResponse,
	payload: Buffer,
	headers: Record<string, string> = {},
): void {
	res.writeHead(200, { "content-length": payload.length, ...headers });
	res.write(payload.subarray(0, Math.floor(payload.length / 2)), () => {
		setTimeout(() => res.socket?.destroy(), 20);
	});
}
