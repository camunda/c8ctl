/**
 * Profile management commands
 * c8ctl profiles are stored in DATA_DIR/c8ctl/profiles.json
 * Modeler connections are read from settings.json (read-only) with "modeler:" prefix
 */

import { getLogger } from '../logger.ts';
import { c8ctl } from '../runtime.ts';
import { readFileSync, existsSync } from 'node:fs';
import {
  getAllProfiles,
  getProfile,
  getProfileOrModeler,
  addProfile as addProfileConfig,
  removeProfile as removeProfileConfig,
  parseEnvFile,
  envVarsToProfile,
  hasCamundaEnvVars,
  DEFAULT_PROFILE,
  MODELER_PREFIX,
  type Profile,
} from '../config.ts';

/**
 * List all profiles (c8ctl + Modeler)
 */
export function listProfiles(): void {
  const logger = getLogger();
  const profiles = getAllProfiles();

  if (profiles.length === 0) {
    logger.info('No profiles configured');
    logger.info('');
    logger.info('Add a profile with: c8ctl profiles add <name> --url <cluster-url>');
    logger.info('Or configure connections in Camunda Modeler and they will appear with "modeler:" prefix.');
    return;
  }

  interface ProfileTableRow {
    Name: string;
    URL: string;
    Tenant: string;
    Source: string;
  }

  const activeProfile = c8ctl.activeProfile;
  const tableData: ProfileTableRow[] = profiles.map(profile => {
    const isModeler = profile.name.startsWith(MODELER_PREFIX);
    
    return {
      Name: profile.name === activeProfile ? `* ${profile.name}` : profile.name,
      URL: profile.baseUrl || '(not set)',
      Tenant: profile.defaultTenantId || '<default>',
      Source: isModeler ? 'Modeler' : 'c8ctl',
    };
  });

  logger.table(tableData);
  
  // Show hint about read-only Modeler profiles
  const hasModelerProfiles = profiles.some(p => p.name.startsWith(MODELER_PREFIX));
  if (hasModelerProfiles) {
    logger.info('');
    logger.info(`Note: Modeler profiles (prefixed with "${MODELER_PREFIX}") are read-only. Manage them in Camunda Modeler.`);
  }
}

/**
 * Show profile details
 */
export function showProfile(name: string): void {
  const logger = getLogger();
  const profile = getProfileOrModeler(name);

  if (!profile) {
    logger.error(`Profile '${name}' not found`);
    process.exit(1);
  }

  const isModeler = profile.name.startsWith(MODELER_PREFIX);
  
  logger.info(`Profile: ${profile.name}`);
  logger.info(`  Source: ${isModeler ? 'Camunda Modeler (read-only)' : 'c8ctl'}`);
  logger.info(`  Base URL: ${profile.baseUrl}`);
  
  if (profile.username) {
    logger.info(`  Username: ${profile.username}`);
    logger.info(`  Password: ${profile.password ? '********' : '(not set)'}`);
  }
  
  if (profile.clientId) {
    logger.info(`  Client ID: ${profile.clientId}`);
    logger.info(`  Client Secret: ${profile.clientSecret ? '********' : '(not set)'}`);
  }
  
  if (profile.audience) {
    logger.info(`  Audience: ${profile.audience}`);
  }
  
  if (profile.oAuthUrl) {
    logger.info(`  OAuth URL: ${profile.oAuthUrl}`);
  }
  
  if (profile.defaultTenantId) {
    logger.info(`  Default Tenant: ${profile.defaultTenantId}`);
  }
}

export interface AddProfileOptions {
  url?: string;
  clientId?: string;
  clientSecret?: string;
  audience?: string;
  oauthUrl?: string;
  username?: string;
  password?: string;
  tenantId?: string;
  envFile?: string;
  fromEnv?: boolean;
}

/**
 * Describe the auth type of a profile for user feedback.
 */
function describeAuth(profile: Profile): string {
  if (profile.clientId && profile.clientSecret) return 'OAuth (client credentials)';
  if (profile.username && profile.password) return 'Basic auth';
  return 'None';
}

