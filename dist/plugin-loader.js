/**
 * Plugin loader for dynamic command loading
 */
var __rewriteRelativeImportExtension = (this && this.__rewriteRelativeImportExtension) || function (path, preserveJsx) {
    if (typeof path === "string" && /^\.\.?\//.test(path)) {
        return path.replace(/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i, function (m, tsx, d, ext, cm) {
            return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : (d + ext + "." + cm.toLowerCase() + "js");
        });
    }
    return path;
};
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getLogger } from "./logger.js";
const loadedPlugins = new Map();
/**
 * Load all installed plugins from node_modules
 */
export async function loadInstalledPlugins() {
    const logger = getLogger();
    const nodeModulesPath = join(process.cwd(), 'node_modules');
    if (!existsSync(nodeModulesPath)) {
        logger.debug('node_modules directory not found');
        return;
    }
    try {
        const packages = readdirSync(nodeModulesPath);
        logger.debug(`Scanning ${packages.length} packages in node_modules`);
        for (const packageName of packages) {
            if (packageName.startsWith('.') || packageName.startsWith('@')) {
                continue;
            }
            const packagePath = join(nodeModulesPath, packageName);
            const pluginFileJs = join(packagePath, 'c8ctl-plugin.js');
            const pluginFileTs = join(packagePath, 'c8ctl-plugin.ts');
            if (existsSync(pluginFileJs) || existsSync(pluginFileTs)) {
                logger.debug(`Found plugin candidate: ${packageName}`);
                try {
                    const pluginFile = existsSync(pluginFileJs) ? pluginFileJs : pluginFileTs;
                    // Use file:// protocol and add timestamp to bust cache
                    const pluginUrl = `file://${pluginFile}?t=${Date.now()}`;
                    logger.debug(`Loading plugin from: ${pluginUrl}`);
                    const plugin = await import(__rewriteRelativeImportExtension(pluginUrl));
                    if (plugin.commands && typeof plugin.commands === 'object') {
                        loadedPlugins.set(packageName, {
                            name: packageName,
                            commands: plugin.commands,
                        });
                        const commandNames = Object.keys(plugin.commands);
                        logger.debug(`Successfully loaded plugin: ${packageName} with ${commandNames.length} commands:`, commandNames);
                    }
                }
                catch (error) {
                    logger.debug(`Failed to load plugin ${packageName}:`, error);
                }
            }
        }
        logger.debug(`Total plugins loaded: ${loadedPlugins.size}`);
    }
    catch (error) {
        logger.debug('Error scanning for plugins:', error);
    }
}
/**
 * Get all loaded plugin commands
 */
export function getPluginCommands() {
    const allCommands = {};
    for (const plugin of loadedPlugins.values()) {
        Object.assign(allCommands, plugin.commands);
    }
    return allCommands;
}
/**
 * Execute a plugin command if it exists
 */
export async function executePluginCommand(commandName, args) {
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
export function isPluginCommand(commandName) {
    const commands = getPluginCommands();
    return commandName in commands;
}
/**
 * Get list of all plugin command names
 */
export function getPluginCommandNames() {
    return Object.keys(getPluginCommands());
}
/**
 * Clear all loaded plugins (useful for testing and after uninstall)
 */
export function clearLoadedPlugins() {
    loadedPlugins.clear();
}
//# sourceMappingURL=plugin-loader.js.map