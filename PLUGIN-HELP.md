# Plugin Help Integration

This document describes how c8ctl plugins can provide help text that gets integrated into the main `c8ctl help` command.

## Overview

When users load plugins, their commands automatically appear in the help text. Plugins can optionally provide descriptions for their commands to make the help more informative.

## Global Plugin System

c8ctl uses a global plugin system where plugins are installed to a user-specific directory. This means:

- **No local package.json required**: Plugins work from any directory
- **Global installation**: Plugins are installed to OS-specific directories:
  - **Linux**: `~/.config/c8ctl/plugins/node_modules`
  - **macOS**: `~/Library/Application Support/c8ctl/plugins/node_modules`
  - **Windows**: `%APPDATA%\c8ctl\plugins\node_modules`
- **Plugin registry**: Tracked in `plugins.json` in the same parent directory
- **Persistent across projects**: Once loaded, plugins are available everywhere
- **Centralized management**: All plugins are managed through the c8ctl plugin registry
- **Cannot override built-in commands**: Plugin commands are executed only if no built-in command matches

> **Note:** You can override the default data directory by setting the `C8CTL_DATA_DIR` environment variable.

## Plugin Registry

The plugin registry (`plugins.json`) maintains a list of all installed plugins with metadata:

```json
{
  "plugins": [
    {
      "name": "my-plugin",
      "source": "my-plugin@1.0.0",
      "installedAt": "2024-01-15T10:30:00.000Z"
    }
  ]
}
```

Registry locations by OS:
- **Linux**: `~/.config/c8ctl/plugins.json`
- **macOS**: `~/Library/Application Support/c8ctl/plugins.json`
- **Windows**: `%APPDATA%\c8ctl\plugins.json`

## How It Works

1. **Automatic Discovery**: When `c8ctl help` is invoked, it scans all loaded plugins from the global plugins directory
2. **Plugin Section**: If plugins are loaded, a "Plugin Commands" section appears at the bottom of the help text
3. **Command Listing**: Each plugin command is listed with its optional description

## Plugin Structure for Help

Plugins can export an optional `metadata` object alongside the required `commands` object.

## Plugin Flags

Plugins can declare custom flags per command. Flags are declared inline inside the command entry rather than in a separate top-level export.

To add flags to a command, replace the bare handler function with an object that has `flags` and `handler` properties:

```typescript
export const commands = {
  'my-command': {
    flags: {
      source: {
        type: 'string',
        description: 'Source element ID',
      },
      target: {
        type: 'string',
        description: 'Target element ID',
      },
      detailed: {
        type: 'boolean',
        description: 'Show detailed output',
      },
    },
    handler: async (args: string[], flags?: Record<string, unknown>) => {
      // Flag values are unknown — cast before use
      const source = flags?.source as string | undefined;
      const target = flags?.target as string | undefined;
      const detailed = flags?.detailed as boolean | undefined;
      console.log('Args:', args);
      console.log('Source:', source);
      console.log('Target:', target);
      console.log('Detailed:', detailed);
    },
  },
};
```

Commands without flags continue to use the bare function form:

```typescript
export const commands = {
  'my-command': {
    flags: { /* ... */ },
    handler: async (args, flags) => { /* ... */ },
  },
  'other-command': async (args) => { /* no flags needed */ },
};
```

### Flag Definition Structure

Each flag can have the following properties:

- `type`: `'string'` or `'boolean'` (required)
- `description`: Describes the flag for documentation purposes (required). Not currently shown in `c8ctl help` output.
- `short`: Single-character alias (optional, e.g., `'s'` for `-s`)
- `required`: When `true`, the CLI exits with an error if the flag is omitted (optional, defaults to `false`)

### Example with Flags

```javascript
// c8ctl-plugin.js
export const commands = {
  'model': {
    flags: {
      append: {
        type: 'boolean',
        description: 'Append to existing model instead of replacing',
      },
      source: {
        type: 'string',
        description: 'Source element ID for connection',
        short: 's',
      },
      target: {
        type: 'string',
        description: 'Target element ID for connection',
        short: 't',
      },
    },
    handler: async (args, flags) => {
      const [action] = args;

      if (action === 'connect' && flags?.source && flags?.target) {
        console.log(`Connecting ${flags.source} → ${flags.target}`);
      }

      if (flags?.append) {
        console.log('Appending to existing model');
      }
    },
  },
};

export const metadata = {
  name: 'model-plugin',
  commands: {
    'model': {
      description: 'Modify BPMN models',
      examples: [
        { command: 'c8ctl model connect --source Gateway_1 --target Task_2', description: 'Connect elements' },
        { command: 'c8ctl model connect -s Gateway_1 -t Task_2', description: 'Connect using short flags' },
      ],
    },
  },
};
```

### Backward Compatibility

Commands declared as bare functions continue to work unchanged:
- Existing handlers receive `args` only (the `flags` parameter is `undefined`)
- The handler signature `async (args)` remains valid
- No migration required for commands that don't use custom flags

