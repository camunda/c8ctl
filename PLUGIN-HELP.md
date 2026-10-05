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

### Where flags go on the command line

c8ctl parses the command line in two stages. Stage 1 reads only c8ctl's **global** flags from the front of the line and stops at the first positional — the command name. Stage 2 parses everything after the command name against `global flags ∪ the command's own flags`. So a plugin flag must follow the command name (`c8ctl my-command --label x`). `c8ctl --label x my-command` is rejected with an error that says so — `Flag --label is not a global flag; command-specific flags go after the command. Did you mean: c8ctl my-command --label x` — rather than treating `x` as the command. (The corrected order is suggested only when the plugin declares the flag; otherwise the error lists the global flags that are allowed before a command.) Global flags are accepted on either side of the command name. A plugin flag may reuse the name of a built-in verb's flag (such as `--limit`); only collisions with global flags are blocked.

### Flag Definition Structure

Each flag can have the following properties:

- `type`: `'string'` or `'boolean'` (required)
- `description`: Describes the flag (required). It is shown next to the flag in the `Flags:` block of `c8ctl help <command>`.
- `short`: Single-character alias (optional, e.g., `'s'` for `-s`)
- `required`: When `true`, the CLI exits with an error if the flag is omitted (optional, defaults to `false`)
- `multiple`: When `true` (string flags only), the flag may be repeated and the handler receives an array

#### Reserved names (flags c8ctl consumes itself)

Only c8ctl's **global** flags are reserved. A plugin flag cannot use these names, because c8ctl consumes them before the plugin sees the command line:

| Long name | Short |
|-----------|-------|
| `--help` | `-h` |
| `--version` | `-v` |
| `--profile` | |
| `--dry-run` | |
| `--verbose` | |
| `--fields` | |
| `--json` | |
| `--yes` | `-y` |

Everything else is yours, including names that some built-in commands use, such as `--limit`, `--all`, `--asc`, `--desc`, `--sortBy`, `--id` or `--name`. A plugin flag only ever competes with the globals.

What happens when a plugin declares a reserved name:

- **Long name** (e.g. `--verbose`): the plugin flag is never delivered; c8ctl treats the token as the global. It is left out of `c8ctl help <command>`. If a user types it, c8ctl warns that the flag is reserved and not passed to the plugin. Nothing is printed on invocations that do not use it, and `c8ctl doctor plugin` lists every such declaration for the plugin author.
- **Long name with `required: true`**: the command can never succeed, so c8ctl refuses to run it and exits with an actionable error asking the author to rename the flag.
- **Short alias** (e.g. `short: 'y'`): only the alias is dropped. The long flag keeps working, `c8ctl help` does not advertise the alias, and typing the alias warns.

#### Reading global values: the `ctx` argument

A flag handler is called as `handler(args, flags, ctx)`. Read global flags from `ctx`, not from `flags`:

| Global flag | `ctx` field |
|-------------|-------------|
| `--profile` (or the session profile) | `ctx.profile` |
| `--dry-run` | `ctx.dryRun` |
| `--verbose` | `ctx.verbose` |
| `--json` / session output mode | `ctx.outputMode` |
| `--yes` | `ctx.yes` |
| `--fields` | `ctx.fields` |

`ctx` also carries `ctx.logger`, `ctx.prompt` and a lazily created `ctx.client`. A bare-function handler receives `ctx` as its third argument too, after a `flags` argument that is `undefined`.

#### How flag values are parsed

- `--foo=x` and `--foo x` both give `foo: "x"`.
- A string flag given **no value** — because the next token is another flag, or the line ends — gives `foo: true`. It never swallows the next flag: `--foo --bar` gives `foo: true` and `bar: true`. (Use `--foo=` for an explicit empty string.)
- A value that only *starts* with a dash but is not a flag the command knows is still a value: `--foo -5` gives `foo: "-5"`.
- After a `--` terminator nothing is parsed as a flag.
- A flag the plugin did not declare (and that is not a global) is **not delivered**. c8ctl prints a warning, `Unknown flag --x for '<command>'; declared flags: ...`, and runs the command anyway. The warning is also printed for bare-function commands, which declare no flags.

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

### A bare-function handler receives only positionals

**A bare-function command (`'my-command': async (args) => { ... }`) is handed only the parsed positional arguments that follow the command name. It never sees any flag.** The host parses the command line itself; every flag the command did not declare is consumed and discarded before the handler runs — c8ctl's global flags (`--profile`, `--json`, `--yes`, ...) take effect in the host, and unknown flags such as `--purge` or `--stdin` are dropped (the handler cannot even tell they were typed; c8ctl prints an `Unknown flag ... for '<command>'` warning so the user notices). A handler that checks `args.includes('--purge')` will never see it true.

A command that needs flags must opt into one of the two supported forms:

| Need | Use | The handler receives |
|------|-----|----------------------|
| A fixed set of flags you can enumerate | `{ flags, handler }` (see [Plugin Flags](#plugin-flags)) | `args` (positionals) and `flags` (typed, validated values) |
| The raw command line, e.g. to forward to another tool, or a flag set you cannot enumerate | `passthrough: true` in the command's metadata (below) | `args` = every token after the command name except c8ctl's global flags |

Do **not** work around this by re-reading `process.argv` inside a handler: it duplicates the host's global-flag handling, breaks when a global flag sits between the tokens you are looking for, and bypasses help and validation.

### Passthrough commands

```javascript
export const metadata = {
  name: 'my-plugin',
  commands: {
    'my-command': {
      description: 'Wraps some-tool',
      passthrough: true,
      // Required: names the boundary in `c8ctl help my-command`.
      passthroughHint: 'Forwards everything after the command name to some-tool',
      // Optional, documentation only (not parsed by c8ctl).
      flagsHint: ['--purge  Also delete data'],
    },
  },
};

