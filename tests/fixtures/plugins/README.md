# Plugin Test Fixtures

This directory contains sample c8ctl plugin implementations used for testing.

## Files

### c8ctl-plugin.ts
TypeScript implementation demonstrating:
- ES6 module exports
- TypeScript type annotations
- Access to c8ctl runtime object
- Multiple command exports (analyze, validate)

**Usage in plugins:**
```typescript
import { c8ctl } from 'c8ctl/runtime';

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

**Usage in plugins:**
```javascript
import { c8ctl } from 'c8ctl/runtime';

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
4. Must declare c8ctl as a peer dependency in package.json
5. Import c8ctl runtime: `import { c8ctl } from 'c8ctl/runtime'`

## Testing

These fixtures are used by `tests/unit/plugins.test.ts` to verify:
- Plugin structure validation
- Command export format
- Dynamic import capability
- Runtime object access
