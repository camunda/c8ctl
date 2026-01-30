# Plugin Help Integration

This document describes how c8ctl plugins can provide help text that gets integrated into the main `c8ctl help` command.

## Overview

When users load plugins, their commands automatically appear in the help text. Plugins can optionally provide descriptions for their commands to make the help more informative.

## How It Works

1. **Automatic Discovery**: When `c8ctl help` is invoked, it scans all loaded plugins
2. **Plugin Section**: If plugins are loaded, a "Plugin Commands" section appears at the bottom of the help text
3. **Command Listing**: Each plugin command is listed with its optional description

## Plugin Structure for Help

Plugins can export an optional `metadata` object alongside the required `commands` object:

### TypeScript Example

```typescript
import { c8ctl } from 'c8ctl/runtime';

// Optional metadata export for help text
export const metadata = {
  name: 'my-awesome-plugin',
  description: 'My custom c8ctl plugin',
  commands: {
    analyze: {
      description: 'Analyze BPMN processes for best practices',
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
import { c8ctl } from 'c8ctl/runtime';

// Optional metadata export
export const metadata = {
  name: 'my-plugin',
  description: 'My plugin for c8ctl',
  commands: {
    'deploy-all': {
      description: 'Deploy all resources in a directory',
    },
    status: {
      description: 'Check cluster status',
    },
  },
};

// Required commands export
export const commands = {
  'deploy-all': async (args) => {
    console.log('Deploying all...');
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
```

## Implementation Details

### Plugin Loader

The plugin loader ([src/plugin-loader.ts](src/plugin-loader.ts)) provides:

- `getPluginCommandNames()`: Returns array of command names
- `getPluginCommandsInfo()`: Returns detailed info including descriptions
- Automatic metadata extraction during plugin loading

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
    };
  };
}
```

## Best Practices

1. **Always provide descriptions**: Helps users discover and understand your commands
2. **Keep descriptions concise**: Aim for one line (< 60 characters)
3. **Use imperative verbs**: Start with action words (Analyze, Deploy, Check, etc.)
4. **Match command names**: Ensure metadata command names match exported functions

## Testing

See [tests/unit/plugin-loader.test.ts](tests/unit/plugin-loader.test.ts) for unit tests that verify:
- `getPluginCommandsInfo()` returns correct structure
- Help text includes plugin commands
- Metadata is properly parsed

## Example Plugin Development Flow

1. Create plugin with commands:
```typescript
export const commands = {
  myCommand: async () => { /* ... */ }
};
```

2. Add metadata for help:
```typescript
export const metadata = {
  commands: {
    myCommand: {
      description: 'Description shown in help'
    }
  }
};
```

3. Load plugin:
```bash
c8ctl load plugin my-plugin
```

4. Verify help includes your command:
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
