/**
 * Profile management commands
 * c8ctl profiles are stored in DATA_DIR/c8ctl/profiles.json
 * Modeler connections are read from settings.json (read-only) with "modeler:" prefix
 */

import { getLogger } from '../logger.ts';
import {
  getAllProfiles,
  getProfile,
  getProfileOrModeler,
  addProfile as addProfileConfig,
  removeProfile as removeProfileConfig,
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

  const tableData: ProfileTableRow[] = profiles.map(profile => {
    const isModeler = profile.name.startsWith('modeler:');
    
    return {
      Name: profile.name,
      URL: profile.baseUrl || '(not set)',
      Tenant: profile.defaultTenantId || '<default>',
      Source: isModeler ? 'Modeler' : 'c8ctl',
    };
  });

  logger.table(tableData);
  
  // Show hint about read-only Modeler profiles
  const hasModelerProfiles = profiles.some(p => p.name.startsWith('modeler:'));
  if (hasModelerProfiles) {
    logger.info('');
    logger.info('Note: Modeler profiles (prefixed with "modeler:") are read-only. Manage them in Camunda Modeler.');
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

  const isModeler = profile.name.startsWith('modeler:');
  
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
}

/**
 * Add a c8ctl profile
 */
export function addProfile(name: string, options: AddProfileOptions): void {
  const logger = getLogger();

  // Prevent adding profiles with "modeler:" prefix
  if (name.startsWith('modeler:')) {
    logger.error('Profile names cannot start with "modeler:" - this prefix is reserved for Camunda Modeler connections');
    logger.info('Please choose a different name or manage this profile in Camunda Modeler');
    process.exit(1);
  }

  const profile: Profile = {
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

/**
 * Remove a c8ctl profile
 */
export function removeProfile(name: string): void {
  const logger = getLogger();

  // Prevent removing Modeler profiles
  if (name.startsWith('modeler:')) {
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