## Plugin Runtime API

At runtime, c8ctl injects a global `c8ctl` object for plugins via `globalThis.c8ctl`.

- Environment/session fields: `version`, `nodeVersion`, `platform`, `arch`, `cwd`, `outputMode`, `activeProfile`, `activeTenant`
- SDK client factory: `createClient(profile?, sdkConfig?)`
- Tenant resolver: `resolveTenantId(profile?)`
- Logger accessor: `getLogger()`

Use the client factory when your plugin needs direct Camunda API access, `resolveTenantId` to mirror c8ctl tenant fallback behavior, and `getLogger()` to emit output-mode-aware logs.

For TypeScript autocomplete, use the exported runtime type:

```typescript
import type { C8ctlPluginRuntime } from '@camunda8/cli/runtime';

const c8ctl = globalThis.c8ctl as C8ctlPluginRuntime;
const tenantId = c8ctl.resolveTenantId();
const logger = c8ctl.getLogger();
logger.info(`Tenant: ${tenantId}`);
```

### TypeScript Example

```typescript
import { c8ctl } from '@camunda8/cli/runtime';

// Optional metadata export for help text
export const metadata = {
  name: 'my-awesome-plugin',
  description: 'My custom c8ctl plugin',
  commands: {
    analyze: {
      description: 'Analyze BPMN processes for best practices',
      examples: [
        { command: 'c8ctl analyze --all', description: 'Analyze all deployed processes' },
        { command: 'c8ctl analyze --id=myProcess', description: 'Analyze a specific process' },
      ],
    },
    optimize: {
      description: 'Optimize process definitions',
    },
  },
};

// Required commands export
export const commands = {
  analyze: async (args: string[]) => {
    console.log('Analyzing...');
    const client = globalThis.c8ctl.createClient();
    const logger = globalThis.c8ctl.getLogger();
    logger.info('Plugin logger is ready');
    console.log('Client ready:', typeof client === 'object');
    // implementation
  },

  optimize: async (args: string[]) => {
    console.log('Optimizing...');
    // implementation
  },
};
```

### JavaScript Example

```javascript
import { c8ctl } from '@camunda8/cli/runtime';

// Optional metadata export
export const metadata = {
  name: 'my-plugin',
  description: 'My plugin for c8ctl',
  commands: {
    'deploy-all': {
      description: 'Deploy all resources in a directory',
      examples: [
        { command: 'c8ctl deploy-all ./src', description: 'Deploy resources from ./src' },
        { command: 'c8ctl deploy-all --path ./src --preview', description: 'Preview without deploying' },
      ],
    },
    status: {
      description: 'Check cluster status',
    },
  },
};

// Required commands export
export const commands = {
  'deploy-all': {
    flags: {
      preview: {
        type: 'boolean',
        description: 'Preview without deploying',
      },
      path: {
        type: 'string',
        description: 'Directory path to deploy from',
      },
    },
    handler: async (args, flags) => {
      const path = flags?.path || args[0] || './';

      if (flags?.preview) {
        console.log(`Would deploy from: ${path}`);
      } else {
        console.log(`Deploying from: ${path}`);
      }
    },
  },

  status: async (args) => {
    console.log('Checking status...');
  },
};
```

## Help Output Example

Without plugins loaded:

```
c8ctl - Camunda 8 CLI v2.0.0

Usage: c8ctl <command> [resource] [options]

Commands:
  list      <resource>       List resources (pi, ut, inc, jobs, profiles)
  get       <resource> <key> Get resource by key (pi, topology)
  ...
```

With plugins loaded:

```
c8ctl - Camunda 8 CLI v2.0.0

Usage: c8ctl <command> [resource] [options]

Commands:
  list      <resource>       List resources (pi, ut, inc, jobs, profiles)
  get       <resource> <key> Get resource by key (pi, topology)
  ...

Plugin Commands:
  analyze                 Analyze BPMN processes for best practices
  optimize                Optimize process definitions
  deploy-all              Deploy all resources in a directory
  status                  Check cluster status

Examples:
  ...
  c8ctl analyze --all                 Analyze all deployed processes
  c8ctl analyze --id=myProcess        Analyze a specific process
  c8ctl deploy-all ./src              Deploy resources from ./src
  c8ctl deploy-all ./src --dry-run    Preview without deploying
```

### JSON Help Output

In JSON mode (`c8ctl help --output json`), plugin commands appear in the `commands` array with their `examples` included:

```json
{
  "commands": [
    {
      "verb": "analyze",
      "resource": "",
      "resources": [],
      "description": "Analyze BPMN processes for best practices",
      "mutating": false,
      "examples": [
        { "command": "c8ctl analyze --all", "description": "Analyze all deployed processes" },
        { "command": "c8ctl analyze --id=myProcess", "description": "Analyze a specific process" }
      ]
    }
  ]
}
```

### Source-Aware Upgrade and Downgrade

