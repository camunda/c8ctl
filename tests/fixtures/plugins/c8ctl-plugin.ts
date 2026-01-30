/**
 * Sample c8ctl plugin (TypeScript)
 * This demonstrates the expected structure for a c8ctl plugin
 */

import { c8ctl } from 'c8ctl/runtime';

export const metadata = {
  name: 'sample-plugin',
  description: 'Sample c8ctl plugin demonstrating custom commands',
  commands: {
    analyze: {
      description: 'Analyze processes and workflows',
    },
    validate: {
      description: 'Validate BPMN files',
    },
  },
};

export const commands = {
  /**
   * Analyze command - sample custom command
   */
  analyze: async (args: string[]) => {
    console.log('Analyzing with TypeScript plugin...');
    console.log(`Arguments: ${args.join(', ')}`);
    console.log(`Running on: ${c8ctl.env.platform} ${c8ctl.env.arch}`);
    console.log(`Node version: ${c8ctl.env.nodeVersion}`);
    console.log(`c8ctl version: ${c8ctl.env.version}`);
  },

  /**
   * Validate command - another sample command
   */
  validate: async (args: string[]) => {
    console.log('Validating...');
    if (args.length === 0) {
      console.error('No files provided for validation');
      process.exit(1);
    }
    console.log(`Validating files: ${args.join(', ')}`);
  },
};
