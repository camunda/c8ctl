# Plugin Test Fixtures

This directory contains sample c8ctl plugin implementations used for testing.

## Files

### c8ctl-plugin.ts
TypeScript implementation demonstrating:
- ES6 module exports
- TypeScript type annotations
- Access to c8ctl runtime object
- Multiple command exports (analyze, validate)
- Metadata for help text

**Usage in plugins:**
```typescript
// c8ctl runtime is available as a global variable
const c8ctl = (globalThis as any).c8ctl;

export const metadata = {
  name: 'my-plugin',
  description: 'My custom c8ctl plugin',
  commands: {
    myCommand: {
      description: 'Does something useful',
    },
  },
};

export const commands = {
  myCommand: async (args: string[]) => {
    console.log(`Platform: ${c8ctl.env.platform}`);
    const client = c8ctl.createClient();
    console.log(`Client factory available: ${typeof client === 'object'}`);
  }
};
```

### c8ctl-plugin.js
JavaScript implementation demonstrating:
- ES6 module exports
- Command with hyphens ('deploy-all')
- Argument handling
- Multiple commands (deploy-all, status, report)
- Metadata for help text

**Usage in plugins:**
```javascript
// c8ctl runtime is available as a global variable
const c8ctl = globalThis.c8ctl;

export const metadata = {
  name: 'my-plugin',
  description: 'My custom c8ctl plugin',
  commands: {
    'my-command': {
      description: 'Does something useful',
    },
  },
};

export const commands = {
  'my-command': async (args) => {
    console.log(`Args: ${args.join(', ')}`);
    console.log(`Version: ${c8ctl.env.version}`);
    console.log(`Has client factory: ${typeof c8ctl.createClient === 'function'}`);
  }
};
```

## Plugin Requirements

For a package to be recognized as a c8ctl plugin:

1. Must be a regular Node.js module with proper package.json
2. Must have `c8ctl-plugin.js` or `c8ctl-plugin.ts` file in root directory
3. Include `c8ctl` or `c8ctl-plugin` in package.json keywords
4. Must export a `commands` object with async functions
5. Optionally export a `metadata` object for help text display
6. Access c8ctl runtime via `globalThis.c8ctl` (automatically injected by c8ctl)
7. Use `globalThis.c8ctl.createClient(profile?, sdkConfig?)` to create Camunda SDK clients
7. Declare `@camunda8/cli` with wildcard `*` as peer dependency

> **Note on TypeScript plugins**: The `c8ctl-plugin.js` entry point must be JavaScript. Node.js doesn't currently support type stripping in `node_modules`. If your plugin is written in TypeScript, you must transpile it to JavaScript before publishing. Your `c8ctl-plugin.ts` source can be TypeScript, but ensure your build process produces a `c8ctl-plugin.js` file.

## Metadata Structure

The optional `metadata` export allows plugins to provide information for the help system:

```typescript
export const metadata = {
  name: 'plugin-name',           // Plugin display name (optional)
  description: 'Plugin desc',    // Plugin description (optional)
  commands: {
    commandName: {
      description: 'What this command does',  // Shows in help
    },
  },
};
```

When a user runs `c8ctl help`, commands from loaded plugins will appear in a "Plugin Commands" section with their descriptions (if provided).

## Testing

These fixtures are used by `tests/unit/plugins.test.ts` to verify:
- Plugin structure validation
- Command export format
- Dynamic import capability
- Runtime object access
- Metadata parsing
