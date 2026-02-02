# c8ctl MCP Chat Plugin - Examples

This document provides examples of using the AI-powered MCP chat plugin with Camunda 8.9+ clusters.

## Prerequisites

Before starting, make sure you have:
1. Set **exactly one** LLM API key:
   - Anthropic Claude: `export ANTHROPIC_API_KEY=your_key_here`
   - OpenAI: `export OPENAI_API_KEY=your_key_here`
   - **Note**: Setting both will cause an error
2. A Camunda 8.9+ cluster with MCP gateway enabled
3. The plugin installed: `npm install file:./plugins/c8ctl-mcp-chat`

## Basic Examples

### Example 1: Natural Language Queries with Claude

Ask questions in plain English and let Claude orchestrate the MCP tools:

```bash
# Set API key for Anthropic
export ANTHROPIC_API_KEY=sk-ant-...

# Optional: Specify a model
export ANTHROPIC_MODEL=claude-3-5-sonnet-20241022

# Start chat session
c8 chat

# Expected output:
# Starting MCP chat session...
# Connecting to: http://localhost:8080/mcp
# Connected to Camunda 8.9.0
# ✓ Connected to MCP gateway
# Using: Anthropic Claude (claude-3-5-sonnet-20241022)
#
# Available tools:
#   - list-process-instances: List process instances
#   - deploy-resource: Deploy BPMN/DMN resources
#   - create-instance: Create process instances
#
# MCP chat session started. Ask questions about your cluster!
#
# Examples:
#   - "What process instances are currently running?"
#   - "Deploy the order-process.bpmn file"
#   - "Show me all incidents in the cluster"
#
# chat> What's running right now?
# 
# 🔧 Calling tool: list-process-instances...
#
# There are currently 3 active process instances:
# 1. Order Processing (ID: 2251799813685249) - Running since 2 hours ago
# 2. Payment Workflow (ID: 2251799813685250) - Running since 1 hour ago
# 3. Shipping Process (ID: 2251799813685251) - Running since 30 minutes ago
#
# All instances appear to be progressing normally.
#
# chat> Are there any problems?
#
# 🔧 Calling tool: list-incidents...
#
# Yes, I found 2 incidents that need attention:
#
# 1. Process instance 2251799813685249 has an error in the "ProcessPayment" task
#    - Error: Payment gateway timeout
#    - Created: 15 minutes ago
#
# 2. Process instance 2251799813685251 has failed at "ValidateShipping"
#    - Error: Invalid shipping address format
#    - Created: 5 minutes ago
#
# Would you like me to help resolve these incidents?
```

### Example 2: Using OpenAI GPT-4o

Use OpenAI instead of Claude:

```bash
# Set API key for OpenAI
export OPENAI_API_KEY=sk-...

# Optional: Specify a model
export OPENAI_MODEL=gpt-4o

# Start chat session
c8 chat

# Expected output:
# Starting MCP chat session...
# Connecting to: http://localhost:8080/mcp
# Connected to Camunda 8.9.0
# ✓ Connected to MCP gateway
# Using: OpenAI (gpt-4o)
#
# Available tools:
#   - list-process-instances: List process instances
#   - deploy-resource: Deploy BPMN/DMN resources
#   - create-instance: Create process instances
#
# MCP chat session started. Ask questions about your cluster!
#
# chat> List all running processes
#
# 🔧 Calling tool: list-process-instances...
#
# Here are the currently running processes:
# 1. Order Fulfillment (Instance ID: 2251799813685249)
# 2. Customer Onboarding (Instance ID: 2251799813685250)
# ...
```

### Example 3: Cloud Cluster with Profile

Connect to a Camunda Cloud cluster using a saved profile:

