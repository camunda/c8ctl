/**
 * Profile management commands
 */
import { getLogger } from "../logger.js";
import { loadProfiles, addProfile as addProfileToConfig, removeProfile as removeProfileFromConfig, } from "../config.js";
/**
 * List all profiles
 */
export function listProfiles() {
    const logger = getLogger();
    const profiles = loadProfiles();
    if (profiles.length === 0) {
        logger.info('No profiles configured');
        return;
    }
    const tableData = profiles.map(p => ({
        Name: p.name,
        'Base URL': p.baseUrl,
        'Client ID': p.clientId || '(none)',
        'Default Tenant': p.defaultTenantId || '<default>',
    }));
    logger.table(tableData);
}
/**
 * Add a profile
 */
export function addProfile(name, options) {
    const logger = getLogger();
    // Validate required fields
    if (!options.baseUrl) {
        logger.error('Base URL is required. Use --baseUrl flag');
        process.exit(1);
    }
    const profile = {
        name,
        baseUrl: options.baseUrl,
        clientId: options.clientId,
        clientSecret: options.clientSecret,
        audience: options.audience,
        oAuthUrl: options.oAuthUrl,
        defaultTenantId: options.defaultTenantId,
    };
    addProfileToConfig(profile);
    logger.success(`Profile '${name}' added`);
}
/**
 * Remove a profile
 */
export function removeProfile(name) {
    const logger = getLogger();
    const removed = removeProfileFromConfig(name);
    if (removed) {
        logger.success(`Profile '${name}' removed`);
    }
    else {
        logger.error(`Profile '${name}' not found`);
        process.exit(1);
    }
}
//# sourceMappingURL=profiles.js.map