export const commands = {
  // Bare function; the third argument is the plugin host context.
  'my-command': async (args, _flags, ctx) => {
    // args: ['start', '--debug', 'x'] for `c8ctl my-command start --debug x`
  },
};
```

- A command is **either** passthrough **or** `{ flags, handler }` — declaring both is rejected at load time, so a command cannot mix declared flags with raw ones. A command whose subcommands need both (like `cluster`, which has its own `--purge` and forwards arbitrary flags to `c8run secrets`) should be a passthrough command and parse its own flags.
- c8ctl strips only its **global** flags (`--help`, `--version`/`-v`, `--profile`, `--dry-run`, `--verbose`, `--fields`, `--json`, `--yes`/`-y`), including the value of string-typed ones. They are not forwarded. If the wrapped tool needs one of those names (for example `--yes`), read the host's interpretation from `ctx` (`ctx.yes`, `ctx.profile`, `ctx.dryRun`, ...) and forward it explicitly.
- A `--` terminator is forwarded too, and everything after it verbatim, global flag names included.

## Plugin Runtime API

At runtime, c8ctl injects a global `c8ctl` object for plugins via `globalThis.c8ctl`.

- Environment/session fields: `version`, `nodeVersion`, `platform`, `arch`, `cwd`, `outputMode`, `activeProfile`, `activeTenant`
- SDK client factory: `createClient(profile?, sdkConfig?)`
- Tenant resolver: `resolveTenantId(profile?)`
- Logger accessor: `getLogger()`
- User data directory: `getUserDataDir()`
- Cross-platform npm runner: `npm({ args, stdout?, stdio? })`

Use the client factory when your plugin needs direct Camunda API access, `resolveTenantId` to mirror c8ctl tenant fallback behavior, and `getLogger()` to emit output-mode-aware logs.

### Logger output

`logger.info(message)` writes plain text to stdout in text mode and a `{"status":"info","message":"..."}` envelope to stderr in JSON mode. Pass `{ stream: "stdout" }` as the second argument for a primary result, or `{ stream: "stderr" }` for a diagnostic in either mode. Formatting remains mode-aware; the override affects only that call and does not apply `--fields` filtering.

Use `logger.output(content)` for raw stdout content and `logger.json(data)` for structured data with `--fields` filtering.

### Declaring the c8ctl version you need

This surface grows: `npm({ ... })` is newer than the rest of it, and a plugin calling it on an older c8ctl gets `TypeError: c8ctl.npm is not a function` from inside its own handler. Declare the floor instead, in the plugin's `package.json` (#523):

```json
{
  "engines": {
    "c8ctl": ">=4.0.0-alpha.1"
  }
}
```

c8ctl then refuses `load plugin` / `upgrade plugin` / `downgrade plugin` on a host that is too old, and disables the plugin's commands with a message naming the required and running versions, rather than letting them fail deeper in. `doctor plugin` reports the requirement and any incompatibility in text and `--json`.

Range evaluation delegates to `semver` (npm's own library for `engines` fields), with `includePrerelease` on, so the full npm range grammar is supported — comparators (`>=`, `>`, `<=`, `<`, `^`, `~`, an exact version, `*`), set unions (`"^3 || ^4"`), hyphen ranges (`"3.3.0 - 4.0.0"`), and partial or wildcard versions (`"^4"`, `"4.x"`). Prereleases order as semver specifies (`>=4.0.0` excludes `4.0.0-alpha.1`, and `^4.1.0` excludes `5.0.0-alpha.1`).

A range `semver` cannot parse (`"latest"`, `">=four"`) lands on the same fail-open path as c8ctl running as an unpublished development build: the plugin stays fully enabled, because the check never disables a plugin over a question it could not answer. See [docs/plugins.md](docs/plugins.md#the-c8ctl-version-a-plugin-needs) for the user-facing view.

### Running npm from a plugin

Use `c8ctl.npm()` rather than spawning npm yourself. On Windows npm is a `npm.cmd` shim: a bare `npm` spawn fails with `ENOENT`, and `npm.cmd` alone fails with `EINVAL` under the CVE-2024-27980 hardening in Node 18.20.2 / 20.12.2 / 21.7.3+. The runtime helper routes the call through `cmd.exe` with every argument quoted (plugin paths routinely contain spaces) and rejects arguments that cannot be passed safely — an embedded `"`, a line break, or a `%VAR%` reference.

