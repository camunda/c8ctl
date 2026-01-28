/**
 * Session management commands (use profile, use tenant, output mode)
 */

import { getLogger } from '../logger.ts';
import {
  setActiveProfile,
  setActiveTenant,
  setOutputMode,
  getProfile,
  loadSessionState,
} from '../config.ts';
import type { OutputMode } from '../logger.ts';

/**
 * Set active profile
 */
export function useProfile(name: string): void {
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
export function useTenant(tenantId: string): void {
  const logger = getLogger();
  setActiveTenant(tenantId);
  logger.success(`Now using tenant: ${tenantId}`);
}

/**
 * Set output mode
 */
export function setOutputFormat(mode: string): void {
  const logger = getLogger();
  
  if (mode !== 'json' && mode !== 'text') {
    logger.error(`Invalid output mode: ${mode}. Must be 'json' or 'text'`);
    process.exit(1);
  }

  setOutputMode(mode as OutputMode);
  
  // Update logger immediately
  logger.setMode(mode as OutputMode);
  
  logger.success(`Output mode set to: ${mode}`);
}

/**
 * Show current session state
 */
export function showSessionState(): void {
  const logger = getLogger();
  const state = loadSessionState();
  
  logger.info('\nCurrent Session State:');
  logger.info(`  Active Profile: ${state.activeProfile || '(none)'}`);
  logger.info(`  Active Tenant: ${state.activeTenant || '(none)'}`);
  logger.info(`  Output Mode: ${state.outputMode}`);
  logger.info('');
}
