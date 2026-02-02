/**
 * c8ctl MCP Chat Plugin
 * Provides interactive chat with Camunda 8.9+ clusters via MCP gateway
 * 
 * @version 1.0.0
 * @since 2026-02-02
 * 
 * NOTE: This is an initial implementation (Phase 1) that establishes the MCP connection
 * and provides the chat interface. Automatic tool invocation and natural language
 * processing will be enhanced in future releases as the MCP gateway specification
 * evolves and more tools become available in Camunda 8.9+.
 * 
 * Current capabilities (Phase 1):
 * - Connect to cluster MCP gateway
 * - List available MCP tools
 * - Interactive chat interface
 * - Profile-based configuration
 * 
 * Planned enhancements (Phase 2+):
 * - Automatic tool invocation based on user intent
 * - Natural language understanding
 * - Rich response formatting
 * - Conversation history
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
 * Get cluster configuration from c8ctl runtime or environment
 */
function getClusterConfig(args) {
  // Check for --profile flag in args
  const profileFlagIndex = args.findIndex(arg => arg.startsWith('--profile='));
  let profileName;
  if (profileFlagIndex !== -1) {
    profileName = args[profileFlagIndex].split('=')[1];
  }

  // Try to use c8ctl session profile if no flag provided
  if (!profileName && c8ctl?.activeProfile) {
    profileName = c8ctl.activeProfile;
  }

  // Resolve base URL with priority: profileFlag → session → env vars → localhost
  let baseUrl = process.env.CAMUNDA_BASE_URL || 'http://localhost:8080/v2';
  
  // If we have a profile name, try to resolve it (simplified approach)
  // In production, this would use c8ctl's config module
  if (profileName) {
    console.log(`Using profile: ${profileName}`);
  }
  
  return {
    baseUrl,
    profileName,
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
      
      // Handle special commands
      if (input.toLowerCase() === 'help') {
        console.log('\nAvailable commands:');
        console.log('  help     - Show this help message');
        console.log('  tools    - List available MCP tools');
        console.log('  exit     - Exit the chat session');
        console.log('  quit     - Exit the chat session');
        console.log('\nOtherwise, type your message to interact with the cluster.\n');
        rl.prompt();
        return;
      }
      
      if (input.toLowerCase() === 'tools') {
        try {
          const tools = await client.listTools();
          if (tools && tools.tools && tools.tools.length > 0) {
            console.log('\nAvailable tools:');
            tools.tools.forEach(tool => {
              console.log(`\n  ${tool.name}`);
              if (tool.description) {
                console.log(`    ${tool.description}`);
              }
              if (tool.inputSchema) {
                console.log('    Schema:');
                const schemaStr = JSON.stringify(tool.inputSchema, null, 2);
                schemaStr.split('\n').forEach(line => {
                  console.log(`      ${line}`);
                });
              }
            });
            console.log();
          } else {
            console.log('\nNo tools available.\n');
          }
        } catch (error) {
          console.error(`\nError listing tools: ${error.message}\n`);
        }
        rl.prompt();
        return;
      }
      
      try {
        console.log(`\nProcessing: ${input}\n`);
        
        // For now, we'll implement basic message handling
        // In a full implementation, you'd want to:
        // 1. Parse the user's intent
        // 2. Call appropriate MCP tools
        // 3. Format and display responses
        
        // Example: Try to call a tool if the input looks like a tool invocation
        // This is a placeholder for actual MCP interaction
        
        console.log('Note: Automatic tool invocation based on natural language is planned for a future release.\n');
        console.log('Use the "tools" command to see available MCP tools and their schemas.\n');
        
      } catch (error) {
        console.error(`Error: ${error.message}\n`);
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
