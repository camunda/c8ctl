# c8ctl MCP Chat Plugin

MCP (Model Context Protocol) chat support for Camunda 8.9+ clusters. This plugin enables interactive chat sessions with your Camunda cluster through its MCP gateway.

## Requirements

- Camunda 8.9 or later with MCP gateway enabled
- Node.js >= 22.18.0
- c8ctl >= 2.0.0

## Installation

### From npm (when published)

```bash
npm install -g c8ctl-mcp-chat
```

### From local directory (for development)

```bash
# From the c8ctl repository root
npm install file:./plugins/c8ctl-mcp-chat
```

Or using c8ctl's plugin loading:

```bash
c8 load plugin --from file:./plugins/c8ctl-mcp-chat
```

## Usage

### Basic Usage

Start a chat session with your configured cluster:

```bash
c8 chat
```

This will:
1. Connect to the cluster's MCP gateway
2. Verify the cluster is version 8.9 or later
3. Open an interactive chat session

### With Profile

Use a specific profile for the chat session:

```bash
c8 chat --profile=production
c8 chat --profile=modeler:LocalCluster
```

### Interactive Commands

Once in the chat session, you can use these commands:

- `help` - Show available commands
- `tools` - List MCP tools exposed by the cluster
- `exit` or `quit` - Close the chat session

### MCP Gateway Endpoint

The plugin automatically constructs the MCP endpoint from your cluster configuration:
- For `http://localhost:8080/v2` → connects to `http://localhost:8080/mcp`
- For `https://cluster.example.com/v2` → connects to `https://cluster.example.com/mcp`

### Configuration

The plugin uses c8ctl's configuration system and respects:
- The `--profile` flag for one-time profile override
- Active profile from session state
- Environment variables (`CAMUNDA_BASE_URL`, etc.)
- Localhost fallback (`http://localhost:8080/v2`)

## How It Works

The plugin:
1. Resolves the cluster configuration using c8ctl's configuration system
2. Connects to the cluster's REST API to verify version (8.9+)
3. Establishes an MCP connection via SSE (Server-Sent Events) transport
4. Lists available MCP tools and resources
5. Provides an interactive readline-based chat interface

## Development

### Project Structure

```
plugins/c8ctl-mcp-chat/
├── package.json          # Plugin metadata and dependencies
├── c8ctl-plugin.js       # Plugin implementation
└── README.md             # This file
```

### Local Testing

1. Install dependencies:
   ```bash
   cd plugins/c8ctl-mcp-chat
   npm install
   ```

2. Load the plugin from the c8ctl root:
   ```bash
   cd ../..
   npm install file:./plugins/c8ctl-mcp-chat
   ```

3. Test the chat command:
   ```bash
   c8 chat
   ```

### Running Against a Test Cluster

To test against a local Camunda 8.9+ cluster:

```bash
# Make sure you have a cluster running with MCP enabled
# Default: http://localhost:8080

# Start chat session
c8 chat

# Or with explicit base URL
CAMUNDA_BASE_URL=http://localhost:8080/v2 c8 chat
```

## Architecture

### Dependencies

- `@modelcontextprotocol/sdk` - Official MCP TypeScript SDK
- `zod` - Schema validation (peer dependency of MCP SDK)

### Transport

Uses SSE (Server-Sent Events) transport for real-time bidirectional communication:
- HTTP POST for client → server messages
- SSE for server → client streaming

### Integration

- Accesses c8ctl runtime via `globalThis.c8ctl`
- Uses c8ctl's profile and configuration system
- Follows c8ctl plugin conventions for metadata and command exports

## Troubleshooting

### "MCP gateway not available"

Make sure:
- Your cluster is Camunda 8.9 or later
- The MCP gateway feature is enabled
- The cluster URL is correct

### Connection errors

Check:
- Network connectivity to the cluster
- Authentication credentials (if required)
- Firewall rules allowing connections to the MCP endpoint

### Version check fails

The plugin attempts to verify the cluster version via `/v2/topology`. If this fails:
- Ensure the cluster is accessible
- Check authentication is configured correctly
- The plugin will proceed with a warning if version cannot be determined

## Future Enhancements

Potential improvements:
- Natural language processing for chat messages
- Automatic tool invocation based on user intent
- Conversation history and context
- Rich formatting for tool responses
- Support for additional MCP features (resources, prompts)

## License

Apache-2.0
