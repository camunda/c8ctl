# c8ctl MCP Chat Plugin

MCP (Model Context Protocol) chat support for Camunda 8.9+ clusters. This plugin enables interactive chat sessions with your Camunda cluster through its MCP gateway.

## Requirements

- Camunda 8.9 or later
- Node.js >= 22.18.0
- c8ctl >= 2.0.0

## Installation

Install the plugin using npm:

```bash
npm install c8ctl-mcp-chat
```

Or install from a local directory during development:

```bash
c8 load plugin --from file:./plugins/c8ctl-mcp-chat
```

## Usage

### Basic Usage

Start a chat session with your configured cluster:

```bash
c8 chat
```

### With Profile

Use a specific profile for the chat session:

```bash
c8 chat --profile=production
```

### MCP Gateway Endpoint

The plugin automatically constructs the MCP endpoint from your cluster configuration:
- For `http://localhost:8080/v2` → connects to `http://localhost:8080/mcp`
- For `https://cluster.example.com/v2` → connects to `https://cluster.example.com/mcp`

### Interactive Chat

Once connected, you can:
- Type your messages to interact with the cluster
- View available MCP tools
- Type `exit` or `quit` to end the session

## How It Works

The plugin:
1. Resolves the cluster configuration (using `--profile` flag or active session)
2. Checks that the cluster is version 8.9 or later
3. Connects to the MCP gateway at `<cluster-url>/mcp`
4. Provides an interactive chat interface

## Development

### Local Testing

1. Navigate to the plugin directory:
   ```bash
   cd plugins/c8ctl-mcp-chat
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Load the plugin in c8ctl:
   ```bash
   cd ../..
   c8 load plugin --from file:./plugins/c8ctl-mcp-chat
   ```

4. Test the chat command:
   ```bash
   c8 chat
   ```

## Architecture

- Uses `@modelcontextprotocol/sdk` for MCP client implementation
- Connects via SSE (Server-Sent Events) transport
- Integrates with c8ctl's profile and configuration system
- Provides interactive readline-based chat interface

## License

MIT
