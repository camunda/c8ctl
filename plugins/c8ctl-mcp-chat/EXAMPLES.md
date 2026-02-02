# c8ctl MCP Chat Plugin - Examples

This document provides examples of using the MCP chat plugin with Camunda 8.9+ clusters.

## Basic Examples

### Example 1: Local Cluster Chat

Connect to a local Camunda cluster running on the default port:

```bash
# Start local cluster (example using docker-compose)
# Make sure the cluster has MCP gateway enabled

# Start chat session
c8 chat

# Expected output:
# Starting MCP chat session...
# Connecting to: http://localhost:8080/mcp
# Connected to Camunda 8.9.0
# ✓ Connected to MCP gateway
#
# Available tools:
#   - deploy: Deploy BPMN processes
#   - create-instance: Create process instances
#   - query-instances: Query process instances
#
# MCP chat session started. Type your message or "exit" to quit.
#
# chat>
```

### Example 2: Cloud Cluster with Profile

Connect to a Camunda Cloud cluster using a saved profile:

```bash
# First, configure your profile
c8 add profile my-cloud \
  --baseUrl=https://my-cluster.camunda.io \
  --clientId=xxx \
  --clientSecret=yyy \
  --audience=zeebe.camunda.io

# Start chat session with profile
c8 chat --profile=my-cloud

# Expected output:
# Starting MCP chat session...
# Using profile: my-cloud
# Connecting to: https://my-cluster.camunda.io/mcp
# Connected to Camunda 8.9.1
# ✓ Connected to MCP gateway
# ...
```

### Example 3: Using Modeler Profile

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
