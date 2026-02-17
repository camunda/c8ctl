/**
 * Plugin management commands
 */

import { getLogger } from '../logger.ts';
import { execSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { clearLoadedPlugins } from '../plugin-loader.ts';
import { ensurePluginsDir } from '../config.ts';
import {
  addPluginToRegistry,
  removePluginFromRegistry,
  getRegisteredPlugins,
  isPluginRegistered,
  getPluginEntry,
  type PluginEntry,
} from '../plugin-registry.ts';

/**
 * Load a plugin (npm install wrapper)
 * Supports either package name or --from flag with URL
 * Installs to global plugins directory
 */
export async function loadPlugin(packageNameOrFrom?: string, fromUrl?: string): Promise<void> {
  const logger = getLogger();
  
  // Validate exclusive usage
  if (packageNameOrFrom && fromUrl) {
    logger.error('Cannot specify both package name and --from flag. Use either "c8 load plugin <name>" or "c8 load plugin --from <url>"');
    process.exit(1);
  }
  
  if (!packageNameOrFrom && !fromUrl) {
    logger.error('Package name or --from URL required. Usage: c8 load plugin <package-name> OR c8 load plugin --from <url>');
    process.exit(1);
  }
  
  // Get global plugins directory
  const pluginsDir = ensurePluginsDir();
  
  try {
    let pluginName: string;
    let pluginSource: string;
    
    if (fromUrl) {
      // Install from URL (file://, https://, git://, etc.)
      logger.info(`Loading plugin from: ${fromUrl}...`);
      execSync(`npm install ${fromUrl} --prefix "${pluginsDir}"`, { stdio: 'inherit' });
      
      // Extract package name from installed package
      pluginName = extractPackageNameFromUrl(fromUrl, pluginsDir);
      pluginSource = fromUrl;
      
      // Validate plugin name
      if (!pluginName || pluginName.trim() === '') {
        logger.error('Failed to extract plugin name from URL');
        logger.info('💡 Actionable hint: Ensure the URL points to a valid npm package with a package.json file');
        process.exit(1);
      }
      
      logger.success('Plugin loaded successfully from URL', fromUrl);
    } else {
      // Install from npm registry by package name
      logger.info(`Loading plugin: ${packageNameOrFrom}...`);
      execSync(`npm install ${packageNameOrFrom} --prefix "${pluginsDir}"`, { stdio: 'inherit' });
      
      pluginName = packageNameOrFrom!;
      pluginSource = packageNameOrFrom!;
      
      logger.success('Plugin loaded successfully', packageNameOrFrom);
    }
    
    // Add to plugin registry
    addPluginToRegistry(pluginName, pluginSource);
    logger.debug(`Added ${pluginName} to plugin registry`);
    
    // Note: Plugin will be available on next CLI invocation
    // We don't reload in the same process to avoid module cache issues
    logger.info('Plugin will be available on next command execution');
  } catch (error) {
    logger.error('Failed to load plugin', error as Error);
    logger.info('💡 Actionable hint: Check that the plugin name/URL is correct and you have network access if loading from a remote source');
    process.exit(1);
  }
}

/**
 * Check if a package has a c8ctl plugin file
 */
function hasPluginFile(packagePath: string): boolean {
  return existsSync(join(packagePath, 'c8ctl-plugin.js')) ||
         existsSync(join(packagePath, 'c8ctl-plugin.ts'));
}

/**
 * Check if a package is a valid c8ctl plugin
 */
function isValidPlugin(pkgPath: string): boolean {
  const pkgJsonPath = join(pkgPath, 'package.json');
  if (!existsSync(pkgJsonPath)) return false;
  
  try {
    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
    return hasPluginFile(pkgPath) && pkgJson.keywords?.includes('c8ctl');
  } catch {
    return false;
  }
}

/**
 * Get package name from a valid plugin directory
 */
function getPackageName(pkgPath: string): string | null {
  const pkgJsonPath = join(pkgPath, 'package.json');
  try {
    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
    return pkgJson.name;
  } catch {
    return null;
  }
}

/**
 * Scan directory entries for c8ctl plugins
 */
function scanForPlugin(nodeModulesPath: string, entries: string[]): string | null {
  for (const entry of entries.filter(e => !e.startsWith('.'))) {
    const pkgPath = entry.startsWith('@')
      ? null // Scoped packages handled separately
      : join(nodeModulesPath, entry);
    
    if (pkgPath && isValidPlugin(pkgPath)) {
      return getPackageName(pkgPath);
    }
    
    // Handle scoped packages
    if (entry.startsWith('@')) {
      const scopePath = join(nodeModulesPath, entry);
      try {
        const scopedPackages = readdirSync(scopePath);
        for (const scopedPkg of scopedPackages) {
          const pkgPath = join(scopePath, scopedPkg);
          if (isValidPlugin(pkgPath)) {
            return getPackageName(pkgPath);
          }
        }
      } catch {
        // Skip scoped packages that can't be read
      }
    }
  }
  return null;
}

/**
 * Extract package name from URL or installed package
 * Tries to read package.json from installed package, falls back to URL parsing
 */
function extractPackageNameFromUrl(url: string, pluginsDir: string): string {
  // Try to scan node_modules to find the package by reading package.json
  try {
    const nodeModulesPath = join(pluginsDir, 'node_modules');
    if (existsSync(nodeModulesPath)) {
      const entries = readdirSync(nodeModulesPath);
      const foundName = scanForPlugin(nodeModulesPath, entries);
      if (foundName) return foundName;
    }
  } catch (error) {
    // Fall through to URL-based name extraction
  }
  
  // Fallback: extract from URL pattern
  const match = url.match(/\/([^\/]+?)(\.git)?$/);
  return match ? match[1] : url.replace(/[^a-zA-Z0-9-_@\/]/g, '-');
}

/**
 * Unload a plugin (npm uninstall wrapper)
 * Uninstalls from global plugins directory
 */
export async function unloadPlugin(packageName: string): Promise<void> {
  const logger = getLogger();
  
  if (!packageName) {
    logger.error('Package name required. Usage: c8 unload plugin <package-name>');
    process.exit(1);
  }
  
  // Get global plugins directory
  const pluginsDir = ensurePluginsDir();
  
  try {
    logger.info(`Unloading plugin: ${packageName}...`);
    execSync(`npm uninstall ${packageName} --prefix "${pluginsDir}"`, { stdio: 'inherit' });
    
    // Only remove from registry after successful uninstall
    removePluginFromRegistry(packageName);
    logger.debug(`Removed ${packageName} from plugin registry`);
    
    // Clear the loaded plugins cache so the plugin is no longer available
    // This affects the current process - plugin will be gone immediately
    clearLoadedPlugins();
    
    logger.success('Plugin unloaded successfully', packageName);
    logger.info('Plugin commands are no longer available');
  } catch (error) {
    logger.error('Failed to unload plugin', error as Error);
    logger.info('💡 Actionable hint: Verify the plugin name is correct by running "c8 list plugins"');
    process.exit(1);
  }
}

/**
 * Scan a directory entry for c8ctl plugins and add to the set
 */
function addPluginIfFound(entry: string, nodeModulesPath: string, installedPlugins: Set<string>): void {
  if (entry.startsWith('.')) return;
  
  if (entry.startsWith('@')) {
    // Scoped package - scan subdirectories
    const scopePath = join(nodeModulesPath, entry);
    try {
      readdirSync(scopePath)
        .filter(pkg => !pkg.startsWith('.'))
        .forEach(scopedPkg => {
          const packageNameWithScope = `${entry}/${scopedPkg}`;
          const packagePath = join(nodeModulesPath, entry, scopedPkg);
          if (hasPluginFile(packagePath)) {
            installedPlugins.add(packageNameWithScope);
          }
        });
    } catch {
      // Skip packages that can't be read
    }
  } else {
    // Regular package
    const packagePath = join(nodeModulesPath, entry);
    if (hasPluginFile(packagePath)) {
      installedPlugins.add(entry);
    }
  }
}

/**
 * Scan node_modules for installed plugins
 */
function scanInstalledPlugins(nodeModulesPath: string): Set<string> {
  const installedPlugins = new Set<string>();
  
  if (!existsSync(nodeModulesPath)) {
    return installedPlugins;
  }
  
  try {
    const entries = readdirSync(nodeModulesPath);
    entries.forEach(entry => addPluginIfFound(entry, nodeModulesPath, installedPlugins));
  } catch (error) {
    getLogger().debug('Error scanning global plugins directory:', error);
  }
  
  return installedPlugins;
}

/**
 * List installed plugins
 */
export function listPlugins(): void {
  const logger = getLogger();
  
  try {
    // Get plugins from registry (local source of truth)
    const registeredPlugins = getRegisteredPlugins();
    
    // Check global plugins directory
    const pluginsDir = ensurePluginsDir();
    const nodeModulesPath = join(pluginsDir, 'node_modules');
    const installedPlugins = scanInstalledPlugins(nodeModulesPath);
    
    // Build unified list with status
    const plugins: Array<{Name: string, Status: string, Source: string, 'Installed At': string}> = [];
    
    // Add registered plugins
    for (const plugin of registeredPlugins) {
      const isInstalled = installedPlugins.has(plugin.name);
      const installStatus = isInstalled ? '✓ Installed' : '⚠ Not installed';
      
      plugins.push({
        Name: plugin.name,
        Status: installStatus,
        Source: plugin.source,
        'Installed At': new Date(plugin.installedAt).toLocaleString(),
      });
      
      installedPlugins.delete(plugin.name);
    }
    
    // Add any plugins installed but not in registry
    for (const name of installedPlugins) {
      plugins.push({
        Name: name,
        Status: '⚠ Not in registry',
        Source: 'Unknown',
        'Installed At': 'Unknown',
      });
    }
    
    if (plugins.length === 0) {
      logger.info('No c8ctl plugins installed');
      return;
    }
    
    // Check if there are sync issues
    const needsSync = plugins.some(p => p.Status !== '✓ Installed');
    
    logger.table(plugins);
    
    if (needsSync) {
      logger.info('');
      logger.info('💡 Actionable hint: Some plugins are out of sync. Run "c8 sync plugins" to synchronize your plugins');
    }
  } catch (error) {
    logger.error('Failed to list plugins', error as Error);
    process.exit(1);
  }
}

/**
 * Sync plugins - synchronize registry with actual installations
 * Registry has precedence - plugins are installed to global directory
 */
export async function syncPlugins(): Promise<void> {
  const logger = getLogger();
  
  // Get global plugins directory
  const pluginsDir = ensurePluginsDir();
  const nodeModulesPath = join(pluginsDir, 'node_modules');
  
  logger.info('Starting plugin synchronization...');
  logger.info('');
  
  // Get registered plugins (local source of truth)
  const registeredPlugins = getRegisteredPlugins();
  
  if (registeredPlugins.length === 0) {
    logger.info('No plugins registered. Nothing to sync.');
    return;
  }
  
  logger.info(`Found ${registeredPlugins.length} registered plugin(s):`);
  for (const plugin of registeredPlugins) {
    logger.info(`  - ${plugin.name} (${plugin.source})`);
  }
  logger.info('');
  
  let syncedCount = 0;
  let failedCount = 0;
  const failures: Array<{plugin: string, error: string}> = [];
  
  // Process each registered plugin
  for (const plugin of registeredPlugins) {
    logger.info(`Syncing ${plugin.name}...`);
    
    try {
      // Check if plugin is installed in global directory
      const packageDir = join(nodeModulesPath, plugin.name);
      const isInstalled = existsSync(packageDir);
      
      if (isInstalled) {
        logger.info(`  ✓ ${plugin.name} is already installed, attempting rebuild...`);
        
        // Try npm rebuild first
        try {
          execSync(`npm rebuild ${plugin.name} --prefix "${pluginsDir}"`, { stdio: 'pipe' });
          logger.success(`  ✓ ${plugin.name} rebuilt successfully`);
          syncedCount++;
          continue;
        } catch (rebuildError) {
          logger.info(`  ⚠ Rebuild failed, attempting fresh install...`);
        }
      } else {
        logger.info(`  ⚠ ${plugin.name} not found, installing...`);
      }
      
      // Fresh install
      try {
        execSync(`npm install ${plugin.source} --prefix "${pluginsDir}"`, { stdio: 'inherit' });
        logger.success(`  ✓ ${plugin.name} installed successfully`);
        syncedCount++;
      } catch (installError) {
        logger.error(`  ✗ Failed to install ${plugin.name}`);
        failedCount++;
        failures.push({
          plugin: plugin.name,
          error: installError instanceof Error ? installError.message : String(installError),
        });
      }
    } catch (error) {
      logger.error(`  ✗ Failed to sync ${plugin.name}`);
      failedCount++;
      failures.push({
        plugin: plugin.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    
    logger.info('');
  }
  
  // Summary
  logger.info('Synchronization complete:');
  logger.info(`  ✓ Synced: ${syncedCount} plugin(s)`);
  
  if (failedCount > 0) {
    logger.info(`  ✗ Failed: ${failedCount} plugin(s)`);
    logger.info('');
    logger.info('Failed plugins:');
    for (const failure of failures) {
      logger.error(`  - ${failure.plugin}: ${failure.error}`);
    }
    logger.info('');
    logger.info('💡 Actionable hint: Check network connectivity and verify plugin sources are accessible. You may need to remove failed plugins from the registry with "c8 unload plugin <name>"');
    process.exit(1);
  }
  
  logger.success('All plugins synced successfully!');
}

/**
 * Upgrade a plugin to the latest version or a specific version
 */
export async function upgradePlugin(packageName: string, version?: string): Promise<void> {
  const logger = getLogger();
  
  if (!packageName) {
    logger.error('Package name required. Usage: c8 upgrade plugin <package-name> [version]');
    process.exit(1);
  }
  
  // Check if plugin is registered
  if (!isPluginRegistered(packageName)) {
    logger.error(`Plugin "${packageName}" is not registered.`);
    logger.info('💡 Actionable hint: Run "c8 list plugins" to see installed plugins');
    process.exit(1);
  }
  
  const pluginEntry = getPluginEntry(packageName);
  const pluginsDir = ensurePluginsDir();
  
  try {
    const versionSpec = version ? `@${version}` : '@latest';
    logger.info(`Upgrading plugin: ${packageName} to ${version || 'latest'}...`);
    
    // Uninstall current version
    execSync(`npm uninstall ${packageName} --prefix "${pluginsDir}"`, { stdio: 'pipe' });
    
    // Install new version
    const installTarget = version ? `${packageName}${versionSpec}` : pluginEntry!.source;
    execSync(`npm install ${installTarget} --prefix "${pluginsDir}"`, { stdio: 'inherit' });
    
    // Update registry with new source if version was specified
    if (version) {
      addPluginToRegistry(packageName, `${packageName}${versionSpec}`);
    }
    
    // Clear plugin cache
    clearLoadedPlugins();
    
    logger.success('Plugin upgraded successfully', packageName);
    logger.info('Plugin will be available on next command execution');
  } catch (error) {
    logger.error('Failed to upgrade plugin', error as Error);
    logger.info('💡 Actionable hint: Check network connectivity and verify the package/version exists');
    process.exit(1);
  }
}

/**
 * Downgrade a plugin to a specific version
 */
export async function downgradePlugin(packageName: string, version: string): Promise<void> {
  const logger = getLogger();
  
  if (!packageName || !version) {
    logger.error('Package name and version required. Usage: c8 downgrade plugin <package-name> <version>');
    process.exit(1);
  }
  
  // Check if plugin is registered
  if (!isPluginRegistered(packageName)) {
    logger.error(`Plugin "${packageName}" is not registered.`);
    logger.info('💡 Actionable hint: Run "c8 list plugins" to see installed plugins');
    process.exit(1);
  }
  
  const pluginsDir = ensurePluginsDir();
  
  try {
    logger.info(`Downgrading plugin: ${packageName} to version ${version}...`);
    
    // Uninstall current version
    execSync(`npm uninstall ${packageName} --prefix "${pluginsDir}"`, { stdio: 'pipe' });
    
    // Install specific version
    const installTarget = `${packageName}@${version}`;
    execSync(`npm install ${installTarget} --prefix "${pluginsDir}"`, { stdio: 'inherit' });
    
    // Update registry with new source
    addPluginToRegistry(packageName, installTarget);
    
    // Clear plugin cache
    clearLoadedPlugins();
    
    logger.success('Plugin downgraded successfully', packageName);
    logger.info('Plugin will be available on next command execution');
  } catch (error) {
    logger.error('Failed to downgrade plugin', error as Error);
    logger.info('💡 Actionable hint: Check network connectivity and verify the version exists');
    process.exit(1);
  }
}

/**
 * Initialize a new plugin project with TypeScript template
 */
export async function initPlugin(pluginName?: string): Promise<void> {
  const logger = getLogger();
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  
  // Use provided name or default
  const name = pluginName || 'my-c8ctl-plugin';
  const dirName = name.startsWith('c8ctl-') ? name : `c8ctl-${name}`;
  const pluginDir = resolve(process.cwd(), dirName);
  
  // Check if directory already exists
  if (existsSync(pluginDir)) {
    logger.error(`Directory "${dirName}" already exists.`);
    logger.info('💡 Actionable hint: Choose a different name or remove the existing directory');
    process.exit(1);
  }
  
  try {
    logger.info(`Creating plugin: ${dirName}...`);
    
    // Create plugin directory
    mkdirSync(pluginDir, { recursive: true });
    
    // Create package.json
    const packageJson = {
      name: dirName,
      version: '1.0.0',
      type: 'module',
      description: `A c8ctl plugin`,
      keywords: ['c8ctl', 'c8ctl-plugin'],
      main: 'c8ctl-plugin.js',
      scripts: {
        build: 'tsc',
        watch: 'tsc --watch',
      },
      devDependencies: {
        typescript: '^5.0.0',
        '@types/node': '^22.0.0',
      },
    };
    
    writeFileSync(
      join(pluginDir, 'package.json'),
      JSON.stringify(packageJson, null, 2)
    );
    
    // Create tsconfig.json
    const tsConfig = {
      compilerOptions: {
        target: 'ES2022',
        module: 'ES2022',
        moduleResolution: 'node',
        outDir: '.',
        rootDir: './src',
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        forceConsistentCasingInFileNames: true,
      },
      include: ['src/**/*'],
    };
    
    writeFileSync(
      join(pluginDir, 'tsconfig.json'),
      JSON.stringify(tsConfig, null, 2)
    );
    
    // Create src directory
    mkdirSync(join(pluginDir, 'src'), { recursive: true });
    
    // Create c8ctl-plugin.ts
    const pluginTemplate = `/**
 * ${dirName} - A c8ctl plugin
 */

// The c8ctl runtime is available globally
declare const c8ctl: {
  version: string;
  nodeVersion: string;
  platform: string;
  arch: string;
  cwd: string;
  outputMode: 'text' | 'json';
  activeProfile?: string;
  activeTenant?: string;
};

// Optional metadata for help text
export const metadata = {
  name: '${dirName}',
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
    console.log('Hello from ${dirName}!');
    console.log('c8ctl version:', c8ctl.version);
    console.log('Node version:', c8ctl.nodeVersion);
    
    if (args.length > 0) {
      console.log('Arguments:', args.join(', '));
    }
    
    // Example: Access c8ctl runtime
    console.log('Current directory:', c8ctl.cwd);
    console.log('Output mode:', c8ctl.outputMode);
    
    if (c8ctl.activeProfile) {
      console.log('Active profile:', c8ctl.activeProfile);
    }
  },
};
`;
    
    writeFileSync(
      join(pluginDir, 'src', 'c8ctl-plugin.ts'),
      pluginTemplate
    );
    
    // Create README.md
    const readme = `# ${dirName}

A c8ctl plugin.

## Development

1. Install dependencies:
\`\`\`bash
npm install
\`\`\`

2. Build the plugin:
\`\`\`bash
npm run build
\`\`\`

3. Load the plugin for testing:
\`\`\`bash
c8ctl load plugin --from file://\${PWD}
\`\`\`

4. Test the plugin command:
\`\`\`bash
c8ctl hello
\`\`\`

## Plugin Structure

- \`src/c8ctl-plugin.ts\` - Plugin source code (TypeScript)
- \`c8ctl-plugin.js\` - Compiled plugin file (JavaScript)
- \`package.json\` - Package metadata with c8ctl keywords

## Publishing

Before publishing, ensure:
- The plugin is built (\`npm run build\`)
- The package.json has correct metadata
- Keywords include 'c8ctl' or 'c8ctl-plugin'

Then publish to npm:
\`\`\`bash
npm publish
\`\`\`

Users can install your plugin with:
\`\`\`bash
c8ctl load plugin ${dirName}
\`\`\`
`;
    
    writeFileSync(
      join(pluginDir, 'README.md'),
      readme
    );
    
    // Create .gitignore
    const gitignore = `node_modules/
*.js
*.js.map
!c8ctl-plugin.js
`;
    
    writeFileSync(
      join(pluginDir, '.gitignore'),
      gitignore
    );
    
    logger.success('Plugin scaffolding created successfully!');
    logger.info('');
    logger.info(`Next steps:`);
    logger.info(`  1. cd ${dirName}`);
    logger.info(`  2. npm install`);
    logger.info(`  3. npm run build`);
    logger.info(`  4. c8ctl load plugin --from file://\${PWD}`);
    logger.info(`  5. c8ctl hello`);
    logger.info('');
    logger.info(`Edit src/c8ctl-plugin.ts to add your plugin logic.`);
  } catch (error) {
    logger.error('Failed to create plugin', error as Error);
    process.exit(1);
  }
}