```typescript
// Capture stdout
const { stdout } = c8ctl.npm({ args: ['view', 'c8ctl-plugin-foo', 'version'], stdout: true });

// Stream to the terminal instead (stdio is forwarded to the child)
c8ctl.npm({ args: ['install', 'c8ctl-plugin-foo'], stdio: 'inherit' });
```

`stdout: true` returns `{ stdout: string }`; omitting it returns `undefined`. A non-zero npm exit throws.

#### Installing into a directory with `--prefix`

`npm install --prefix <dir>` with no package spec misbehaves on Windows: npm applies the CLI `--prefix` to the global prefix too, and because the Windows global install root is `<prefix>\node_modules` (rather than `<prefix>/lib/node_modules` as on POSIX) npm decides the install is global, rewrites the empty argument list to `.`, and resolves that against the process cwd — so it reads the wrong `package.json` ([#526](https://github.com/camunda/c8ctl/issues/526)). `c8ctl.npm()` detects this exact shape on Windows and instead runs npm with its cwd set to the prefix directory, which is equivalent and correct. Plugins do not need to change their cwd or use an npm-specific option form, and POSIX invocations are untouched. The re-scope is bounded (`--workspaces=false`) so npm resolves exactly that directory rather than promoting the install to a workspace root above it, and a prefix that is itself a workspace root is left untouched.

```typescript
// Works the same on Linux, macOS and Windows
c8ctl.npm({ args: ['install', '--prefix', projectDir], stdout: true });
```

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

The help command ([src/framework/ui/help.ts](src/framework/ui/help.ts)):

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

### Naming convention: prefix with your plugin's short name

Plugin commands also collide with **other plugins'** commands. c8ctl
applies first-registration-wins for plugin-vs-plugin command collisions
and surfaces the dropped command via `c8ctl doctor plugin`, but the best
fix is to avoid the collision in the first place.

The recommended convention is to prefix every command your plugin
exports with a short, plugin-specific tag — typically derived from the
package name:

- ✅ `c8ctl-plugin-mycorp` exports `mycorp-model`, `mycorp-export`
- ✅ `c8ctl-plugin-acme` exports `acme-deploy`, `acme-status`
- ❌ Two plugins both exporting `model` (one will be dropped at load
  time — c8ctl logs a `logger.warn` on stderr and surfaces the drop via
  `c8ctl doctor plugin`, but the colliding command itself is unreachable)

This is **not enforced** — c8ctl will load any command name that
doesn't collide with a built-in — but a published convention reduces
the rate of real-world collisions and makes the dropped-command warning
actionable when it does fire.

For the collision policy, the diagnostic output, and the reproduction
recipe, see [docs/plugin-collisions.md](docs/plugin-collisions.md).

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
