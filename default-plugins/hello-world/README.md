# c8ctl-plugin-hello-world

A default "hello world" plugin for c8ctl that demonstrates the complete plugin API and lifecycle.

## Purpose

This plugin serves multiple purposes:

1. **Example**: Shows how to create a fully compliant c8ctl plugin
2. **Documentation**: Demonstrates all plugin API features
3. **Testing**: Validates the plugin system is working correctly
4. **Template**: Provides a reference implementation for new plugins

## Features

- ✅ Complete metadata for help integration
- ✅ Command that displays runtime information
- ✅ Argument handling demonstration
- ✅ Compliant with plugin API requirements
- ✅ Loaded by default as an essential plugin

## Usage

This plugin is loaded automatically with c8ctl. Try it:

```bash
c8ctl hello-world
c8ctl hello-world arg1 arg2 arg3
```

## Plugin Structure

```
hello-world/
├── package.json           # Package metadata with c8ctl keywords
├── c8ctl-plugin.js        # Plugin implementation (ES6 module)
└── README.md              # This file
```

## Requirements

- Package must have `c8ctl` or `c8ctl-plugin` in keywords
- Must export `commands` object with command functions
- Optionally export `metadata` object for help text
- Entry point must be `c8ctl-plugin.js` (or .ts)

## Plugin API

### Storage Locations

Plugins are stored in OS-specific directories:

| OS | Plugin Directory | Registry File |
|----|-----------------|---------------|
| **Linux** | `~/.config/c8ctl/plugins/node_modules` | `~/.config/c8ctl/plugins.json` |
| **macOS** | `~/Library/Application Support/c8ctl/plugins/node_modules` | `~/Library/Application Support/c8ctl/plugins.json` |
| **Windows** | `%APPDATA%\c8ctl\plugins\node_modules` | `%APPDATA%\c8ctl\plugins.json` |

> **Note:** Override with `C8CTL_DATA_DIR` environment variable if needed.

### Runtime Access

The plugin can access c8ctl runtime via `globalThis.c8ctl`:

```javascript
globalThis.c8ctl = {
  version: string;          // c8ctl version
  nodeVersion: string;      // Node.js version
  platform: string;         // OS platform
  arch: string;             // CPU architecture
  cwd: string;              // Current working directory
  outputMode: 'text' | 'json';  // Output format
  activeProfile?: string;   // Active connection profile
  activeTenant?: string;    // Active tenant
  createClient(profile?: string, sdkConfig?: object): CamundaClient; // SDK client factory
  resolveTenantId(profile?: string): string; // Resolve tenant with c8ctl fallback rules
  getLogger(): Logger;      // c8ctl logger instance honoring output mode
};
```

### Command Implementation

Commands receive arguments and return promises:

```javascript
export const commands = {
  'command-name': async (args) => {
    // args is an array of strings
    // Use console.log for output
    // Return a promise or async function
  },
};
```

### Metadata

Provide help text via metadata export:

```javascript
export const metadata = {
  name: 'plugin-name',
  description: 'Plugin description',
  commands: {
    'command-name': {
      description: 'Command description shown in help',
    },
  },
};
```

## Important Limitations

### Command Precedence

**Plugin commands cannot override built-in commands.** The c8ctl CLI always checks for built-in commands first. If a plugin exports a command with the same name as a built-in command (e.g., `list`, `get`, `create`), the built-in command will always execute, and the plugin command will be ignored.

For example, if a plugin tries to export a `list` command:

```javascript
export const commands = {
  'list': async (args) => {
    console.log('This will NEVER execute');
  }
};
```

When users run `c8ctl list`, the built-in `list` command will execute instead. Choose unique command names for your plugins to avoid conflicts.

## Development

To create a similar plugin:

1. Use the scaffolding command:

   ```bash
   c8ctl init plugin my-plugin
   ```

2. Or manually create the structure following this example

3. Test locally:

   ```bash
   c8ctl load plugin --from file:///path/to/plugin
   ```

4. Publish to npm:

   ```bash
   npm publish
   ```

5. Users can install:

   ```bash
   c8ctl load plugin your-plugin-name
   ```

## License

You decide, but our [own Drink-ware](/LICENSE.md) is of course the most fitting :)
