/**
 * Plugin management commands
 */

import { getLogger } from '../logger.ts';
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { clearLoadedPlugins } from '../plugin-loader.ts';
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
  
  // Check if we have package.json in current directory
  const packageJsonPath = join(process.cwd(), 'package.json');
  if (!existsSync(packageJsonPath)) {
    logger.error('No package.json found in current directory.');
    logger.info('💡 Actionable hint: Run "npm init -y" to create a package.json, or navigate to a directory with an existing package.json');
    process.exit(1);
  }
  
  try {
    let pluginName: string;
    let pluginSource: string;
    
    if (fromUrl) {
      // Install from URL (file://, https://, git://, etc.)
      logger.info(`Loading plugin from: ${fromUrl}...`);
      execSync(`npm install ${fromUrl}`, { stdio: 'inherit' });
      
      // Extract package name from URL using pattern matching
      pluginName = extractPackageNameFromUrl(fromUrl);
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
      execSync(`npm install ${packageNameOrFrom}`, { stdio: 'inherit' });
      
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
 * Extract package name from URL or path
 * This is a best-effort extraction - for complex cases, the user may need to specify manually
 * Note: This doesn't handle all edge cases like scoped packages in git URLs
 */
function extractPackageNameFromUrl(url: string): string {
  // For npm packages: git+https://github.com/user/repo.git -> repo
  // For file paths: file:///path/to/plugin -> plugin
  // For git URLs: git://github.com/user/repo.git -> repo
  // Note: Scoped packages like @scope/package in URLs are not fully supported
  
  const match = url.match(/\/([^\/]+?)(\.git)?$/);
  if (match) {
    return match[1];
  }
  
  // Fallback: use a cleaned version of the URL as the name
  return url.replace(/[^a-zA-Z0-9-_@\/]/g, '-');
}

/**
 * Unload a plugin (npm uninstall wrapper)
 */
export async function unloadPlugin(packageName: string): Promise<void> {
  const logger = getLogger();
  
  if (!packageName) {
    logger.error('Package name required. Usage: c8 unload plugin <package-name>');
    process.exit(1);
  }
  
  try {
    logger.info(`Unloading plugin: ${packageName}...`);
    execSync(`npm uninstall ${packageName}`, { stdio: 'inherit' });
    
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
 * List installed plugins
 */
export function listPlugins(): void {
  const logger = getLogger();
  
  try {
    // Get plugins from registry (local source of truth)
    const registeredPlugins = getRegisteredPlugins();
    
    // Check package.json if it exists
    const packageJsonPath = join(process.cwd(), 'package.json');
    let packageJsonPlugins: Set<string> = new Set();
    
    if (existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
      const dependencies = packageJson.dependencies || {};
      const devDependencies = packageJson.devDependencies || {};
      const allDeps = { ...dependencies, ...devDependencies };
      
      // Find c8ctl plugins in package.json
      for (const [name] of Object.entries(allDeps)) {
        try {
          const packageDir = join(process.cwd(), 'node_modules', name);
          const hasPluginFile = existsSync(join(packageDir, 'c8ctl-plugin.js')) ||
                               existsSync(join(packageDir, 'c8ctl-plugin.ts'));
          
          if (hasPluginFile) {
            packageJsonPlugins.add(name);
          }
        } catch {
          // Skip packages that can't be read
        }
      }
    }
    
    // Build unified list with status
    const plugins: Array<{Name: string, Status: string, Source: string, 'Installed At': string}> = [];
    
    // Add registered plugins
    for (const plugin of registeredPlugins) {
      const isInstalled = packageJsonPlugins.has(plugin.name);
      const installStatus = isInstalled ? '✓ Installed' : '⚠ Not installed';
      
      plugins.push({
        Name: plugin.name,
        Status: installStatus,
        Source: plugin.source,
        'Installed At': new Date(plugin.installedAt).toLocaleString(),
      });
      
      packageJsonPlugins.delete(plugin.name);
    }
    
    // Add any plugins in package.json but not in registry
    for (const name of packageJsonPlugins) {
      plugins.push({
        Name: name,
        Status: '⚠ Not in registry',
        Source: 'package.json',
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
    logger.info('💡 Actionable hint: Ensure you are in a directory with a package.json file');
    process.exit(1);
  }
}

/**
 * Sync plugins - synchronize registry with actual installations
 * Local (registry) has precedence over package.json
 */
export async function syncPlugins(): Promise<void> {
  const logger = getLogger();
  
  // Check if package.json exists
  const packageJsonPath = join(process.cwd(), 'package.json');
  if (!existsSync(packageJsonPath)) {
    logger.error('No package.json found in current directory.');
    logger.info('💡 Actionable hint: Run "npm init -y" to create a package.json, or navigate to a directory with an existing package.json');
    process.exit(1);
  }
  
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
      // Check if plugin is installed
      const packageDir = join(process.cwd(), 'node_modules', plugin.name);
      const isInstalled = existsSync(packageDir);
      
      if (isInstalled) {
        logger.info(`  ✓ ${plugin.name} is already installed, attempting rebuild...`);
        
        // Try npm rebuild first
        try {
          execSync(`npm rebuild ${plugin.name}`, { stdio: 'pipe' });
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
        execSync(`npm install ${plugin.source}`, { stdio: 'inherit' });
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
