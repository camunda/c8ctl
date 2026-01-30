/**
 * Plugin registry for tracking loaded plugins independently of package.json
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { getUserDataDir } from './config.ts';

export interface PluginEntry {
  name: string;
  source: string; // npm package name, git URL, file URL, etc.
  installedAt: string; // ISO timestamp
}

interface PluginRegistry {
  plugins: PluginEntry[];
}

let registryCache: PluginRegistry | null = null;

/**
 * Get the path to the plugin registry file
 */
function getRegistryPath(): string {
  return join(getUserDataDir(), 'plugins.json');
}

/**
 * Load the plugin registry from disk
 */
export function loadPluginRegistry(): PluginRegistry {
  if (registryCache) {
    return registryCache;
  }

  const registryPath = getRegistryPath();
  
  if (!existsSync(registryPath)) {
    registryCache = { plugins: [] };
    return registryCache;
  }

  try {
    const content = readFileSync(registryPath, 'utf-8');
    registryCache = JSON.parse(content);
    return registryCache!;
  } catch (error) {
    // If registry is corrupted, start fresh and warn user
    console.warn('⚠ Warning: Plugin registry file was corrupted and has been reset. Your plugins may need to be re-registered.');
    registryCache = { plugins: [] };
    return registryCache;
  }
}

/**
 * Save the plugin registry to disk
 */
export function savePluginRegistry(registry: PluginRegistry): void {
  const registryPath = getRegistryPath();
  const registryDir = dirname(registryPath);

  // Ensure config directory exists
  if (!existsSync(registryDir)) {
    mkdirSync(registryDir, { recursive: true });
  }

  writeFileSync(registryPath, JSON.stringify(registry, null, 2), 'utf-8');
  registryCache = registry;
}

/**
 * Add a plugin to the registry
 */
export function addPluginToRegistry(name: string, source: string): void {
  const registry = loadPluginRegistry();
  
  // Remove existing entry if present
  registry.plugins = registry.plugins.filter(p => p.name !== name);
  
  // Add new entry
  registry.plugins.push({
    name,
    source,
    installedAt: new Date().toISOString(),
  });
  
  savePluginRegistry(registry);
}

/**
 * Remove a plugin from the registry
 */
export function removePluginFromRegistry(name: string): void {
  const registry = loadPluginRegistry();
  registry.plugins = registry.plugins.filter(p => p.name !== name);
  savePluginRegistry(registry);
}

/**
 * Get all plugins from the registry
 */
export function getRegisteredPlugins(): PluginEntry[] {
  const registry = loadPluginRegistry();
  return [...registry.plugins];
}

/**
 * Check if a plugin is in the registry
 */
export function isPluginRegistered(name: string): boolean {
  const registry = loadPluginRegistry();
  return registry.plugins.some(p => p.name === name);
}

/**
 * Get a specific plugin entry from the registry
 */
export function getPluginEntry(name: string): PluginEntry | undefined {
  const registry = loadPluginRegistry();
  return registry.plugins.find(p => p.name === name);
}

/**
 * Clear the registry cache (useful for testing)
 */
export function clearRegistryCache(): void {
  registryCache = null;
}