```bash
# First, configure your profile
c8 add profile my-cloud \
  --baseUrl=https://my-cluster.camunda.io \
  --clientId=xxx \
  --clientSecret=yyy \
  --audience=zeebe.camunda.io

# Set API key and start chat (either provider works)
export ANTHROPIC_API_KEY=sk-ant-...
c8 chat --profile=my-cloud

# Expected output:
# Starting MCP chat session...
# Using profile: my-cloud
# Connecting to: https://my-cluster.camunda.io/mcp
# Connected to Camunda 8.9.1
# ✓ Connected to MCP gateway
# Using: Anthropic Claude (claude-3-5-sonnet-20241022)
# ...
```

### Example 4: Using Modeler Profile

Use a profile imported from Camunda Modeler:

```bash
c8 chat --profile=modeler:Production-Cluster
```

## Interactive Commands

### List Available Tools

Once in a chat session, list the MCP tools exposed by your cluster:

```bash
chat> tools

# Output:
# Available tools:
#
#   deploy
#     Deploy BPMN processes to the cluster
#     Schema: {
#       type: "object",
#       properties: {
#         resources: { type: "array", items: { type: "string" } }
#       }
#     }
#
#   create-instance
#     Create a new process instance
#     Schema: {
#       type: "object",
#       properties: {
#         bpmnProcessId: { type: "string" },
#         variables: { type: "object" }
#       }
#     }
```

### Get Help

Show available commands:

```bash
chat> help

# Output:
# Available commands:
#   help     - Show this help message
#   tools    - List available MCP tools
#   exit     - Exit the chat session
#   quit     - Exit the chat session
#
# Otherwise, type your message to interact with the cluster.
```

### Exit Session

Close the chat session:

```bash
chat> exit

# Output:
# Closing chat session...
# Chat session ended.
```

## Integration Examples

### Example 4: Environment Variables

Configure connection using environment variables:

```bash
export CAMUNDA_BASE_URL=http://192.168.1.100:8080/v2
export CAMUNDA_USERNAME=admin
export CAMUNDA_PASSWORD=admin

c8 chat

# The plugin will use the environment configuration
```

### Example 5: Session Profile

Use the active session profile:

```bash
# Set active profile
c8 use profile staging

# Start chat (will use 'staging' profile automatically)
c8 chat
```

## Advanced Usage

### Example 6: Scripted Interaction

While primarily interactive, you can also use the chat in scripts:

```bash
# This would require enhancing the plugin to support stdin input
echo -e "tools\nexit" | c8 chat --profile=dev
```

### Example 7: Different Ports

Connect to a cluster on a custom port:

```bash
c8 add profile custom-port --baseUrl=http://localhost:9090/v2
c8 chat --profile=custom-port
```

## Troubleshooting Examples

### Connection Issues

If you encounter connection issues:

```bash
# Verify cluster is accessible
curl http://localhost:8080/v2/topology

# Check MCP endpoint
curl http://localhost:8080/mcp

# Try chat with verbose error output
c8 chat
```

### Version Compatibility

If your cluster is older than 8.9:

```bash
c8 chat
# Error: MCP chat requires Camunda 8.9 or later. Current version: 8.8.0
```

### Authentication Issues

For authenticated clusters, ensure credentials are configured:

```bash
# Add profile with authentication
c8 add profile secure \
  --baseUrl=https://secure-cluster.example.com/v2 \
  --clientId=my-client \
  --clientSecret=my-secret

c8 chat --profile=secure
```

## Best Practices

1. **Profile Management**: Create separate profiles for different environments (dev, staging, prod)
2. **Session Usage**: Set an active profile for frequent use with `c8 use profile <name>`
3. **Tool Discovery**: Always run `tools` command first to understand cluster capabilities
4. **Error Handling**: Check connection before starting important operations

## Future Capabilities

As the MCP specification and Camunda's implementation evolve, future examples might include:

- Natural language queries: "Show me all failed process instances"
- Tool chaining: Automatically deploying and testing processes
- Resource access: Reading cluster configuration and statistics
- Prompt templates: Pre-defined conversational workflows
