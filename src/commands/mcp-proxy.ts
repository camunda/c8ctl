import type { CamundaClient } from "@camunda8/orchestration-cluster-api";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
	StreamableHTTPClientTransport,
	StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createClient } from "../client.ts";
import { defineCommand } from "../command-framework.ts";
import { normalizeToError } from "../errors.ts";
import { isRecord, Logger, type LogWriter } from "../logger.ts";
import {
	createCamundaFetch,
	normalizeRemoteMcpUrl,
} from "../mcp-proxy-helpers.ts";
import { c8ctl } from "../runtime.ts";
import { getVersion } from "./help.ts";

/**
 * MCP Proxy that bridges STDIO (local) to HTTP (remote) with Camunda authentication.
 *
 * Architecture:
 * - Local STDIO: MCP Server receives requests from MCP clients (e.g., Claude Desktop)
 * - Remote HTTP: MCP Client sends requests to remote MCP server via StreamableHTTP transport
 * - Authentication: Custom fetch wrapper injects Camunda auth headers (OAuth or Basic)
 *
 * Flow: MCP Client (STDIO) → Server → Client → StreamableHTTP + CamundaAuth → Remote MCP Server
 */
class McpProxy {
	private camundaClient: CamundaClient;
	private logger: Logger;

	private mcpRemoteUrl: string;

	private client: Client;
	private clientTransport: StreamableHTTPClientTransport;

	private mcpServer: McpServer;
	private serverTransport: StdioServerTransport | null = null;

	constructor(
		camundaClient: CamundaClient,
		logger: Logger,
		mcpServerPath: string,
	) {
		this.camundaClient = camundaClient;
		this.logger = logger;

		this.mcpRemoteUrl = normalizeRemoteMcpUrl(
			this.camundaClient.getConfig().restAddress,
			mcpServerPath,
		);

		// Create transport to remote MCP server including custom fetch for Camunda authentication
		this.clientTransport = new StreamableHTTPClientTransport(
			new URL(this.mcpRemoteUrl),
			{
				fetch: createCamundaFetch(this.camundaClient, this.logger),
			},
		);

		const version = getVersion();

		// Create MCP client to call remote server
		this.client = new Client(
			{ name: "c8ctl-mcp-proxy", version },
			{ capabilities: {} },
		);

		// Initialize MCP server for STDIO (stateless mode - tools only)
		this.mcpServer = new McpServer(
			{
				name: "c8ctl-mcp-proxy",
				version,
			},
			{
				capabilities: {
					// Only advertise tools capability
					tools: {},
				},
			},
		);
	}

	/**
	 * Start the proxy server
	 */
	async start(): Promise<void> {
		this.logger.info("Starting MCP proxy...");
		this.logger.info(
			`Connecting to remote MCP server at: ${this.mcpRemoteUrl}`,
		);

		try {
			// Verify authentication works by getting auth headers
			const authStrategy = this.camundaClient.getConfig().auth.strategy;
			if (authStrategy !== "NONE") {
				this.logger.debug(`Resolving ${authStrategy} authentication...`);
				await this.camundaClient.getAuthHeaders();
				this.logger.debug(
					`${authStrategy} authentication resolved successfully`,
				);
			} else {
				this.logger.info("No authentication configured (auth.strategy=NONE)");
			}

			// Connect client to remote server
			this.logger.debug("Connecting to remote MCP server");
			await this.client.connect(this.clientTransport);
			this.logger.info("Connected to remote MCP server");

			// Set up request forwarding handlers
			this.setupHandlers();

			// Create STDIO transport for local server
			this.serverTransport = new StdioServerTransport();

			// Connect server to STDIO transport
			await this.mcpServer.connect(this.serverTransport);

			this.logger.info("MCP proxy started successfully");
		} catch (error) {
			this.logger.error(
				`Failed to start MCP proxy: ${error instanceof Error ? error.message : String(error)}`,
			);

			if (error instanceof StreamableHTTPError && error.code === 404) {
				this.logger.error(
					"Please verify that the server is running and accessible and that the MCP gateway is enabled.",
				);
			}

			throw error;
		}
	}

