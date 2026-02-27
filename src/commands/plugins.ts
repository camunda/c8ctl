/**
 * Plugin management commands
 */

import { getLogger } from '../logger.ts';
import { execSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearLoadedPlugins } from '../plugin-loader.ts';
import { ensurePluginsDir } from '../config.ts';
import {
  addPluginToRegistry,
  removePluginFromRegistry,
  getRegisteredPlugins,
  isPluginRegistered,
  getPluginEntry
} from '../plugin-registry.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function getTemplate(templateFileName: string): string {
  const templatePath = join(__dirname, '..', 'templates', templateFileName);
  return readFileSync(templatePath, 'utf-8');
}

function renderTemplate(templateFileName: string, replacements: Record<string, string> = {}): string {
  let content = getTemplate(templateFileName);
  for (const [key, value] of Object.entries(replacements)) {
    content = content.replaceAll(`{{${key}}}`, value);
  }
  return content;
}

/**
 * Load a plugin (npm install wrapper)
 * Supports either package name or --from flag with URL
 * Installs to global plugins directory
 */
export async function loadPlugin(packageNameOrFrom?: string, fromUrl?: string): Promise<void> {
  const logger = getLogger();
  
  // Validate exclusive usage
  if (packageNameOrFrom && fromUrl) {
    logger.error('Cannot specify both package name and --from flag. Use either "c8ctl load plugin <name>" or "c8ctl load plugin --from <url>"');
    process.exit(1);
  }
  
  if (!packageNameOrFrom && !fromUrl) {
    logger.error('Package name or --from URL required. Usage: c8ctl load plugin <package-name> OR c8ctl load plugin --from <url>');
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
        logger.info('Ensure the URL points to a valid npm package with a package.json file');
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
    logger.info('Check that the plugin name/URL is correct and you have network access if loading from a remote source');
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
    logger.error('Package name required. Usage: c8ctl unload plugin <package-name>');
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
    logger.info('Verify the plugin name is correct by running "c8ctl list plugins"');
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
 * Get installed plugin version from package.json
 */
export function getInstalledPluginVersion(nodeModulesPath: string, packageName: string): string | null {
  const packagePath = join(nodeModulesPath, ...packageName.split('/'));
  const packageJsonPath = join(packagePath, 'package.json');

  if (!existsSync(packageJsonPath)) {
    return null;
  }

  try {
    const pkgJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    return typeof pkgJson.version === 'string' ? pkgJson.version : null;
  } catch {
    return null;
  }
}

/**
 * Extract version from a registry source like package@version
 */
export function getVersionFromSource(source: string, packageName: string): string | null {
  const packagePrefix = `${packageName}@`;
  if (!source.startsWith(packagePrefix)) {
    return null;
  }

  const version = source.slice(packagePrefix.length).trim();
  return version.length > 0 ? version : null;
}

/**
 * Check if plugin source points to URL/git-style location
 */
function isUrlSource(source: string): boolean {
  return source.includes('://') ||
    source.startsWith('git+') ||
    source.startsWith('git@') ||
    source.startsWith('github:');
}

/**
 * Resolve npm install target based on source type and version
 */
function resolveInstallTarget(source: string, packageName: string, version?: string): string {
  if (!version) {
    return source;
  }

  return isUrlSource(source)
    ? `${source.split('#')[0]}#${version}`
    : `${packageName}@${version}`;
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
    const plugins: Array<{Name: string, Version: string, Status: string, Source: string, 'Installed At': string}> = [];
    
    // Add registered plugins
    for (const plugin of registeredPlugins) {
      const isInstalled = installedPlugins.has(plugin.name);
      const installStatus = isInstalled ? '✓ Installed' : '⚠ Not installed';
      const installedVersion = isInstalled ? getInstalledPluginVersion(nodeModulesPath, plugin.name) : null;
      const sourceVersion = getVersionFromSource(plugin.source, plugin.name);
      
      plugins.push({
        Name: plugin.name,
        Version: installedVersion ?? sourceVersion ?? 'Unknown',
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
        Version: getInstalledPluginVersion(nodeModulesPath, name) ?? 'Unknown',
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
      logger.info('Some plugins are out of sync. Run "c8ctl sync plugins" to synchronize your plugins');
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
    logger.info('Check network connectivity and verify plugin sources are accessible. You may need to remove failed plugins from the registry with "c8ctl unload plugin <name>"');
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
    logger.error('Package name required. Usage: c8ctl upgrade plugin <package-name> [version]');
    process.exit(1);
  }
  
  // Check if plugin is registered
  if (!isPluginRegistered(packageName)) {
    logger.error(`Plugin "${packageName}" is not registered.`);
    logger.info('Run "c8ctl list plugins" to see installed plugins');
    process.exit(1);
  }
  
  const pluginEntry = getPluginEntry(packageName);
  const pluginsDir = ensurePluginsDir();

  const source = pluginEntry?.source ?? packageName;

  // Versioned upgrade needs to respect source type
  // File-based plugins do not have a version selector in npm install syntax
  if (version && source.startsWith('file:')) {
    logger.error(`Cannot upgrade file-based plugin "${packageName}" to a specific version.`);
    logger.info(`Plugin source is: ${source}`);
    logger.info('Use "c8ctl load plugin --from <file-url>" after checking out the desired plugin version in your local source directory');
    process.exit(1);
  }

  const installTarget = resolveInstallTarget(source, packageName, version);
  
  try {
    logger.info(`Upgrading plugin: ${packageName} to ${version || 'latest'}...`);
    
    // Uninstall current version
    execSync(`npm uninstall ${packageName} --prefix "${pluginsDir}"`, { stdio: 'pipe' });
    
    // Install new version while respecting source type
    execSync(`npm install ${installTarget} --prefix "${pluginsDir}"`, { stdio: 'inherit' });
    
    // Update registry with new source if version was specified
    if (version) {
      addPluginToRegistry(packageName, installTarget);
    }
    
    // Clear plugin cache
    clearLoadedPlugins();
    
    logger.success('Plugin upgraded successfully', packageName);
    logger.info('Plugin will be available on next command execution');
  } catch (error) {
    logger.error('Failed to upgrade plugin', error as Error);
    logger.info('Check network connectivity and verify the package/version exists');
    process.exit(1);
  }
}

/**
 * Downgrade a plugin to a specific version
 */
export async function downgradePlugin(packageName: string, version: string): Promise<void> {
  const logger = getLogger();
  
  if (!packageName || !version) {
    logger.error('Package name and version required. Usage: c8ctl downgrade plugin <package-name> <version>');
    process.exit(1);
  }
  
  // Check if plugin is registered
  if (!isPluginRegistered(packageName)) {
    logger.error(`Plugin "${packageName}" is not registered.`);
    logger.info('Run "c8ctl list plugins" to see installed plugins');
    process.exit(1);
  }
  
  const pluginEntry = getPluginEntry(packageName);
  const pluginsDir = ensurePluginsDir();

  const source = pluginEntry?.source ?? packageName;

  // Downgrade needs to respect the plugin source
  // File-based plugins do not have a version selector in npm install syntax
  if (source.startsWith('file:')) {
    logger.error(`Cannot downgrade file-based plugin "${packageName}" by version.`);
    logger.info(`Plugin source is: ${source}`);
    logger.info('Use "c8ctl load plugin --from <file-url>" after checking out the desired plugin version in your local source directory');
    process.exit(1);
  }

  const installTarget = resolveInstallTarget(source, packageName, version);
  
  try {
    logger.info(`Downgrading plugin: ${packageName} to version ${version}...`);
    
    // Uninstall current version
    execSync(`npm uninstall ${packageName} --prefix "${pluginsDir}"`, { stdio: 'pipe' });
    
    // Install specific version while respecting source type
    execSync(`npm install ${installTarget} --prefix "${pluginsDir}"`, { stdio: 'inherit' });
    
    // Update registry with new source
    addPluginToRegistry(packageName, installTarget);
    
    // Clear plugin cache
    clearLoadedPlugins();
    
    logger.success('Plugin downgraded successfully', packageName);
    logger.info('Plugin will be available on next command execution');
  } catch (error) {
    logger.error('Failed to downgrade plugin', error as Error);
    logger.info('Check network connectivity and verify the version exists');
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
    logger.info('Choose a different name or remove the existing directory');
    process.exit(1);
  }
  
  try {
    logger.info(`Creating plugin: ${dirName}...`);

    const templateVars = { PLUGIN_NAME: dirName };
    
    // Create plugin directory
    mkdirSync(pluginDir, { recursive: true });
    
    // Create package.json
    writeFileSync(join(pluginDir, 'package.json'), renderTemplate('package.json', templateVars));

    // Create tsconfig.json
    writeFileSync(join(pluginDir, 'tsconfig.json'), getTemplate('tsconfig.json'));
    
    // Create src directory
    mkdirSync(join(pluginDir, 'src'), { recursive: true });

    // Create root c8ctl-plugin.js entry point
    writeFileSync(join(pluginDir, 'c8ctl-plugin.js'), getTemplate('c8ctl-plugin.js'));
    
    // Create c8ctl-plugin.ts
    writeFileSync(join(pluginDir, 'src', 'c8ctl-plugin.ts'), renderTemplate('c8ctl-plugin.ts', templateVars));
    
    // Create README.md
    const readme = renderTemplate('README.md', templateVars);
    
    writeFileSync(
      join(pluginDir, 'README.md'),
      readme
    );

    // Create AGENTS.md
    const agents = getTemplate('AGENTS.md');

    writeFileSync(
      join(pluginDir, 'AGENTS.md'),
      agents
    );
    
    // Create .gitignore (stored as 'gitignore' to survive npm publish)
    writeFileSync(join(pluginDir, '.gitignore'), getTemplate('gitignore'));
    
    logger.success('Plugin scaffolding created successfully!');
    const nextSteps = renderTemplate('init-plugin-next-steps.txt', templateVars);
    for (const line of nextSteps.split('\n')) {
      logger.info(line);
    }
  } catch (error) {
    logger.error('Failed to create plugin', error as Error);
    process.exit(1);
  }
}
