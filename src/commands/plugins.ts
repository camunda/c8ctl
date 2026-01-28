/**
 * Plugin management commands
 */

import { getLogger } from '../logger.ts';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Load a plugin (npm install wrapper)
 */
export function loadPlugin(packageName: string): void {
  const logger = getLogger();
  
  if (!packageName) {
    logger.error('Package name required. Usage: c8 load plugin <package-name>');
    process.exit(1);
  }
  
  try {
    logger.info(`Loading plugin: ${packageName}...`);
    execSync(`npm install ${packageName}`, { stdio: 'inherit' });
    logger.success('Plugin loaded successfully', packageName);
  } catch (error) {
    logger.error('Failed to load plugin', error as Error);
    process.exit(1);
  }
}

/**
 * Unload a plugin (npm uninstall wrapper)
 */
export function unloadPlugin(packageName: string): void {
  const logger = getLogger();
  
  if (!packageName) {
    logger.error('Package name required. Usage: c8 unload plugin <package-name>');
    process.exit(1);
  }
  
  try {
    logger.info(`Unloading plugin: ${packageName}...`);
    execSync(`npm uninstall ${packageName}`, { stdio: 'inherit' });
    logger.success('Plugin unloaded successfully', packageName);
  } catch (error) {
    logger.error('Failed to unload plugin', error as Error);
    process.exit(1);
  }
}

/**
 * List installed plugins
 */
export function listPlugins(): void {
  const logger = getLogger();
  
  try {
    // Read package.json to find c8ctl plugins
    const packageJsonPath = join(process.cwd(), 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    
    const dependencies = packageJson.dependencies || {};
    const devDependencies = packageJson.devDependencies || {};
    const allDeps = { ...dependencies, ...devDependencies };
    
    // Filter for potential plugins (packages with c8ctl-plugin.js or c8ctl-plugin.ts)
    const plugins: Array<{Name: string, Version: string, Type: string}> = [];
    
    for (const [name, version] of Object.entries(allDeps)) {
      try {
        // Try to resolve the package
        const packagePath = join(process.cwd(), 'node_modules', name, 'package.json');
        const pkgJson = JSON.parse(readFileSync(packagePath, 'utf-8'));
        
        // Check if package exports c8ctl-plugin.js or c8ctl-plugin.ts
        const hasPlugin = pkgJson.main === 'c8ctl-plugin.js' || 
                         pkgJson.main === 'c8ctl-plugin.ts' ||
                         pkgJson.exports?.['./c8ctl-plugin.js'] ||
                         pkgJson.exports?.['./c8ctl-plugin.ts'];
        
        if (hasPlugin) {
          plugins.push({
            Name: name,
            Version: version as string,
            Type: dependencies[name] ? 'dependency' : 'devDependency',
          });
        }
      } catch {
        // Skip packages that can't be read
      }
    }
    
    if (plugins.length === 0) {
      logger.info('No c8ctl plugins installed');
      return;
    }
    
    logger.table(plugins);
  } catch (error) {
    logger.error('Failed to list plugins', error as Error);
    process.exit(1);
  }
}
