/**
 * Unit tests for `buildGatewayFetch` (src/core/client.ts).
 *
 * `buildGatewayFetch` wraps the fetch implementation the Camunda 8 SDK uses
 * for every REST request under a profile, so a gateway-fronted profile can:
 *   - attach custom headers to every request (issue #547)
 *   - target its `baseUrl` exactly, undoing the SDK's automatic `/v2`
 *     suffixing (issue #547)
 *
 * These tests exercise the wrapper directly with a fake delegate fetch that
 * records the final `Request` it receives, so no network access or real SDK
 * client construction is required.
 */

import assert from "node:assert";
import { describe, test } from "node:test";
import { buildGatewayFetch } from "../../src/core/client.ts";

/** Build a delegate fetch that records every Request it's called with. */
function recordingDelegate(): {
	delegate: (
		input: string | URL | Request,
		init?: RequestInit,
	) => Promise<Response>;
	requests: Request[];
} {
	const requests: Request[] = [];
	const delegate = async (
		input: string | URL | Request,
		init?: RequestInit,
	): Promise<Response> => {
		const request =
			input instanceof Request && init === undefined
				? input
				: new Request(input, init);
		requests.push(request);
		return new Response(null, { status: 200 });
	};
	return { delegate, requests };
}

describe("buildGatewayFetch", () => {
	describe("headers", () => {
		test("attaches a custom header to a GET request", async () => {
			const { delegate, requests } = recordingDelegate();
			const gatewayFetch = buildGatewayFetch({
				baseUrl: "http://localhost:8080/v2",
				headers: { "X-Api-Key": "secret" },
				delegate,
			});

			await gatewayFetch(
				new Request("http://localhost:8080/v2/process-instances/search", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: "{}",
				}),
			);

			assert.strictEqual(requests.length, 1);
			assert.strictEqual(requests[0].headers.get("X-Api-Key"), "secret");
			// Existing headers are preserved alongside the custom one.
			assert.strictEqual(
				requests[0].headers.get("Content-Type"),
				"application/json",
			);
		});

		test("attaches multiple custom headers", async () => {
			const { delegate, requests } = recordingDelegate();
			const gatewayFetch = buildGatewayFetch({
				baseUrl: "http://localhost:8080/v2",
				headers: { "X-Api-Key": "secret", "X-Correlation-Id": "abc-123" },
				delegate,
			});

			await gatewayFetch(new Request("http://localhost:8080/v2/topology"));

			assert.strictEqual(requests[0].headers.get("X-Api-Key"), "secret");
			assert.strictEqual(
				requests[0].headers.get("X-Correlation-Id"),
				"abc-123",
			);
		});

		test("a custom header overrides an existing header of the same name", async () => {
			const { delegate, requests } = recordingDelegate();
			const gatewayFetch = buildGatewayFetch({
				baseUrl: "http://localhost:8080/v2",
				headers: { Authorization: "Bearer gateway-token" },
				delegate,
			});

			await gatewayFetch(
				new Request("http://localhost:8080/v2/topology", {
					headers: { Authorization: "Basic dXNlcjpwYXNz" },
				}),
			);

			assert.strictEqual(
				requests[0].headers.get("Authorization"),
				"Bearer gateway-token",
			);
		});

		test("does not mutate the request when no headers are configured", async () => {
			const { delegate, requests } = recordingDelegate();
			const gatewayFetch = buildGatewayFetch({
				baseUrl: "http://localhost:8080/v2",
				delegate,
			});

			await gatewayFetch(
				new Request("http://localhost:8080/v2/topology", {
					headers: { "X-Existing": "1" },
				}),
			);

			assert.strictEqual(requests[0].headers.get("X-Existing"), "1");
			assert.strictEqual(requests[0].url, "http://localhost:8080/v2/topology");
		});
	});

	describe("exactBaseUrl", () => {
		test("strips the auto-appended /v2 when baseUrl has no /v2 suffix", async () => {
			const { delegate, requests } = recordingDelegate();
			const gatewayFetch = buildGatewayFetch({
				baseUrl: "https://gateway.example.com/camunda-api",
				exactBaseUrl: true,
				delegate,
			});

			// Simulates the SDK having auto-appended /v2 to the configured
			// baseUrl before building this request.
			await gatewayFetch(
				new Request(
					"https://gateway.example.com/camunda-api/v2/process-instances/search",
					{ method: "GET" },
				),
			);

			assert.strictEqual(
				requests[0].url,
				"https://gateway.example.com/camunda-api/process-instances/search",
			);
		});

		test("leaves the URL untouched when baseUrl already ends with /v2", async () => {
			const { delegate, requests } = recordingDelegate();
			const gatewayFetch = buildGatewayFetch({
				baseUrl: "https://gateway.example.com/camunda-api/v2",
				exactBaseUrl: true,
				delegate,
			});

			await gatewayFetch(
				new Request(
					"https://gateway.example.com/camunda-api/v2/process-instances/search",
					{ method: "GET" },
				),
			);

			assert.strictEqual(
				requests[0].url,
				"https://gateway.example.com/camunda-api/v2/process-instances/search",
			);
		});

		test("does not rewrite the URL when exactBaseUrl is not set", async () => {
			const { delegate, requests } = recordingDelegate();
			const gatewayFetch = buildGatewayFetch({
				baseUrl: "https://gateway.example.com/camunda-api",
				headers: { "X-Api-Key": "secret" },
				delegate,
			});

			await gatewayFetch(
				new Request(
					"https://gateway.example.com/camunda-api/v2/process-instances/search",
				),
			);

			assert.strictEqual(
				requests[0].url,
				"https://gateway.example.com/camunda-api/v2/process-instances/search",
			);
		});

		test("preserves method and JSON body across the URL rewrite", async () => {
			const { delegate, requests } = recordingDelegate();
			const gatewayFetch = buildGatewayFetch({
				baseUrl: "https://gateway.example.com/camunda-api",
				exactBaseUrl: true,
				delegate,
			});

			await gatewayFetch(
				new Request(
					"https://gateway.example.com/camunda-api/v2/process-instances/search",
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ filter: { processDefinitionKey: "1" } }),
					},
				),
			);

			const forwarded = requests[0];
			assert.strictEqual(
				forwarded.url,
				"https://gateway.example.com/camunda-api/process-instances/search",
			);
			assert.strictEqual(forwarded.method, "POST");
			const body = await forwarded.json();
			assert.deepStrictEqual(body, { filter: { processDefinitionKey: "1" } });
		});

		test("does not rewrite a URL that doesn't match the SDK-computed base", async () => {
			const { delegate, requests } = recordingDelegate();
			const gatewayFetch = buildGatewayFetch({
				baseUrl: "https://gateway.example.com/camunda-api",
				exactBaseUrl: true,
				delegate,
			});

			// A URL that never went through the expected .../v2 prefix — the
			// wrapper conservatively leaves it alone rather than guessing.
			await gatewayFetch(
				new Request("https://gateway.example.com/other-path/topology"),
			);

			assert.strictEqual(
				requests[0].url,
				"https://gateway.example.com/other-path/topology",
			);
		});

		test("combines header injection with the exactBaseUrl rewrite", async () => {
			const { delegate, requests } = recordingDelegate();
			const gatewayFetch = buildGatewayFetch({
				baseUrl: "https://gateway.example.com/camunda-api",
				headers: { "X-Api-Key": "secret" },
				exactBaseUrl: true,
				delegate,
			});

			await gatewayFetch(
				new Request("https://gateway.example.com/camunda-api/v2/topology"),
			);

			assert.strictEqual(
				requests[0].url,
				"https://gateway.example.com/camunda-api/topology",
			);
			assert.strictEqual(requests[0].headers.get("X-Api-Key"), "secret");
		});
	});
});
