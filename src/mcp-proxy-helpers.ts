/**
 * Pure helpers extracted from `src/commands/mcp-proxy.ts` so tests can
 * import them without violating the test→commands import boundary
 * (#291). The handler itself remains in `src/commands/mcp-proxy.ts`.
 */

import type { CamundaClient } from "@camunda8/orchestration-cluster-api";
import { isRecord, type Logger } from "./logger.ts";

/**
 * Creates a custom fetch function that injects Camunda authentication headers
 * and handles token refresh on 401 errors.
 *
 * @param camundaClient - The Camunda client instance for auth
 * @param timeout - Request timeout in milliseconds (default: 60000)
 * @returns Custom fetch function compatible with MCP SDK transport
 */
export function createCamundaFetch(
	camundaClient: CamundaClient,
	logger: Logger,
	timeout: number = 60000,
): typeof fetch {
	return async (
		input: string | URL | Request,
		init?: RequestInit,
	): Promise<Response> => {
		// Get fresh auth headers from orchestration-cluster-api
		const authHeaders = await camundaClient.getAuthHeaders();

		// Merge with existing headers
		const headers = new Headers(init?.headers);
		Object.entries(authHeaders).forEach(([key, value]) => {
			headers.set(key, value);
		});

		// Create timeout abort controller
		const timeoutController = new AbortController();
		const timeoutId = setTimeout(() => timeoutController.abort(), timeout);

		try {
			// Merge abort signals (SDK's signal + timeout signal)
			const signal = init?.signal
				? AbortSignal.any([init.signal, timeoutController.signal])
				: timeoutController.signal;

			// Make the request with merged headers
			const response = await fetch(input, { ...init, headers, signal });

			// Handle 401 with token refresh and retry
			if (response.status === 401) {
				clearTimeout(timeoutId);

				logger.info(
					"Received 401 (Unauthorized) response, attempting token refresh and retrying",
				);

				// Force token refresh and rebuild headers
				await camundaClient.forceAuthRefresh();
				const freshHeaders = await camundaClient.getAuthHeaders();
				const retryHeaders = new Headers(init?.headers);
				Object.entries(freshHeaders).forEach(([key, value]) => {
					retryHeaders.set(key, value);
				});

				// Retry with fresh token and timeout
				const retryTimeoutController = new AbortController();
				const retryTimeoutId = setTimeout(
					() => retryTimeoutController.abort(),
					timeout,
				);

				try {
					const retrySignal = init?.signal
						? AbortSignal.any([init.signal, retryTimeoutController.signal])
						: retryTimeoutController.signal;

					return await fetch(input, {
						...init,
						headers: retryHeaders,
						signal: retrySignal,
					});
				} finally {
					clearTimeout(retryTimeoutId);
				}
			}

			clearTimeout(timeoutId);
			return response;
		} catch (error) {
			clearTimeout(timeoutId);

			// Convert AbortError to more descriptive timeout error
			if (error instanceof Error && error.name === "AbortError") {
				throw new Error(`Request timeout after ${timeout}ms`);
			}

			// Walk the cause chain to handle both Node 22 (shallow) and Node 24 (deeper nesting)
			let cause: unknown = error instanceof Error ? error.cause : undefined;
			while (cause != null) {
				if (isRecord(cause) && cause.code === "ECONNREFUSED") {
					const url = typeof input === "string" ? input : input.toString();
					throw new Error(
						`Connection refused: Unable to connect to ${url}. Please verify the server is running and accessible.`,
					);
				}
				cause = isRecord(cause) ? cause.cause : undefined;
			}

			throw error;
		}
	};
}

/**
 * Normalize remote MCP URL to ensure it points to the MCP endpoint (assuming it ends with /mcp/cluster).
 * - If URL has no path or just "/", append "/mcp/cluster"
 * - If URL ends with "/v2" or "/v2/", replace with "/mcp/cluster"
 */
export function normalizeRemoteMcpUrl(
	url: string,
	mcpServerPath: string,
): string {
	try {
		const urlObj = new URL(url);

		// If path is empty or just "/", append MCP server path
		if (urlObj.pathname === "" || urlObj.pathname === "/") {
			urlObj.pathname = mcpServerPath;
			return urlObj.toString();
		}

		// If path ends with "/v2" (with or without trailing slash), replace with MCP server path
		if (urlObj.pathname.match(/\/v2\/?$/)) {
			urlObj.pathname = urlObj.pathname.replace(/\/v2\/?$/, mcpServerPath);
			return urlObj.toString();
		}

		// Already ends with MCP server path or has custom path - keep as is
		return url;
	} catch (_e) {
		return url;
	}
}
