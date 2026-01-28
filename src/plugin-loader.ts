/**
 * Plugin loader for dynamic command loading
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getLogger } from './logger.ts';

interface PluginCommands {
  [commandName: string]: (args: string[]) => Promise<void>;
}

interface LoadedPlugin {
  name: string;
  commands: PluginCommands;
}

const loadedPlugins = new Map<string, LoadedPlugin>();

/**
 * Load all installed plugins from node_modules
 */
export async function loadInstalledPlugins(): Promise<void> {
  const logger = getLogger();
  const nodeModulesPath = join(process.cwd(), 'node_modules');
  
  if (!existsSync(nodeModulesPath)) {
    return;
  }
  
  try {
    const packages = readdirSync(nodeModulesPath);
    
    for (const packageName of packages) {
      if (packageName.startsWith('.') || packageName.startsWith('@')) {
        continue;
      }
      
      const packagePath = join(nodeModulesPath, packageName);
      const pluginFileJs = join(packagePath, 'c8ctl-plugin.js');
      const pluginFileTs = join(packagePath, 'c8ctl-plugin.ts');
      
      if (existsSync(pluginFileJs) || existsSync(pluginFileTs)) {
        try {
          const pluginFile = existsSync(pluginFileJs) ? pluginFileJs : pluginFileTs;
          // Use file:// protocol and add timestamp to bust cache
          const pluginUrl = `file://${pluginFile}?t=${Date.now()}`;
          const plugin = await import(pluginUrl);
          
          if (plugin.commands && typeof plugin.commands === 'object') {
            loadedPlugins.set(packageName, {
              name: packageName,
              commands: plugin.commands,
            });
            logger.debug?.(`Loaded plugin: ${packageName}`);
          }
        } catch (error) {
          logger.debug?.(`Failed to load plugin ${packageName}:`, error);
        }
      }
    }
  } catch (error) {
    logger.debug?.('Error scanning for plugins:', error);
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
 * Clear all loaded plugins (useful for testing and after uninstall)
 */
export function clearLoadedPlugins(): void {
  loadedPlugins.clear();
}
