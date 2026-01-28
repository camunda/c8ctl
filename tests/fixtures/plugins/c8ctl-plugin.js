/**
 * Sample c8ctl plugin (JavaScript/CommonJS style)
 * This demonstrates the expected structure for a c8ctl plugin in JavaScript
 */

import { c8ctl } from 'c8ctl/runtime';

export const commands = {
  /**
   * Deploy-all command - sample custom command
   */
  'deploy-all': async (args) => {
    console.log('Deploying all resources with JavaScript plugin...');
    console.log(`Target: ${args[0] || 'current directory'}`);
    console.log(`c8ctl version: ${c8ctl.env.version}`);
    
    // Sample logic
    const files = ['process1.bpmn', 'process2.bpmn', 'decision.dmn'];
    console.log(`Found ${files.length} files to deploy`);
    files.forEach(file => console.log(`  - ${file}`));
  },

  /**
   * Status command - another sample command
   */
  status: async () => {
    console.log('Checking cluster status...');
    console.log('All services operational');
    console.log(`Platform: ${c8ctl.env.platform}`);
  },

  /**
   * Custom report command
   */
  report: async (args) => {
    console.log('Generating report...');
    const format = args.includes('--json') ? 'json' : 'text';
    console.log(`Output format: ${format}`);
  },
};
