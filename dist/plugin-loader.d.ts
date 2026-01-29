/**
 * Plugin loader for dynamic command loading
 */
interface PluginCommands {
    [commandName: string]: (args: string[]) => Promise<void>;
}
/**
 * Load all installed plugins from node_modules
 */
export declare function loadInstalledPlugins(): Promise<void>;
/**
 * Get all loaded plugin commands
 */
export declare function getPluginCommands(): PluginCommands;
/**
 * Execute a plugin command if it exists
 */
export declare function executePluginCommand(commandName: string, args: string[]): Promise<boolean>;
/**
 * Check if a command is provided by a plugin
 */
export declare function isPluginCommand(commandName: string): boolean;
/**
 * Get list of all plugin command names
 */
export declare function getPluginCommandNames(): string[];
/**
 * Clear all loaded plugins (useful for testing and after uninstall)
 */
export declare function clearLoadedPlugins(): void;
export {};
//# sourceMappingURL=plugin-loader.d.ts.map