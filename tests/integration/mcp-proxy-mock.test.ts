/**
 * Integration tests for MCP proxy with mock HTTP server
 */

import assert from "node:assert";
import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import { afterEach, beforeEach, describe, test } from "node:test";
import { createCamundaFetch } from "../../src/commands/mcp-proxy.ts";
import type { Logger } from "../../src/logger.ts";
import { makeMockClient, makeMockLogger } from "../utils/mocks.ts";

describe("MCP Proxy Mock Server Integration Tests", () => {
	let mockServer: Server;
	let mockServerUrl: string;
	let mockLogger: Logger;

	/**
	 * Stand up a mock HTTP server bound to a kernel-assigned port on
	 * 127.0.0.1 and publish its URL to `mockServerUrl`. See issue #316
	 * for why hardcoded or randomly-derived ports are unsafe (port
	 * collision → silent hang; landing on undici's restricted-ports
	 * list — e.g. 10080 — → `fetch failed: bad port`). The class-of-defect
	 * guard lives at `tests/unit/no-hardcoded-listen-port.test.ts`.
	 */
	async function startMockServer(
		handler: (req: IncomingMessage, res: ServerResponse) => void,
	): Promise<void> {
		mockServer = createServer(handler);
		await new Promise<void>((resolve) => {
			mockServer.listen(0, "127.0.0.1", () => resolve());
		});
		const addr = mockServer.address();
		if (!addr || typeof addr === "string") {
			throw new Error("mock server did not bind to an inet address");
		}
		mockServerUrl = `http://127.0.0.1:${addr.port}`;
	}

	beforeEach(() => {
		mockLogger = makeMockLogger();
	});

	afterEach(async () => {
		if (mockServer) {
			await new Promise<void>((resolve) => {
				mockServer.close(() => resolve());
			});
		}
	});

	test("sends auth headers to remote server", async () => {
		let capturedAuthHeader: string | string[] | undefined;

		await startMockServer((req: IncomingMessage, res: ServerResponse) => {
			capturedAuthHeader = req.headers.authorization;
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ success: true }));
		});

		const mockCamundaClient = makeMockClient({
			getAuthHeaders: async () => ({ Authorization: "Bearer test-token-123" }),
			getConfig: () => ({ restAddress: mockServerUrl }),
		});

		const customFetch = createCamundaFetch(mockCamundaClient, mockLogger);
		const response = await customFetch(`${mockServerUrl}/mcp/cluster`, {});

		assert.strictEqual(response.status, 200);
		assert.strictEqual(capturedAuthHeader, "Bearer test-token-123");
	});

	test("handles 404 response from server", async () => {
		await startMockServer((_req: IncomingMessage, res: ServerResponse) => {
			res.writeHead(404, { "Content-Type": "text/plain" });
			res.end("Not Found");
		});

		const mockCamundaClient = makeMockClient({
			getAuthHeaders: async () => ({}),
			getConfig: () => ({ restAddress: mockServerUrl }),
		});

		const customFetch = createCamundaFetch(mockCamundaClient, mockLogger);
		const response = await customFetch(`${mockServerUrl}/mcp/cluster`, {});

		assert.strictEqual(response.status, 404);
	});

	test("handles 500 error from server", async () => {
		await startMockServer((_req: IncomingMessage, res: ServerResponse) => {
			res.writeHead(500, { "Content-Type": "text/plain" });
			res.end("Internal Server Error");
		});

		const mockCamundaClient = makeMockClient({
			getAuthHeaders: async () => ({}),
			getConfig: () => ({ restAddress: mockServerUrl }),
		});

		const customFetch = createCamundaFetch(mockCamundaClient, mockLogger);
		const response = await customFetch(`${mockServerUrl}/mcp/cluster`, {});

		assert.strictEqual(response.status, 500);
	});

	test("performs 401 retry with fresh token end-to-end", async () => {
		let requestCount = 0;
		let firstAuthHeader: string | string[] | undefined;
		let secondAuthHeader: string | string[] | undefined;

		await startMockServer((req: IncomingMessage, res: ServerResponse) => {
			if (requestCount === 0) {
				firstAuthHeader = req.headers.authorization;
				requestCount++;
				res.writeHead(401, { "Content-Type": "text/plain" });
				res.end("Unauthorized");
			} else {
				secondAuthHeader = req.headers.authorization;
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ success: true }));
			}
		});

		const mockCamundaClient = makeMockClient({
			getAuthHeaders: async () => ({
				Authorization:
					requestCount === 0 ? "Bearer expired-token" : "Bearer fresh-token",
			}),
			forceAuthRefresh: async () => {},
			getConfig: () => ({ restAddress: mockServerUrl }),
		});

		const customFetch = createCamundaFetch(mockCamundaClient, mockLogger);
		const response = await customFetch(`${mockServerUrl}/mcp/cluster`, {});

		assert.strictEqual(response.status, 200);
		assert.strictEqual(firstAuthHeader, "Bearer expired-token");
		assert.strictEqual(secondAuthHeader, "Bearer fresh-token");
	});

	test("handles connection refused error", async () => {
		// Don't start server - connection will be refused
		const unreachablePort = 9999;

		const mockCamundaClient = makeMockClient({
			getAuthHeaders: async () => ({}),
			getConfig: () => ({
				restAddress: `http://localhost:${unreachablePort}`,
			}),
		});

		const customFetch = createCamundaFetch(mockCamundaClient, mockLogger);

		await assert.rejects(
			async () =>
				await customFetch(
					`http://localhost:${unreachablePort}/mcp/cluster`,
					{},
				),
			(error: Error) => {
				assert.match(error.message, /Connection refused/);
				assert.match(
					error.message,
					new RegExp(`http://localhost:${unreachablePort}`),
				);
				return true;
			},
		);
	});

	test("handles slow server response with timeout", async () => {
		await startMockServer(
			async (_req: IncomingMessage, res: ServerResponse) => {
				// Simulate slow response (200ms)
				await new Promise((resolve) => setTimeout(resolve, 200));
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ success: true }));
			},
		);

		const mockCamundaClient = makeMockClient({
			getAuthHeaders: async () => ({}),
			getConfig: () => ({ restAddress: mockServerUrl }),
		});

		// Set timeout to 100ms (shorter than server response time)
		const customFetch = createCamundaFetch(mockCamundaClient, mockLogger, 100);

		await assert.rejects(
			async () => await customFetch(`${mockServerUrl}/mcp/cluster`, {}),
			(error: Error) => {
				assert.strictEqual(error.message, "Request timeout after 100ms");
				return true;
			},
		);
	});

	test("successfully completes request within timeout", async () => {
		await startMockServer((_req: IncomingMessage, res: ServerResponse) => {
			// Fast response
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ success: true }));
		});

		const mockCamundaClient = makeMockClient({
			getAuthHeaders: async () => ({}),
			getConfig: () => ({ restAddress: mockServerUrl }),
		});

		// Set generous timeout
		const customFetch = createCamundaFetch(mockCamundaClient, mockLogger, 5000);
		const response = await customFetch(`${mockServerUrl}/mcp/cluster`, {});

		assert.strictEqual(response.status, 200);
		const data = await response.json();
		assert.deepStrictEqual(data, { success: true });
	});

	test("sends custom request headers to server", async () => {
		let capturedContentType: string | string[] | undefined;
		let capturedCustomHeader: string | string[] | undefined;

		await startMockServer((req: IncomingMessage, res: ServerResponse) => {
			capturedContentType = req.headers["content-type"];
			capturedCustomHeader = req.headers["x-custom-header"];
			res.writeHead(200);
			res.end();
		});

		const mockCamundaClient = makeMockClient({
			getAuthHeaders: async () => ({}),
			getConfig: () => ({ restAddress: mockServerUrl }),
		});

		const customFetch = createCamundaFetch(mockCamundaClient, mockLogger);
		await customFetch(`${mockServerUrl}/api`, {
			headers: {
				"Content-Type": "application/json",
				"X-Custom-Header": "test-value",
			},
		});

		assert.strictEqual(capturedContentType, "application/json");
		assert.strictEqual(capturedCustomHeader, "test-value");
	});

	test("handles POST request with body", async () => {
		let capturedBody = "";
		let capturedMethod: string | undefined;

		await startMockServer((req: IncomingMessage, res: ServerResponse) => {
			capturedMethod = req.method;
			req.on("data", (chunk) => {
				capturedBody += chunk.toString();
			});
			req.on("end", () => {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ received: true }));
			});
		});

		const mockCamundaClient = makeMockClient({
			getAuthHeaders: async () => ({}),
			getConfig: () => ({ restAddress: mockServerUrl }),
		});

		const customFetch = createCamundaFetch(mockCamundaClient, mockLogger);
		const requestBody = JSON.stringify({ test: "data" });

		const response = await customFetch(`${mockServerUrl}/api`, {
			method: "POST",
			body: requestBody,
			headers: { "Content-Type": "application/json" },
		});

		assert.strictEqual(response.status, 200);
		assert.strictEqual(capturedMethod, "POST");
		assert.strictEqual(capturedBody, requestBody);
	});
});
