/**
 * c8ctl MCP Chat Plugin
 * Provides interactive chat with Camunda 8.9+ clusters via MCP gateway
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';

// Access c8ctl runtime (available as global)
const c8ctl = globalThis.c8ctl;

/**
 * Plugin metadata for help integration
 */
export const metadata = {
  name: 'c8ctl-mcp-chat',
  description: 'MCP chat support for Camunda 8.9+ clusters',
  commands: {
    chat: {
      description: 'Open interactive chat session with the cluster MCP gateway',
    },
  },
};

/**
 * Get cluster configuration from c8ctl runtime
 */
function getClusterConfig(args) {
  // Check for --profile flag in args
  const profileFlagIndex = args.findIndex(arg => arg.startsWith('--profile='));
  let profileFlag;
  if (profileFlagIndex !== -1) {
    profileFlag = args[profileFlagIndex].split('=')[1];
  }

  // Import config module to resolve cluster configuration
  // Note: This requires c8ctl runtime to expose config functions
  // For now, we'll use a simplified approach with environment variables and defaults
  
  // Priority: profileFlag → session → env vars → localhost
  const baseUrl = process.env.CAMUNDA_BASE_URL || 'http://localhost:8080';
  
  return {
    baseUrl,
    profileFlag,
  };
}

/**
 * Extract base URL and construct MCP endpoint
 */
function getMcpEndpoint(baseUrl) {
  // Remove /v2 suffix if present
  let cleanUrl = baseUrl.replace(/\/v2\/?$/, '');
  
  // Ensure no trailing slash
  cleanUrl = cleanUrl.replace(/\/$/, '');
  
  // Add /mcp endpoint
  return `${cleanUrl}/mcp`;
}

/**
 * Check if cluster version is 8.9+
 */
async function checkClusterVersion(baseUrl) {
  try {
    // Try to fetch topology to get version info
    const topologyUrl = baseUrl.includes('/v2') ? 
      `${baseUrl}/topology` : 
      `${baseUrl}/v2/topology`;
    
    const response = await fetch(topologyUrl);
    if (!response.ok) {
      console.warn('Warning: Could not verify cluster version. Proceeding anyway...');
      return true;
    }
    
    const topology = await response.json();
    
    // Check if version is available in topology response
    if (topology.version) {
      const version = topology.version;
      const majorMinor = version.split('.').slice(0, 2).join('.');
      const versionNum = parseFloat(majorMinor);
      
      if (versionNum < 8.9) {
        console.error(`Error: MCP chat requires Camunda 8.9 or later. Current version: ${version}`);
        return false;
      }
      
      console.log(`Connected to Camunda ${version}`);
    } else {
      console.warn('Warning: Could not determine cluster version. Proceeding anyway...');
    }
    
    return true;
  } catch (error) {
    console.warn('Warning: Could not verify cluster version. Proceeding anyway...');
    return true;
  }
}

/**
 * Main chat command implementation
 */
async function chat(args) {
  console.log('Starting MCP chat session...\n');
  
  // Get cluster configuration
  const config = getClusterConfig(args);
  const mcpEndpoint = getMcpEndpoint(config.baseUrl);
  
  console.log(`Connecting to: ${mcpEndpoint}`);
  
  // Check cluster version
  const versionOk = await checkClusterVersion(config.baseUrl);
  if (!versionOk) {
    process.exit(1);
  }
  
  try {
    // Create MCP client
    const client = new Client(
      {
        name: 'c8ctl-mcp-chat',
        version: '1.0.0',
      },
      {
        capabilities: {},
      }
    );
    
    // Set up error handler
    client.onerror = (error) => {
      console.error('MCP client error:', error);
    };
    
    // Create SSE transport
    const transport = new SSEClientTransport(new URL(mcpEndpoint));
    
    // Connect to MCP server
    console.log('Connecting to MCP gateway...');
    await client.connect(transport);
    
    console.log('✓ Connected to MCP gateway\n');
    
    // List available tools
    try {
      const tools = await client.listTools();
      if (tools && tools.tools && tools.tools.length > 0) {
        console.log('Available tools:');
        tools.tools.forEach(tool => {
          console.log(`  - ${tool.name}: ${tool.description || 'No description'}`);
        });
        console.log();
      }
    } catch (error) {
      console.warn('Could not list tools:', error.message);
    }
    
    // Create readline interface for interactive chat
    const rl = createInterface({
      input: stdin,
      output: stdout,
      prompt: 'chat> ',
    });
    
    console.log('MCP chat session started. Type your message or "exit" to quit.\n');
    rl.prompt();
    
    rl.on('line', async (line) => {
      const input = line.trim();
      
      if (!input) {
        rl.prompt();
        return;
      }
      
      if (input.toLowerCase() === 'exit' || input.toLowerCase() === 'quit') {
        console.log('\nClosing chat session...');
        rl.close();
        await client.close();
        process.exit(0);
      }
      
      try {
        // For now, we'll implement basic message handling
        // In a full implementation, you'd want to:
        // 1. Parse the user's intent
        // 2. Call appropriate MCP tools
        // 3. Format and display responses
        
        console.log(`\nProcessing: ${input}\n`);
        
        // This is a placeholder - actual MCP interaction would go here
        // You would typically:
        // - Use client.callTool() to invoke MCP tools
        // - Use client.readResource() to read resources
        // - Handle responses and display them to the user
        
        console.log('Response: MCP integration is ready. Tool invocation will be implemented based on cluster capabilities.\n');
        
      } catch (error) {
        console.error('Error processing message:', error.message);
      }
      
      rl.prompt();
    });
    
    rl.on('close', async () => {
      console.log('\nChat session ended.');
      await client.close();
      process.exit(0);
    });
    
  } catch (error) {
    console.error('\nFailed to connect to MCP gateway:', error.message);
    console.error('\nMake sure:');
    console.error('  - Your cluster is Camunda 8.9 or later');
    console.error('  - The MCP gateway is enabled on your cluster');
    console.error('  - The cluster URL is correct');
    process.exit(1);
  }
}

/**
 * Plugin commands export
 */
export const commands = {
  chat,
};
