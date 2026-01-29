/**
 * Session management commands (use profile, use tenant, output mode)
 */
import { getLogger } from "../logger.js";
import { setActiveProfile, setActiveTenant, setOutputMode, getProfile, loadSessionState, } from "../config.js";
/**
 * Set active profile
 */
export function useProfile(name) {
    const logger = getLogger();
    // Verify profile exists
    const profile = getProfile(name);
    if (!profile) {
        logger.error(`Profile '${name}' not found`);
        process.exit(1);
    }
    setActiveProfile(name);
    logger.success(`Now using profile: ${name}`);
}
/**
 * Set active tenant
 */
export function useTenant(tenantId) {
    const logger = getLogger();
    setActiveTenant(tenantId);
    logger.success(`Now using tenant: ${tenantId}`);
}
/**
 * Set output mode
 */
export function setOutputFormat(mode) {
    const logger = getLogger();
    if (mode !== 'json' && mode !== 'text') {
        logger.error(`Invalid output mode: ${mode}. Must be 'json' or 'text'`);
        process.exit(1);
    }
    setOutputMode(mode);
    // Update logger immediately
    logger.mode = mode;
    logger.success(`Output mode set to: ${mode}`);
}
/**
 * Show current session state
 */
export function showSessionState() {
    const logger = getLogger();
    const state = loadSessionState();
    logger.info('\nCurrent Session State:');
    logger.info(`  Active Profile: ${state.activeProfile || '(none)'}`);
    logger.info(`  Active Tenant: ${state.activeTenant || '(none)'}`);
    logger.info(`  Output Mode: ${state.outputMode}`);
    logger.info('');
}
//# sourceMappingURL=session.js.map