/**
 * Add a c8ctl profile
 */
export function addProfile(name: string, options: AddProfileOptions): void {
  const logger = getLogger();

  // Prevent adding profiles with "modeler:" prefix
  if (name.startsWith(MODELER_PREFIX)) {
    logger.error(`Profile names cannot start with "${MODELER_PREFIX}" - this prefix is reserved for Camunda Modeler connections`);
    logger.info('Please choose a different name or manage this profile in Camunda Modeler');
    process.exit(1);
  }

  let profile: Profile;

  if (options.envFile && options.fromEnv) {
    logger.error('Cannot use --from-file and --from-env together. Choose one.');
    process.exit(1);
  }

  if (options.envFile) {
    // --from-file: read a .env file and map CAMUNDA_* vars to profile fields
    if (!existsSync(options.envFile)) {
      logger.error(`File not found: ${options.envFile}`);
      process.exit(1);
    }
    const content = readFileSync(options.envFile, 'utf-8');
    const vars = parseEnvFile(content);
    profile = envVarsToProfile(name, vars);
    if (!profile.baseUrl) {
      logger.error(`CAMUNDA_BASE_URL not found in ${options.envFile}`);
      logger.info('The .env file must contain at least CAMUNDA_BASE_URL.');
      process.exit(1);
    }
    addProfileConfig(profile);
    logger.success(`Profile '${name}' added (from ${options.envFile})`);
    logger.info(`  Base URL: ${profile.baseUrl}`);
    logger.info(`  Auth: ${describeAuth(profile)}`);
  } else if (options.fromEnv) {
    // --from-env: read from current process environment
    profile = envVarsToProfile(name, process.env);
    if (!profile.baseUrl) {
      logger.error('CAMUNDA_BASE_URL not set in environment');
      logger.info('Set CAMUNDA_BASE_URL before using --from-env.');
      process.exit(1);
    }
    addProfileConfig(profile);
    logger.success(`Profile '${name}' added (from environment)`);
    logger.info(`  Base URL: ${profile.baseUrl}`);
    logger.info(`  Auth: ${describeAuth(profile)}`);
  } else {
    // Manual flags
    profile = {
      name,
      baseUrl: options.url || 'http://localhost:8080/v2',
      clientId: options.clientId,
      clientSecret: options.clientSecret,
      audience: options.audience,
      oAuthUrl: options.oauthUrl,
      username: options.username,
      password: options.password,
      defaultTenantId: options.tenantId,
    };
    addProfileConfig(profile);
    logger.success(`Profile '${name}' added`);
  }
}

/**
 * Remove a c8ctl profile
 */
export function removeProfile(name: string): void {
  const logger = getLogger();

  // Prevent removing Modeler profiles
  if (name.startsWith(MODELER_PREFIX)) {
    logger.error('Cannot remove Modeler profiles via c8ctl');
    logger.info('Manage Modeler connections directly in Camunda Modeler');
    process.exit(1);
  }

  const removed = removeProfileConfig(name);
  if (removed) {
    logger.success(`Profile '${name}' removed`);
  } else {
    logger.error(`Profile '${name}' not found`);
    process.exit(1);
  }
}

/**
 * Show which profile is currently active
 */
export function whichProfile(): void {
  const logger = getLogger();
  const active = c8ctl.activeProfile;
  if (!active) {
    const hasBaseUrl = !!process.env.CAMUNDA_BASE_URL?.trim();
    if (hasBaseUrl) {
      logger.info('(none — CAMUNDA_* env vars will be used)');
    } else if (hasCamundaEnvVars()) {
      logger.info(`${DEFAULT_PROFILE} (default — CAMUNDA_* env vars detected but incomplete; set CAMUNDA_BASE_URL to use them)`);
    } else {
      logger.info(`${DEFAULT_PROFILE} (default)`);
    }
    return;
  }
  logger.info(active);
}
