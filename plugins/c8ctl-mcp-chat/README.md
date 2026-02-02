# c8ctl MCP Chat Plugin

MCP (Model Context Protocol) chat support for Camunda 8.9+ clusters with AI-powered natural language interface. This plugin uses Claude (Anthropic) to provide intelligent interaction with your cluster's MCP gateway.

## Requirements

- Camunda 8.9 or later with MCP gateway enabled
- Node.js >= 22.18.0
- c8ctl >= 2.0.0
- **Anthropic API key** (get one from [console.anthropic.com](https://console.anthropic.com/))

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

## Configuration

### Set Your Anthropic API Key

Before using the chat feature, set your Anthropic API key:

```bash
export ANTHROPIC_API_KEY=your_api_key_here
```

To make it permanent, add it to your shell profile (~/.bashrc, ~/.zshrc, etc.):

```bash
echo 'export ANTHROPIC_API_KEY=your_api_key_here' >> ~/.bashrc
source ~/.bashrc
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
3. Initialize Claude AI assistant
4. Open an interactive natural language chat session

### With Profile

Use a specific profile for the chat session:

```bash
c8 chat --profile=production
c8 chat --profile=modeler:LocalCluster
```

### Interactive Chat

Ask natural language questions about your cluster:

```
chat> What process instances are currently running?
🔧 Calling tool: list-process-instances...

There are 5 process instances currently running:
1. Order Processing (key: 2251799813685249)
2. Payment Workflow (key: 2251799813685250)
...

chat> Show me all incidents
🔧 Calling tool: list-incidents...

Found 2 incidents:
- Process instance 2251799813685249 has an error in task "ProcessPayment"
- Process instance 2251799813685251 has a timeout in task "ApproveOrder"

chat> Deploy my-process.bpmn
🔧 Calling tool: deploy-resource...

✓ Successfully deployed my-process.bpmn
Process Definition Key: my-process-v2
```

### Interactive Commands

Once in the chat session, you can use these commands:

- Type any question in natural language
- `help` - Show available commands
- `tools` - List MCP tools exposed by the cluster
- `clear` - Clear conversation history
- `exit` or `quit` - Close the chat session

### MCP Gateway Endpoint

The plugin automatically constructs the MCP endpoint from your cluster configuration:
- For `http://localhost:8080/v2` → connects to `http://localhost:8080/mcp`
- For `https://cluster.example.com/v2` → connects to `https://cluster.example.com/mcp`

### Configuration

The plugin uses c8ctl's configuration system and respects:
- The `--profile` flag for one-time profile override
- Active profile from session state
- Environment variables (`CAMUNDA_BASE_URL`, `ANTHROPIC_API_KEY`, etc.)
- Localhost fallback (`http://localhost:8080/v2`)

## How It Works

The plugin implements the full LLM-MCP integration loop:

1. User asks a question in natural language
2. Query is sent to Claude AI along with available MCP tool descriptions
3. Claude analyzes the query and decides which tools to invoke
4. The plugin executes the selected tools through the MCP gateway
5. Tool results are sent back to Claude
6. Claude formulates a natural language response
7. The response is displayed to the user

This creates a seamless natural language interface to your Camunda cluster.

The plugin:
1. Resolves the cluster configuration using c8ctl's configuration system
2. Connects to the cluster's REST API to verify version (8.9+)
3. Establishes an MCP connection via SSE (Server-Sent Events) transport
4. Initializes Claude AI client with your API key
5. Enters the interactive chat loop with LLM-powered tool orchestration

## Development

### Project Structure

```
plugins/c8ctl-mcp-chat/
├── package.json          # Plugin metadata and dependencies
├── c8ctl-plugin.js       # Plugin implementation with LLM integration
└── README.md             # This file
```

### Local Testing

1. Set your Anthropic API key:
   ```bash
   export ANTHROPIC_API_KEY=your_key_here
   ```

2. Install dependencies:
   ```bash
   cd plugins/c8ctl-mcp-chat
   npm install
   ```

3. Load the plugin from the c8ctl root:
   ```bash
   cd ../..
   npm install file:./plugins/c8ctl-mcp-chat
   ```

4. Test the chat command:
   ```bash
   c8 chat
   ```

### Running Against a Test Cluster

To test against a local Camunda 8.9+ cluster:

```bash
# Make sure you have a cluster running with MCP enabled
# Default: http://localhost:8080

# Set your API key
export ANTHROPIC_API_KEY=your_key_here

# Start chat session
c8 chat

# Or with explicit base URL
CAMUNDA_BASE_URL=http://localhost:8080/v2 c8 chat
```

## Architecture

### Dependencies

- `@anthropic-ai/sdk` - Official Anthropic Claude SDK for LLM interaction
- `@modelcontextprotocol/sdk` - Official MCP TypeScript SDK
- `zod` - Schema validation (peer dependency of MCP SDK)

### LLM Integration

Uses Claude 3.5 Sonnet for intelligent tool orchestration:
- Accepts natural language queries from users
- Analyzes intent and selects appropriate MCP tools
- Executes tool calls through the MCP gateway
- Synthesizes results into natural language responses
- Maintains conversation context across the session

### Transport

Uses SSE (Server-Sent Events) transport for real-time bidirectional communication:
- HTTP POST for client → server messages
- SSE for server → client streaming

### Integration

- Accesses c8ctl runtime via `globalThis.c8ctl`
- Uses c8ctl's profile and configuration system
- Follows c8ctl plugin conventions for metadata and command exports

## Troubleshooting

### "ANTHROPIC_API_KEY environment variable is required"

Set your API key:
```bash
export ANTHROPIC_API_KEY=your_key_here
```

Get an API key from: https://console.anthropic.com/

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

### LLM Rate Limits

If you encounter rate limit errors from Claude:
- Wait a moment and try again
- Consider upgrading your Anthropic API plan
- The plugin uses Claude 3.5 Sonnet with a 4096 token limit per response

## License

Apache-2.0
