/**
 * Sample c8ctl plugin (JavaScript)
 * This demonstrates the expected structure for a c8ctl plugin in JavaScript
 */

// c8ctl runtime is available as a global variable
const c8ctl = globalThis.c8ctl;

export const metadata = {
  name: 'sample-js-plugin',
  description: 'Sample c8ctl plugin demonstrating custom commands',
  commands: {
    analyze: {
      description: 'Analyze processes and workflows',
    },
    validate: {
      description: 'Validate BPMN files',
    },
    config: {
      description: 'Manage configuration (get, set, list)',
    },
  },
};

export const commands = {
  /**
   * Analyze command - sample custom command
   */
  'analyze': async (args) => {
    console.log('Analyzing with JavaScript plugin...');
    console.log(`Arguments: ${args.join(', ')}`);
    console.log(`Running on: ${c8ctl.env.platform} ${c8ctl.env.arch}`);
    console.log(`Node version: ${c8ctl.env.nodeVersion}`);
    console.log(`c8ctl version: ${c8ctl.env.version}`);
  },

  /**
   * Validate command - another sample command
   */
  validate: async (args) => {
    console.log('Validating...');
    if (args.length === 0) {
      console.error('No files provided for validation');
      process.exit(1);
    }
    console.log(`Validating files: ${args.join(', ')}`);
  },

  /**
   * Config command - demonstrates handling subcommands
   */
  config: async (args) => {
    const [subcommand, ...rest] = args;
    
    if (!subcommand) {
      console.error('Error: Subcommand required');
      console.log('Usage:');
      console.log('  c8 config get <key>        Get configuration value');
      console.log('  c8 config set <key> <val>  Set configuration value');
      console.log('  c8 config list             List all configuration');
      process.exit(1);
    }
    
    if (subcommand === 'get') {
      const key = rest[0];
      if (!key) {
        console.error('Error: Configuration key is required');
        console.log('Usage: c8 config get <key>');
        process.exit(1);
      }
      console.log(`Getting config for: ${key}`);
      console.log(`Value: sample-value-${key}`);
      return;
    }
    
    if (subcommand === 'set') {
      const [key, value] = rest;
      if (!key || !value) {
        console.error('Error: Both key and value are required');
        console.log('Usage: c8 config set <key> <value>');
        process.exit(1);
      }
      console.log(`Setting config: ${key} = ${value}`);
      console.log('✓ Configuration updated');
      return;
    }
    
    if (subcommand === 'list') {
      console.log('Configuration:');
      console.log('  timeout: 30s');
      console.log('  retries: 3');
      console.log('  format: json');
      return;
    }
    
    console.error(`Error: Unknown subcommand '${subcommand}'`);
    console.log('Usage:');
    console.log('  c8 config get <key>        Get configuration value');
    console.log('  c8 config set <key> <val>  Set configuration value');
    console.log('  c8 config list             List all configuration');
    process.exit(1);
  },
};