Plugin version changes (`upgrade` / `downgrade`) use the registry `source` value and therefore behave differently based on source type:

- **npm package source**
  - `c8ctl upgrade plugin <name> <version>` installs `<name>@<version>`
  - `c8ctl downgrade plugin <name> <version>` installs `<name>@<version>`
- **URL/git source**
  - `c8ctl upgrade plugin <name> <version>` installs `<source>#<version>`
  - `c8ctl downgrade plugin <name> <version>` installs `<source>#<version>`
- **file source (`file://`)**
  - Version-based upgrade/downgrade is not supported
  - Use `c8ctl load plugin --from <file-url>` after checking out the desired local plugin version

For `c8ctl upgrade plugin <name>` without a version, c8ctl reinstalls the registered source as-is

## Implementation Details

### Plugin Loader

The plugin loader ([src/plugin-loader.ts](src/plugin-loader.ts)) provides:

- `getPluginCommandNames()`: Returns array of command names
- `getPluginCommandsInfo()`: Returns detailed info including descriptions
- Automatic metadata extraction during plugin loading
- Scans the [global plugins directory](#global-plugin-system) for installed plugins

### Help Command

The help command ([src/commands/help.ts](src/commands/help.ts)):

1. Calls `getPluginCommandsInfo()` to retrieve plugin information
2. Builds a "Plugin Commands" section if plugins are loaded
3. Formats commands with descriptions (if available)

### Metadata Structure

```typescript
interface PluginMetadata {
  name?: string;           // Plugin display name (optional)
  description?: string;    // Plugin description (optional)
  commands?: {
    [commandName: string]: {
      description?: string;  // Command description (shown in help)
      examples?: {           // Usage examples (shown in help Examples section)
        command: string;     // Example command string
        description: string; // Brief description of what the example does
      }[];
    };
  };
}
```

## Best Practices

1. **Always provide descriptions**: Helps users discover and understand your commands
2. **Add usage examples**: The `examples` array in metadata shows up in `c8ctl help` and JSON help output, helping users understand how to use your commands
3. **Keep descriptions concise**: Aim for one line (< 60 characters)
4. **Use imperative verbs**: Start with action words (Analyze, Deploy, Check, etc.)
5. **Match command names**: Ensure metadata command names match exported functions
6. **Use unique command names**: Plugin commands cannot override built-in commands (see [Command Precedence](#command-precedence))
7. **TypeScript plugins**: The `c8ctl-plugin.js` entry point must be JavaScript. Node.js doesn't support type stripping in `node_modules`. Transpile TypeScript to JavaScript before publishing your plugin.

## Command Precedence

**Important:** Plugin commands cannot override built-in c8ctl commands. Built-in commands always take precedence.

When c8ctl processes a command, it follows this order:

1. Check for built-in commands (list, get, create, deploy, etc.)
2. If no built-in command matches, check plugin commands
3. Execute the matched command

### Example

If a plugin exports a command named `list`:

```javascript
export const commands = {
  'list': async (args) => {
    console.log('This will NEVER execute');
  }
};
```

When users run `c8ctl list profiles`, the built-in `list` command will execute, not the plugin version.

### Recommendation

Choose descriptive, unique names for your plugin commands that don't conflict with built-in commands. For example:
- ✅ `analyze-process`, `export-data`, `sync-resources`
- ❌ `list`, `get`, `create`, `deploy`

## Testing

See [tests/unit/plugin-loader.test.ts](tests/unit/plugin-loader.test.ts) for unit tests that verify:

- `getPluginCommandsInfo()` returns correct structure
- Help text includes plugin commands
- Metadata is properly parsed

## AGENTS.md in Scaffolded Plugins

When you bootstrap a plugin with `c8ctl init plugin <name>`, the generated project includes an `AGENTS.md` file.

Treat this file as the default implementation contract for coding agents and contributors. It captures:

- plugin contract expectations (`commands`, optional `metadata`, keywords)
- available runtime APIs on global `c8ctl`
- a fast local development loop (`install` → `build` → `load` → `help` → `run`)
- minimal quality checks before considering work complete

Keeping `AGENTS.md` aligned with your plugin design helps autonomous contributors make correct, minimal, and testable changes.

## Example Plugin Development Flow

1. Create plugin with commands:

```typescript
export const commands = {
  myCommand: async () => { /* ... */ }
};
```

1. Add metadata for help:

```typescript
export const metadata = {
  commands: {
    myCommand: {
      description: 'Description shown in help',
      examples: [
        { command: 'c8ctl myCommand --flag', description: 'Example with flag' },
      ],
    }
  }
};
```

1. Load plugin:

```bash
c8ctl load plugin my-plugin
```

1. Verify help includes your command:

```bash
c8ctl help
```

## Migration for Existing Plugins

Existing plugins without metadata will still work! Their commands will appear in the help text without descriptions:

```
Plugin Commands:
  mycommand
  anothercommand
```

To add descriptions, simply export a `metadata` object as shown above.
