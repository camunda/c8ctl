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
import { c8ctl } from 'c8ctl/runtime';

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
import { c8ctl } from 'c8ctl/runtime';

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
  }
};
```

## Plugin Requirements

For a package to be recognized as a c8ctl plugin:

1. Must be a regular Node.js module with proper package.json
2. Must have either `c8ctl-plugin.js` or `c8ctl-plugin.ts` file in root directory
3. Must export a `commands` object with async functions
4. Optionally export a `metadata` object for help text display
5. Must declare c8ctl as a peer dependency in package.json
6. Import c8ctl runtime: `import { c8ctl } from 'c8ctl/runtime'`

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
