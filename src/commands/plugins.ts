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
 * Extract package name from URL or installed package
 * Tries to read package.json from installed package, falls back to URL parsing
 */
function extractPackageNameFromUrl(url: string, pluginsDir: string): string {
  // Try to scan node_modules to find the package by reading package.json
  try {
    const nodeModulesPath = join(pluginsDir, 'node_modules');
    if (existsSync(nodeModulesPath)) {
      const entries = readdirSync(nodeModulesPath);
      for (const entry of entries) {
        if (entry.startsWith('.')) continue;
        
        if (entry.startsWith('@')) {
          // Scoped package
          const scopePath = join(nodeModulesPath, entry);
          const scopedPackages = readdirSync(scopePath);
          for (const scopedPkg of scopedPackages) {
            const pkgPath = join(scopePath, scopedPkg);
            const pkgJsonPath = join(pkgPath, 'package.json');
            if (existsSync(pkgJsonPath)) {
              const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
              // Check if this package has c8ctl-plugin file
              if (hasPluginFile(pkgPath) && pkgJson.keywords?.includes('c8ctl')) {
                return pkgJson.name;
              }
            }
          }
        } else {
          // Regular package
          const pkgPath = join(nodeModulesPath, entry);
          const pkgJsonPath = join(pkgPath, 'package.json');
          if (existsSync(pkgJsonPath)) {
            const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
            // Check if this package has c8ctl-plugin file
            if (hasPluginFile(pkgPath) && pkgJson.keywords?.includes('c8ctl')) {
              return pkgJson.name;
            }
          }
        }
      }
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
    let installedPlugins: Set<string> = new Set();
    
    if (existsSync(nodeModulesPath)) {
      // Scan for installed plugins in global directory
      try {
        const entries = readdirSync(nodeModulesPath);
        for (const entry of entries) {
          if (entry.startsWith('.')) continue;
          
          if (entry.startsWith('@')) {
            // Scoped package - scan subdirectories
            const scopePath = join(nodeModulesPath, entry);
            try {
              const scopedPackages = readdirSync(scopePath);
              for (const scopedPkg of scopedPackages) {
                if (!scopedPkg.startsWith('.')) {
                  const packageNameWithScope = `${entry}/${scopedPkg}`;
                  const packagePath = join(nodeModulesPath, entry, scopedPkg);
                  if (hasPluginFile(packagePath)) {
                    installedPlugins.add(packageNameWithScope);
                  }
                }
              }
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
      } catch (error) {
        logger.debug('Error scanning global plugins directory:', error);
      }
    }
    
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
