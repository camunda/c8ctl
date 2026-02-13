import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { type CamundaClient } from '@camunda8/orchestration-cluster-api';
import { createClient } from '../client.ts';
import { getVersion } from './help.ts';
import { Logger, type LogWriter } from '../logger.ts';

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
          'Received 401 (Unauthorized) response, attempting token refresh and retrying',
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
        const retryTimeoutId = setTimeout(() => retryTimeoutController.abort(), timeout);

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
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Request timeout after ${timeout}ms`);
      }

      const cause = (error as any)?.cause;
      if (cause?.code === 'ECONNREFUSED') {
        const url = typeof input === 'string' ? input : input.toString();
        throw new Error(
          `Connection refused: Unable to connect to ${url}. Please verify the server is running and accessible.`,
        );
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
export function normalizeRemoteMcpUrl(url: string, mcpServerPath: string): string {
  try {
    const urlObj = new URL(url);

    // If path is empty or just "/", append MCP server path
    if (urlObj.pathname === '' || urlObj.pathname === '/') {
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
  } catch (e) {
    return url;
  }
}

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
      { name: 'c8ctl-mcp-proxy', version },
      { capabilities: {} },
    );

    // Initialize MCP server for STDIO (stateless mode - tools only)
    this.mcpServer = new McpServer(
      {
        name: 'c8ctl-mcp-proxy',
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
    this.logger.info('Starting MCP proxy...');
    this.logger.info(
      `Connecting to remote MCP server at: ${this.mcpRemoteUrl}`,
    );

    try {
      // Verify authentication works by getting auth headers
      const authStrategy = this.camundaClient.getConfig().auth.strategy;
      if (authStrategy !== 'NONE') {
        this.logger.debug(`Resolving ${authStrategy} authentication...`);
        await this.camundaClient.getAuthHeaders();
        this.logger.debug(
          `${authStrategy} authentication resolved successfully`,
        );
      } else {
        this.logger.info('No authentication configured (auth.strategy=NONE)');
      }

      // Connect client to remote server
      this.logger.debug('Connecting to remote MCP server');
      await this.client.connect(this.clientTransport);
      this.logger.info('Connected to remote MCP server');

      // Set up request forwarding handlers
      this.setupHandlers();

      // Create STDIO transport for local server
      this.serverTransport = new StdioServerTransport();

      // Connect server to STDIO transport
      await this.mcpServer.connect(this.serverTransport);

      this.logger.info('MCP proxy started successfully');
    } catch (error) {
      this.logger.error(
        `Failed to start MCP proxy: ${error instanceof Error ? error.message : String(error)}`,
      );

      if (error instanceof StreamableHTTPError && error.code === 404) {
        this.logger.error(
          'Please verify that the server is running and accessible and that the MCP gateway is enabled.',
        );
      }

      throw error;
    }
  }

  /**
   * Stop the proxy server
   */
  async stop(): Promise<void> {
    this.logger.info('Stopping MCP proxy...');

    try {
      // Close server (internally closes serverTransport)
      await this.mcpServer.close();

      // Close client (internally closes clientTransport)
      await this.client.close();

      this.logger.debug('MCP proxy stopped');
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
    this.mcpServer.server.setRequestHandler(ListToolsRequestSchema, async (request) => {
      this.logger.debug('Forwarding tools/list request');
      try {
        const result = await this.client.listTools(request.params);
        this.logger.debug('Received tools/list response');
        return result;
      } catch (error) {
        this.logger.error(
          'Failed to forward tools/list',
          error instanceof Error ? error : undefined,
        );
        throw error;
      }
    });

    // Forward tools/call to remote server
    this.mcpServer.server.setRequestHandler(CallToolRequestSchema, async (request) => {
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
    });

    this.logger.debug(
      'Request handlers registered (tools only, stateless mode)',
    );
  }
}

async function runProxy(
  camundaClient: CamundaClient,
  logger: Logger,
  mcpServerPath: string,
) {
  let proxy: McpProxy | null = null;

  try {
    // Create and start proxy
    proxy = new McpProxy(camundaClient, logger, mcpServerPath);
    await proxy.start();

    // Handle graceful shutdown
    const shutdown = async (signal: string) => {
      logger.info(`Received ${signal}, shutting down gracefully...`);
      if (proxy) {
        await proxy.stop();
      }
      process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    // Keep process alive
    await new Promise(() => {});
  } catch (error) {
    logger.error(`Failed to run MCP proxy. Shutting down...`);
    if (proxy) {
      await proxy.stop();
    }
    process.exit(1);
  }
}

/**
 * Run STDIO to remote HTTP MCP proxy with Camunda authentication
 */
export async function mcpProxy(
  args: string[],
  options: { profile?: string },
): Promise<void> {
  const stderrLogWriter: LogWriter = {
    log(...data: any[]): void {
      console.error(...data);
    },
    error(...data: any[]): void {
      console.error(...data);
    },
  };

  const logger = new Logger(stderrLogWriter);
  const camundaClient = createClient(options.profile, {
    log: {
      transport: (evt) => {
        logger.json(evt);
      },
    },
  });

  const mcpServerPath = args[0] ?? '/mcp/cluster';
  await runProxy(camundaClient, logger, mcpServerPath);
}
