# c8ctl MCP Chat Plugin

MCP (Model Context Protocol) chat support for Camunda 8.9+ clusters with AI-powered natural language interface. This plugin supports both **Anthropic Claude** and **OpenAI GPT** models for intelligent interaction with your cluster's MCP gateway.

## Requirements

- Camunda 8.9 or later with MCP gateway enabled
- Node.js >= 22.18.0
- c8ctl >= 2.0.0
- **API key** for one of:
  - Anthropic Claude: Get from [console.anthropic.com](https://console.anthropic.com/)
  - OpenAI: Get from [platform.openai.com/api-keys](https://platform.openai.com/api-keys)

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

### Choose Your LLM Provider

The plugin automatically detects which provider to use based on which API key is set:

#### Option 1: Anthropic Claude (Claude 3.5 Sonnet)

```bash
export ANTHROPIC_API_KEY=your_api_key_here
```

#### Option 2: OpenAI (GPT-4o)

```bash
export OPENAI_API_KEY=your_api_key_here
```

**Note**: If both keys are set, OpenAI takes precedence.

To make it permanent, add to your shell profile (~/.bashrc, ~/.zshrc, etc.):

```bash
# For Anthropic Claude
echo 'export ANTHROPIC_API_KEY=your_api_key_here' >> ~/.bashrc

# OR for OpenAI
echo 'export OPENAI_API_KEY=your_api_key_here' >> ~/.bashrc

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
3. Detect and initialize your LLM provider (Claude or GPT-4o)
4. Open an interactive natural language chat session

The plugin will display which model it's using:
- `Using: Anthropic Claude 3.5 Sonnet` or
- `Using: OpenAI GPT-4o`

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
- Environment variables (`CAMUNDA_BASE_URL`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.)
- Localhost fallback (`http://localhost:8080/v2`)

## How It Works

The plugin implements the full LLM-MCP integration loop:

1. User asks a question in natural language
2. Query is sent to your chosen LLM (Claude or GPT-4o) along with available MCP tool descriptions
3. The LLM analyzes the query and decides which tools to invoke
4. The plugin executes the selected tools through the MCP gateway
5. Tool results are sent back to the LLM
6. The LLM formulates a natural language response
7. The response is displayed to the user

This creates a seamless natural language interface to your Camunda cluster.

The plugin:
1. Resolves the cluster configuration using c8ctl's configuration system
2. Connects to the cluster's REST API to verify version (8.9+)
3. Establishes an MCP connection via SSE (Server-Sent Events) transport
4. Detects which LLM provider to use (based on API keys)
5. Initializes the appropriate LLM client (Claude or OpenAI)
6. Enters the interactive chat loop with LLM-powered tool orchestration

## Development

### Project Structure

```
plugins/c8ctl-mcp-chat/
├── package.json            # Plugin metadata and dependencies
├── c8ctl-plugin.js         # Plugin implementation with LLM integration
├── version-check.test.js   # Unit tests for version checking logic
├── verify.js               # Plugin structure validation
└── README.md               # This file
```

### Running Tests

The plugin includes unit tests for the version checking logic:

```bash
cd plugins/c8ctl-mcp-chat
npm test
```

The tests verify:
- Correct acceptance of versions 8.9.0 and later
- Correct rejection of versions before 8.9
- Regression test for the parseFloat bug (versions 8.10, 8.11, etc.)
- Edge cases like single-digit versions and versions with extra segments

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

# Set your API key (choose one)
export ANTHROPIC_API_KEY=your_key_here
# OR
export OPENAI_API_KEY=your_key_here

# Start chat session
c8 chat

# Or with explicit base URL
CAMUNDA_BASE_URL=http://localhost:8080/v2 c8 chat
```

## Architecture

### Dependencies

- `@anthropic-ai/sdk` - Official Anthropic Claude SDK for LLM interaction
- `openai` - Official OpenAI SDK for GPT models
- `@modelcontextprotocol/sdk` - Official MCP TypeScript SDK
- `zod` - Schema validation (peer dependency of MCP SDK)

### LLM Integration

Supports multiple LLM providers for intelligent tool orchestration:

#### Anthropic Claude (Claude 3.5 Sonnet)
- Accepts natural language queries from users
- Analyzes intent and selects appropriate MCP tools
- Executes tool calls through the MCP gateway
- Synthesizes results into natural language responses
- Maintains conversation context across the session

#### OpenAI (GPT-4o)
- Same capabilities as Claude
- Alternative provider option
- Automatically selected if `OPENAI_API_KEY` is set

### Transport

Uses SSE (Server-Sent Events) transport for real-time bidirectional communication:
- HTTP POST for client → server messages
- SSE for server → client streaming

### Integration

- Accesses c8ctl runtime via `globalThis.c8ctl`
- Uses c8ctl's profile and configuration system
- Follows c8ctl plugin conventions for metadata and command exports

## Troubleshooting

### "No LLM API key found"

Set an API key for one of the supported providers:

For Anthropic Claude:
```bash
export ANTHROPIC_API_KEY=your_key_here
```
Get your key from: https://console.anthropic.com/

For OpenAI:
```bash
export OPENAI_API_KEY=your_key_here
```
Get your key from: https://platform.openai.com/api-keys

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

If you encounter rate limit errors:
- **Claude**: Wait a moment and try again, or upgrade your Anthropic API plan
- **OpenAI**: Check your usage limits at https://platform.openai.com/usage
- Consider switching to the alternative provider if one is hitting limits

## License

Apache-2.0
