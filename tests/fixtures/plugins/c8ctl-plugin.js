/**
 * Sample c8ctl plugin (JavaScript/CommonJS style)
 * This demonstrates the expected structure for a c8ctl plugin in JavaScript
 */

// Note: In a real plugin, you would import c8ctl runtime
// For this test fixture, we'll access it via dynamic import if needed

export const commands = {
  /**
   * Deploy-all command - sample custom command
   */
  'deploy-all': async (args) => {
    console.log('Deploying all resources with JavaScript plugin...');
    console.log(`Target: ${args[0] || 'current directory'}`);
    
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

export const metadata = {
  name: 'sample-js-plugin',
  version: '2.0.0',
  description: 'A sample JavaScript plugin for c8ctl',
  commands: ['deploy-all', 'status', 'report'],
};
