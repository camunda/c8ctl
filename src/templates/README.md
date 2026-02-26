# {{PLUGIN_NAME}}

A c8ctl plugin.

## Development

1. Install dependencies:
```bash
npm install
```

2. Build the plugin:
```bash
npm run build
```

3. Load the plugin for testing:
```bash
c8ctl load plugin --from file://${PWD}
```

4. Test the plugin command:
```bash
c8ctl hello
```

## Plugin Structure

- `src/c8ctl-plugin.ts` - Plugin source code (TypeScript)
- `dist/c8ctl-plugin.js` - Compiled plugin file (JavaScript)
- `c8ctl-plugin.js` - Root plugin entry point re-exporting from `dist/`
- `package.json` - Package metadata with c8ctl keywords

## Publishing

Before publishing, ensure:
- The plugin is built (`npm run build`)
- The package.json has correct metadata
- Keywords include 'c8ctl' or 'c8ctl-plugin'

Then publish to npm:
```bash
npm publish
```

Users can install your plugin with:
```bash
c8ctl load plugin {{PLUGIN_NAME}}
```
