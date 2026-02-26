/**
 * {{PLUGIN_NAME}} - A c8ctl plugin
 */

type OutputMode = 'text' | 'json';

type PluginLogger = {
  info(message: string): void;
  debug(message: string, ...args: unknown[]): void;
  success(message: string, key?: string | number): void;
  error(message: string, error?: Error): void;
  table(data: unknown[]): void;
  json(data: unknown): void;
};

// The c8ctl runtime is available globally
declare const c8ctl: {
  env: {
    version: string;
    nodeVersion: string;
    platform: string;
    arch: string;
    cwd: string;
    rootDir: string;
  };
  version: string;
  nodeVersion: string;
  platform: string;
  arch: string;
  cwd: string;
  outputMode: OutputMode;
  activeProfile?: string;
  activeTenant?: string;
  createClient(profileFlag?: string, additionalSdkConfig?: Record<string, unknown>): unknown;
  resolveTenantId(profileFlag?: string): string;
  getLogger(mode?: OutputMode): PluginLogger;
};

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
