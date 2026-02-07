import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ProxyAgent, setGlobalDispatcher } from 'undici';
import { type CamundaClient } from '@camunda8/orchestration-cluster-api';
import { Logger } from '@camunda8/orchestration-cluster-api/logger';
import { createClient } from '../client.ts';

/**
 * Configure global HTTP proxy if environment variables are set.
 *
 * undici is Node.js's HTTP client that powers the built-in fetch() API.
 * ProxyAgent allows all fetch requests (including from orchestration-cluster-api)
 * to route through corporate HTTP proxies by setting a global dispatcher.
 */
function configureHttpProxy(logger: Logger): void {
  const httpsProxy = process.env.https_proxy || process.env.HTTPS_PROXY;
  const httpProxy = process.env.http_proxy || process.env.HTTP_PROXY;
  const proxy = httpsProxy || httpProxy;

  if (proxy) {
    try {
      const agent = new ProxyAgent(proxy);
      setGlobalDispatcher(agent);
      logger.info(`Configured HTTP proxy: ${proxy}`);
    } catch (error) {
      logger.warn(
        `Failed to configure proxy: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/**
 * Creates a custom fetch function that injects Camunda authentication headers
 * and handles token refresh on 401 errors.
 *
 * @param camundaClient - The Camunda client instance for auth
 * @param timeout - Request timeout in milliseconds (default: 30000)
 * @returns Custom fetch function compatible with MCP SDK transport
 */
function createCamundaFetch(
  camundaClient: CamundaClient,
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

      // Make the request with merged headers (exclude init.headers to avoid overwriting)
      const { headers: _, ...restInit } = init || {};
      const response = await fetch(input, { ...restInit, headers, signal });

      // Handle 401 with token refresh and retry
      if (response.status === 401) {
        clearTimeout(timeoutId);

        // Force token refresh
        await camundaClient.forceAuthRefresh();
        const freshHeaders = await camundaClient.getAuthHeaders();

        // Rebuild headers with fresh auth
        const retryHeaders = new Headers(init?.headers);
        Object.entries(freshHeaders).forEach(([key, value]) => {
          retryHeaders.set(key, value);
        });

        // Retry the request once with fresh token (exclude init.headers to avoid overwriting)
        const { headers: _, ...restInit } = init || {};
        return await fetch(input, {
          ...restInit,
          headers: retryHeaders,
          signal: init?.signal,
        });
      }

      clearTimeout(timeoutId);
      return response;
    } catch (error) {
      clearTimeout(timeoutId);

      // Convert AbortError to more descriptive timeout error
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Request timeout after ${timeout}ms`);
      }
      throw error;
    }
  };
}

/**
 * Normalize remote MCP URL to ensure it points to the MCP endpoint
 * - If URL has no path or just "/", append "/mcp"
 * - If URL ends with "/v2", replace with "/mcp"
 * - If URL already ends with "/mcp", keep it as is
 */
function normalizeRemoteMcpUrl(url: string): string {
  try {
    const urlObj = new URL(url);

    // If path is empty or just "/", append "/mcp"
    if (urlObj.pathname === '' || urlObj.pathname === '/') {
      urlObj.pathname = '/mcp';
      return urlObj.toString();
    }

    // If path ends with "/v2", replace with "/mcp"
    if (urlObj.pathname.endsWith('/v2')) {
      urlObj.pathname = urlObj.pathname.slice(0, -3) + '/mcp';
      return urlObj.toString();
    }

    // Already ends with /mcp or has custom path - keep as is
    return url;
  } catch (e) {
    // If URL parsing fails, return as is (will be caught by Zod validation)
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

  private server: Server;
  private serverTransport: StdioServerTransport | null = null;

  constructor(camundaClient: CamundaClient, logger: Logger) {
    this.camundaClient = camundaClient;
    this.logger = logger;

    this.mcpRemoteUrl = normalizeRemoteMcpUrl(
      this.camundaClient.getConfig().restAddress,
    );

    this.logger.info(
      `Connecting to remote MCP server at: ${this.mcpRemoteUrl}`,
    );

    // Create transport to remote MCP server including custom fetch for Camunda authentication
    this.clientTransport = new StreamableHTTPClientTransport(
      new URL(this.mcpRemoteUrl),
      {
        fetch: createCamundaFetch(this.camundaClient),
      },
    );

    // Create MCP client to call remote server
    this.client = new Client(
      { name: 'camunda-mcp-proxy', version: '1.0.0' },
      { capabilities: {} },
    );

    // Initialize MCP server for STDIO (stateless mode - tools only)
    this.server = new Server(
      {
        name: 'c8ctl-mcp-proxy',
        version: '1.0.0',
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

    try {
      // Verify authentication works by getting auth headers
      const authStrategy = this.camundaClient.getConfig().auth.strategy;
      if (authStrategy !== 'NONE') {
        this.logger.info(`Verifying ${authStrategy} authentication...`);
        await this.camundaClient.getAuthHeaders();
        this.logger.info(
          `${authStrategy} authentication verified successfully`,
        );
      } else {
        this.logger.info('No authentication configured (auth.strategy=NONE)');
      }

      // Connect client to remote server
      this.logger.info(`Connecting to remote MCP server`);
      await this.client.connect(this.clientTransport);
      this.logger.info('Connected to remote MCP server');

      // Set up request forwarding handlers
      this.setupHandlers();

      // Create STDIO transport for local server
      this.serverTransport = new StdioServerTransport();

      // Connect server to STDIO transport
      await this.server.connect(this.serverTransport);

      this.logger.info('MCP proxy started successfully');
    } catch (error) {
      this.logger.error(
        `Failed to start proxy: ${error instanceof Error ? error.message : String(error)}`,
      );
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
      await this.server.close();

      // Close client (internally closes clientTransport)
      await this.client.close();

      this.logger.info('MCP proxy stopped');
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
    this.server.setRequestHandler(ListToolsRequestSchema, async (request) => {
      this.logger.debug('Forwarding tools/list request');
      try {
        const result = await this.client.listTools(request.params);
        this.logger.debug('Received tools/list response');
        return result;
      } catch (error) {
        this.logger.error('Failed to forward tools/list', {
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    });

    // Forward tools/call to remote server
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
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
          {
            error: error instanceof Error ? error.message : String(error),
          },
        );
        throw error;
      }
    });

    this.logger.debug(
      'Request handlers registered (tools only, stateless mode)',
    );
  }
}

async function runProxy(camundaClient: CamundaClient) {
  let proxy: McpProxy | null = null;

  const logger = camundaClient.logger('mcp-proxy');

  try {
    // Configure HTTP proxy for Node.js fetch if environment variables are set
    configureHttpProxy(logger);

    // Create and start proxy
    proxy = new McpProxy(camundaClient, logger);
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
    logger.error(
      `Fatal error: ${error instanceof Error ? error.message : String(error)}`,
    );
    if (proxy) {
      await proxy.stop();
    }
    process.exit(1);
  }
}

/**
 * Run STDIO to remote HTTP MCP proxy with Camunda authentication
 */
export async function mcpProxy(options: { profile?: string }): Promise<void> {
  const camundaClient = createClient(options.profile, {
    log: {
      transport: (evt) => {
        console.error(JSON.stringify(evt));
      },
    },
  });

  await runProxy(camundaClient);
}