	/**
	 * Stop the proxy server
	 */
	async stop(): Promise<void> {
		this.logger.info("Stopping MCP proxy...");

		try {
			// Close server (internally closes serverTransport)
			await this.mcpServer.close();

			// Close client (internally closes clientTransport)
			await this.client.close();

			this.logger.debug("MCP proxy stopped");
		} catch (error) {
			this.logger.error(
				`Error during shutdown: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	/**
	 * Set up request forwarding handlers for tools only (stateless mode)
	 * Forwards requests from STDIO server to remote MCP client
	 */
	private setupHandlers(): void {
		// Forward tools/list to remote server
		this.mcpServer.server.setRequestHandler(
			ListToolsRequestSchema,
			async (request) => {
				this.logger.debug("Forwarding tools/list request");
				try {
					const result = await this.client.listTools(request.params);
					this.logger.debug("Received tools/list response");
					return result;
				} catch (error) {
					this.logger.error(
						"Failed to forward tools/list",
						error instanceof Error ? error : undefined,
					);
					throw error;
				}
			},
		);

		// Forward tools/call to remote server
		this.mcpServer.server.setRequestHandler(
			CallToolRequestSchema,
			async (request) => {
				this.logger.debug(`Forwarding tools/call: ${request.params?.name}`);
				try {
					const result = await this.client.callTool(request.params);
					this.logger.debug(
						`Received tools/call response: ${request.params?.name}`,
					);
					return result;
				} catch (error) {
					this.logger.error(
						`Failed to forward tools/call: ${request.params?.name}`,
						error instanceof Error ? error : undefined,
					);
					throw error;
				}
			},
		);

		this.logger.debug(
			"Request handlers registered (tools only, stateless mode)",
		);
	}
}

// ─── defineCommand ───────────────────────────────────────────────────────────

/**
 * Run an STDIO ↔ remote-HTTP MCP proxy with Camunda authentication.
 *
 * Long-running: stays alive until SIGINT/SIGTERM, then stops the proxy
 * and resolves so the framework returns naturally with `{ kind: "never" }`.
 */
export const mcpProxyCommand = defineCommand("mcp-proxy", "", async (ctx) => {
	const allPositionals = ctx.resource
		? [ctx.resource, ...ctx.positionals]
		: ctx.positionals;

	const stderrLogWriter: LogWriter = {
		log(...data: unknown[]): void {
			console.error(...data);
		},
		error(...data: unknown[]): void {
			console.error(...data);
		},
	};

	const logger = new Logger(stderrLogWriter);
	const camundaClient = createClient(ctx.profile, {
		log: {
			transport: (evt) => {
				logger.json(evt);
			},
		},
	});

	const mcpServerPath = allPositionals[0] ?? "/mcp/cluster";

	let proxy: McpProxy | null = null;
	try {
		proxy = new McpProxy(camundaClient, logger, mcpServerPath);
		await proxy.start();

		// Block until a shutdown signal is received, then stop the proxy
		// and resolve so the handler returns. The framework treats this as
		// `{ kind: "never" }` and the process exits naturally.
		await new Promise<void>((resolve) => {
			const shutdown = (signal: string): void => {
				logger.info(`Received ${signal}, shutting down gracefully...`);
				const stop = proxy ? proxy.stop().catch(() => {}) : Promise.resolve();
				void stop.then(() => resolve());
			};
			process.once("SIGINT", () => shutdown("SIGINT"));
			process.once("SIGTERM", () => shutdown("SIGTERM"));
		});
	} catch (error) {
		const normalizedError = normalizeToError(error, "MCP proxy failed");

		if (proxy) await proxy.stop().catch(() => {});

		// In verbose mode users want the full stack trace, so re-throw and
		// let Node print it to stderr. The framework's default error handler
		// short-circuits to a plain rethrow when `c8ctl.verbose` is set
		// (see src/errors.ts), so no stdout hint is emitted in that path.
		if (c8ctl.verbose) {
			throw normalizedError;
		}

		// MCP-proxy uses STDIO for protocol; we must NOT let the framework's
		// default error handler write hints to stdout (that would corrupt
		// the MCP stream for any remaining client read). Log to stderr via
		// our stderr-backed logger and surface failure through the exit
		// code instead of re-throwing into `handleCommandError`.
		process.exitCode = 1;
		logger.error(`mcp-proxy failed: ${normalizedError.message}`);
	}

	return { kind: "never" };
});
