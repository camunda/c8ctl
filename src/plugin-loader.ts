/**
 * Plugin loader for dynamic command loading
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getLogger } from './logger.ts';
import { c8ctl } from './runtime.ts';
import { ensurePluginsDir } from './config.ts';

interface PluginCommands {
  [commandName: string]: (args: string[]) => Promise<void>;
}

interface PluginMetadata {
  name?: string;
  description?: string;
  commands?: {
    [commandName: string]: {
      description?: string;
    };
  };
}

interface LoadedPlugin {
  name: string;
  commands: PluginCommands;
  metadata?: PluginMetadata;
}

const loadedPlugins = new Map<string, LoadedPlugin>();

/**
 * Load all installed plugins from global plugins directory
 */
export async function loadInstalledPlugins(): Promise<void> {
  const logger = getLogger();
  
  // Ensure plugins directory exists
  const pluginsDir = ensurePluginsDir();
  const nodeModulesPath = join(pluginsDir, 'node_modules');
  
  // Make c8ctl runtime available globally for plugins
  // @ts-ignore
  globalThis.c8ctl = c8ctl;
  
  if (!existsSync(nodeModulesPath)) {
    logger.debug('Global plugins node_modules directory not found');
    return;
  }
  
  try {
    const entries = readdirSync(nodeModulesPath);
    logger.debug(`Scanning ${entries.length} entries in node_modules`);
    
    const packagesToScan: string[] = [];
    
    // Collect regular packages and scoped packages
    for (const entry of entries) {
      if (entry.startsWith('.')) {
        continue;
      }
      
      if (entry.startsWith('@')) {
        // Scoped package - scan subdirectories
        const scopePath = join(nodeModulesPath, entry);
        try {
          const scopedPackages = readdirSync(scopePath);
          for (const scopedPkg of scopedPackages) {
            if (!scopedPkg.startsWith('.')) {
              packagesToScan.push(join(entry, scopedPkg));
            }
          }
        } catch (error) {
          logger.debug(`Failed to scan scoped package directory ${entry}:`, error);
        }
      } else {
        // Regular package
        packagesToScan.push(entry);
      }
    }
    
    logger.debug(`Found ${packagesToScan.length} packages to scan:`, packagesToScan);
    
    for (const packageName of packagesToScan) {
      const packagePath = join(nodeModulesPath, packageName);
      const packageJsonPath = join(packagePath, 'package.json');
      
      if (!existsSync(packageJsonPath)) {
        logger.debug(`No package.json for ${packageName}`);
        continue;
      }
      
      try {
        // Check for c8ctl-plugin entry point files first
        const pluginFileJs = join(packagePath, 'c8ctl-plugin.js');
        const pluginFileTs = join(packagePath, 'c8ctl-plugin.ts');
        
        if (!existsSync(pluginFileJs) && !existsSync(pluginFileTs)) {
          logger.debug(`No c8ctl-plugin.js/ts found for ${packageName}`);
          continue;
        }
        
        // Read package.json to check keywords
        const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
        
        // Plugin must have c8ctl or c8ctl-plugin in keywords
        const isC8ctlPlugin = 
          packageJson.keywords?.includes('c8ctl') ||
          packageJson.keywords?.includes('c8ctl-plugin');
        
        if (!isC8ctlPlugin) {
          logger.debug(`Package ${packageName} has c8ctl-plugin file but missing keywords (keywords: ${packageJson.keywords?.join(', ') || 'none'})`);
          continue;
        }
        
        logger.debug(`Found c8ctl plugin candidate: ${packageName}`);
        
        const pluginFile = existsSync(pluginFileJs) ? pluginFileJs : pluginFileTs;
        
        // Use file:// protocol and add timestamp to bust cache
        const pluginUrl = `file://${pluginFile}?t=${Date.now()}`;
        logger.debug(`Loading plugin from: ${pluginUrl}`);
        const plugin = await import(pluginUrl);
        
        if (plugin.commands && typeof plugin.commands === 'object') {
          loadedPlugins.set(packageName, {
            name: packageName,
            commands: plugin.commands,
            metadata: plugin.metadata || {},
          });
          const commandNames = Object.keys(plugin.commands);
          logger.debug(`Successfully loaded plugin: ${packageName} with ${commandNames.length} commands:`, commandNames);
        }
      } catch (error) {
        logger.debug(`Failed to load plugin ${packageName}:`, error);
      }
    }
    logger.debug(`Total plugins loaded: ${loadedPlugins.size}`);
  } catch (error) {
    logger.debug('Error scanning for plugins:', error);
  }
}

/**
 * Get all loaded plugin commands
 */
export function getPluginCommands(): PluginCommands {
  const allCommands: PluginCommands = {};
  
  for (const plugin of loadedPlugins.values()) {
    Object.assign(allCommands, plugin.commands);
  }
  
  return allCommands;
}

/**
 * Execute a plugin command if it exists
 */
export async function executePluginCommand(
  commandName: string,
  args: string[]
): Promise<boolean> {
  const commands = getPluginCommands();
  
  if (commands[commandName]) {
    await commands[commandName](args);
    return true;
  }
  
  return false;
}

/**
 * Check if a command is provided by a plugin
 */
export function isPluginCommand(commandName: string): boolean {
  const commands = getPluginCommands();
  return commandName in commands;
}

/**
 * Get list of all plugin command names
 */
export function getPluginCommandNames(): string[] {
  return Object.keys(getPluginCommands());
}

/**
 * Get plugin information for help display
 */
export interface PluginCommandInfo {
  commandName: string;
  pluginName: string;
  description?: string;
}

export function getPluginCommandsInfo(): PluginCommandInfo[] {
  const infos: PluginCommandInfo[] = [];
  
  for (const plugin of loadedPlugins.values()) {
    for (const commandName of Object.keys(plugin.commands)) {
      infos.push({
        commandName,
        pluginName: plugin.name,
        description: plugin.metadata?.commands?.[commandName]?.description,
      });
    }
  }
  
  return infos;
}

/**
 * Clear all loaded plugins (useful for testing and after uninstall)
 */
export function clearLoadedPlugins(): void {
  loadedPlugins.clear();
}
