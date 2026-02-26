/**
 * {{PLUGIN_NAME}} - A c8ctl plugin
 */

import type { C8ctlPluginRuntime } from '@camunda8/cli/runtime';

// The c8ctl runtime is always populated by the host before plugin code runs
const c8ctl = globalThis.c8ctl as C8ctlPluginRuntime;

// Optional metadata for help text
export const metadata = {
  name: '{{PLUGIN_NAME}}',
  description: 'A c8ctl plugin',
  commands: {
    hello: {
      description: 'Say hello from the plugin',
    },
  },
};

// Required commands export
export const commands = {
  hello: async (args: string[]) => {
    const logger = c8ctl.getLogger();
    const tenantId = c8ctl.resolveTenantId();
    console.log('Hello from {{PLUGIN_NAME}}!');
    console.log('c8ctl version:', c8ctl.version);
    console.log('Node version:', c8ctl.nodeVersion);
    console.log('Platform:', c8ctl.platform, c8ctl.arch);
    console.log('Tenant:', tenantId);

    if (args.length > 0) {
      console.log('Arguments:', args.join(', '));
    }

    // Example: Access c8ctl runtime
    console.log('Current directory:', c8ctl.cwd);
    console.log('Output mode:', c8ctl.outputMode);

    if (c8ctl.activeProfile) {
      console.log('Active profile:', c8ctl.activeProfile);
    }

    logger.info('Plugin logger is ready');

    // Example: create SDK client from current profile/session config
    const client = c8ctl.createClient();
    console.log('Client available:', typeof client === 'object');
  },
};
