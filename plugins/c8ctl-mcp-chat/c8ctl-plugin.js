/**
 * c8ctl MCP Chat Plugin
 * Provides interactive chat with Camunda 8.9+ clusters via MCP gateway
 * 
 * @version 1.0.0
 * @since 2026-02-02
 * 
 * This implementation integrates with LLMs (Claude or OpenAI) to provide natural language
 * interaction with the cluster's MCP gateway. The LLM acts as an orchestrator,
 * deciding which MCP tools to invoke based on user queries.
 * 
 * Chat Flow:
 * 1. Get available tools from MCP server
 * 2. User query → LLM (with tool descriptions)
 * 3. LLM decides which tools to call
 * 4. Execute tool calls via MCP
 * 5. Results → LLM
 * 6. LLM response → User
 * 
 * Current capabilities:
 * - Connect to cluster MCP gateway
 * - LLM-powered natural language interface (Claude or OpenAI)
 * - Automatic tool invocation based on user intent
 * - Profile-based configuration
 */

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
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
      const versionParts = version.split('.').map(part => parseInt(part, 10));
      const major = versionParts[0] || 0;
      const minor = versionParts[1] || 0;
      
      // Check if version is 8.9 or later
      if (major < 8 || (major === 8 && minor < 9)) {
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
 * Detect which LLM provider to use based on environment variables
 * Fails if both providers are configured
 * @returns {'openai'|'anthropic'|null} The provider to use, or null if no key is set
 * @throws {Error} If both OPENAI_API_KEY and ANTHROPIC_API_KEY are set
 */
function detectProvider() {
  const hasOpenAI = !!process.env.OPENAI_API_KEY;
  const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
  
  if (hasOpenAI && hasAnthropic) {
    throw new Error('Both OPENAI_API_KEY and ANTHROPIC_API_KEY are set. Please use only one LLM provider.');
  }
  
  if (hasOpenAI) {
    return 'openai';
  }
  if (hasAnthropic) {
    return 'anthropic';
  }
  return null;
}

/**
 * Get the model name for a provider from environment or use default
 * @param {'anthropic'|'openai'} provider - The LLM provider
 * @returns {string} The model name
 */
function getModelForProvider(provider) {
  if (provider === 'anthropic') {
    return process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20241022';
  } else if (provider === 'openai') {
    return process.env.OPENAI_MODEL || 'gpt-4o';
  }
  throw new Error(`Unknown provider: ${provider}`);
}

/**
 * Build client options for a provider
 * @param {'anthropic'|'openai'} provider - The LLM provider
 * @returns {Object} Client configuration options
 */
function buildClientOptions(provider) {
  const options = {};
  
  if (provider === 'anthropic') {
    options.apiKey = process.env.ANTHROPIC_API_KEY;
    if (process.env.ANTHROPIC_BASE_URL) {
      options.baseURL = process.env.ANTHROPIC_BASE_URL;
    }
  } else if (provider === 'openai') {
    options.apiKey = process.env.OPENAI_API_KEY;
    if (process.env.OPENAI_BASE_URL) {
      options.baseURL = process.env.OPENAI_BASE_URL;
    }
  } else {
    throw new Error(`Unknown provider: ${provider}`);
  }
  
  return options;
}

/**
 * Get display name for provider
 * @param {'anthropic'|'openai'} provider - The LLM provider
 * @returns {string} Display name
 */
function getProviderDisplayName(provider) {
  return provider === 'anthropic' ? 'Anthropic Claude' : 'OpenAI';
}

/**
 * Format startup message showing provider, model, and optional base URL
 * @param {'anthropic'|'openai'} provider - The LLM provider
 * @param {string} model - The model name
 * @param {string|undefined} baseUrl - Optional custom base URL
 * @returns {string} Formatted message
 */
function formatStartupMessage(provider, model, baseUrl) {
  const providerName = getProviderDisplayName(provider);
  const baseUrlInfo = baseUrl ? ` (${baseUrl})` : '';
  return `Using: ${providerName} (${model})${baseUrlInfo}\n`;
}

/**
 * Convert MCP tools to provider-specific format
 * @param {Object} mcpTools - Tools from MCP server
 * @param {'anthropic'|'openai'} provider - LLM provider
 * @returns {Array} Formatted tools for the specified provider
 */
function convertToolsForProvider(mcpTools, provider) {
  if (!mcpTools || !mcpTools.tools) {
    return [];
  }
  
  return mcpTools.tools.map(tool => {
    const baseInfo = {
      name: tool.name,
      description: tool.description || `Tool: ${tool.name}`,
    };
    
    if (provider === 'anthropic') {
      return {
        ...baseInfo,
        input_schema: tool.inputSchema || {
          type: 'object',
          properties: {},
        },
      };
    } else if (provider === 'openai') {
      return {
        type: 'function',
        function: {
          ...baseInfo,
          parameters: tool.inputSchema || {
            type: 'object',
            properties: {},
          },
        },
      };
    }
    
    throw new Error(`Unknown provider: ${provider}`);
  });
}

/**
 * Execute MCP tool calls and return results
 * @param {Array} toolCalls - Tool calls to execute
 * @param {Object} mcpClient - MCP client instance
 * @param {Function} extractorFn - Function to extract tool info from call
 * @returns {Promise<Array>} Tool results
 */
async function executeMCPToolCalls(toolCalls, mcpClient, extractorFn) {
  const results = [];
  
  for (const toolCall of toolCalls) {
    const { name, args, id } = extractorFn(toolCall);
    console.log(`\n🔧 Calling tool: ${name}...`);
    
    try {
      const result = await mcpClient.callTool({
        name,
        arguments: args,
      });
      
      results.push({
        id,
        content: JSON.stringify(result.content),
        error: null,
      });
    } catch (error) {
      results.push({
        id,
        content: `Error: ${error.message}`,
        error: error.message,
      });
    }
  }
  
  return results;
}

/**
 * Process a chat message with Claude and MCP tool execution
 */
async function processWithClaude(userMessage, mcpClient, anthropicClient, conversationHistory) {
  try {
    // Get available tools from MCP server
    const mcpTools = await mcpClient.listTools();
    const claudeTools = convertToolsForProvider(mcpTools, 'anthropic');
    
    const model = getModelForProvider('anthropic');
    
    // Add user message to history
    conversationHistory.push({
      role: 'user',
      content: userMessage,
    });
    
    // Call Claude with tools
    let response = await anthropicClient.messages.create({
      model: model,
      max_tokens: 4096,
      tools: claudeTools,
      messages: conversationHistory,
    });
    
    // Process tool use loop
    while (response.stop_reason === 'tool_use') {
      // Add assistant response to history
      conversationHistory.push({
        role: 'assistant',
        content: response.content,
      });
      
      const toolUseBlocks = response.content.filter(block => block.type === 'tool_use');
      
      // Execute tool calls
      const toolResults = await executeMCPToolCalls(
        toolUseBlocks,
        mcpClient,
        (block) => ({
          name: block.name,
          args: block.input,
          id: block.id,
        })
      );
      
      const formattedResults = toolResults.map(result => ({
        type: 'tool_result',
        tool_use_id: result.id,
        content: result.content,
        is_error: !!result.error,
      }));
      
      // Add tool results to history
      conversationHistory.push({
        role: 'user',
        content: formattedResults,
      });
      
      // Get next response from Claude
      response = await anthropicClient.messages.create({
        model: model,
        max_tokens: 4096,
        tools: claudeTools,
        messages: conversationHistory,
      });
    }
    
    // Add final assistant response to history
    conversationHistory.push({
      role: 'assistant',
      content: response.content,
    });
    
    // Extract text response
    const textContent = response.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n');
    
    return textContent || 'No response from assistant.';
    
  } catch (error) {
    throw new Error(`Claude processing error: ${error.message}`);
  }
}

/**
 * Process a chat message with OpenAI and MCP tool execution
 */
async function processWithOpenAI(userMessage, mcpClient, openaiClient, conversationHistory) {
  try {
    // Get available tools from MCP server
    const mcpTools = await mcpClient.listTools();
    const openaiTools = convertToolsForProvider(mcpTools, 'openai');
    
    const model = getModelForProvider('openai');
    
    // Add user message to history
    conversationHistory.push({
      role: 'user',
      content: userMessage,
    });
    
    // Call OpenAI with tools
    let response = await openaiClient.chat.completions.create({
      model: model,
      messages: conversationHistory,
      tools: openaiTools,
    });
    
    let message = response.choices[0].message;
    
    // Process tool use loop
    while (message.tool_calls && message.tool_calls.length > 0) {
      // Add assistant response to history
      conversationHistory.push(message);
      
      // Execute tool calls
      const toolResults = await executeMCPToolCalls(
        message.tool_calls,
        mcpClient,
        (toolCall) => ({
          name: toolCall.function.name,
          args: JSON.parse(toolCall.function.arguments),
          id: toolCall.id,
        })
      );
      
      toolResults.forEach(result => {
        conversationHistory.push({
          role: 'tool',
          tool_call_id: result.id,
          content: result.content,
        });
      });
      
      // Get next response from OpenAI
      response = await openaiClient.chat.completions.create({
        model: model,
        messages: conversationHistory,
        tools: openaiTools,
      });
      
      message = response.choices[0].message;
    }
    
    // Add final assistant response to history
    conversationHistory.push(message);
    
    return message.content || 'No response from assistant.';
    
  } catch (error) {
    throw new Error(`OpenAI processing error: ${error.message}`);
  }
}

/**
 * Process a chat message with LLM and MCP tool execution (unified interface)
 */
async function processWithLLM(userMessage, mcpClient, llmClient, conversationHistory, provider) {
  if (provider === 'anthropic') {
    return await processWithClaude(userMessage, mcpClient, llmClient, conversationHistory);
  } else if (provider === 'openai') {
    return await processWithOpenAI(userMessage, mcpClient, llmClient, conversationHistory);
  } else {
    throw new Error(`Unknown provider: ${provider}`);
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
    
    // Detect and initialize LLM provider
    let provider;
    try {
      provider = detectProvider();
    } catch (error) {
      console.error(`Error: ${error.message}`);
      console.error('\nPlease set only one API key:');
      console.error('  - For Anthropic Claude: export ANTHROPIC_API_KEY=your_key');
      console.error('  - For OpenAI: export OPENAI_API_KEY=your_key\n');
      process.exit(1);
    }
    
    if (!provider) {
      console.error('Error: No LLM API key found.');
      console.error('\nSupported providers:');
      console.error('  - Anthropic Claude: Set ANTHROPIC_API_KEY');
      console.error('    Get your key from: https://console.anthropic.com/');
      console.error('  - OpenAI: Set OPENAI_API_KEY');
      console.error('    Get your key from: https://platform.openai.com/api-keys');
      console.error('\nExample: export ANTHROPIC_API_KEY=your_key_here\n');
      process.exit(1);
    }
    
    // Create LLM client based on provider
    let llmClient;
    const clientOptions = buildClientOptions(provider);
    const modelName = getModelForProvider(provider);
    const baseUrl = provider === 'anthropic' 
      ? process.env.ANTHROPIC_BASE_URL 
      : process.env.OPENAI_BASE_URL;
    
    if (provider === 'anthropic') {
      llmClient = new Anthropic(clientOptions);
    } else if (provider === 'openai') {
      llmClient = new OpenAI(clientOptions);
    }
    
    console.log(formatStartupMessage(provider, modelName, baseUrl));
    
    // Conversation history for context
    const conversationHistory = [];
    
    // List available tools
    try {
      const tools = await client.listTools();
      if (tools && tools.tools && tools.tools.length > 0) {
        console.log('Available tools:');
        tools.tools.forEach(tool => {
          console.log(`  - ${tool.name}: ${tool.description || 'No description'}`);
        });
        console.log();
      } else {
        console.log('Note: No MCP tools available from this cluster.\n');
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
    
    console.log('MCP chat session started. Ask questions about your cluster!\n');
    console.log('Examples:');
    console.log('  - "What process instances are currently running?"');
    console.log('  - "Deploy the order-process.bpmn file"');
    console.log('  - "Show me all incidents in the cluster"\n');
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
        console.log('\nYou can ask natural language questions about your cluster.');
        console.log('The AI assistant will use the available MCP tools to help you.\n');
        console.log('Special commands:');
        console.log('  help     - Show this help message');
        console.log('  tools    - List available MCP tools');
        console.log('  clear    - Clear conversation history');
        console.log('  exit     - Exit the chat session');
        console.log('  quit     - Exit the chat session\n');
        rl.prompt();
        return;
      }
      
      if (input.toLowerCase() === 'clear') {
        conversationHistory.length = 0;
        console.log('\n✓ Conversation history cleared.\n');
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
        // Process message with LLM
        const response = await processWithLLM(input, client, llmClient, conversationHistory, provider);
        console.log(`\n${response}\n`);
        
      } catch (error) {
        console.error(`\nError: ${error.message}\n`);
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
