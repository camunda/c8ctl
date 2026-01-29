/**
 * Plugin management commands
 */
/**
 * Load a plugin (npm install wrapper)
 * Supports either package name or --from flag with URL
 */
export declare function loadPlugin(packageNameOrFrom?: string, fromUrl?: string): Promise<void>;
/**
 * Unload a plugin (npm uninstall wrapper)
 */
export declare function unloadPlugin(packageName: string): Promise<void>;
/**
 * List installed plugins
 */
export declare function listPlugins(): void;
//# sourceMappingURL=plugins.d.ts.map