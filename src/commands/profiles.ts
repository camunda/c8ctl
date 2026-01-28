/**
 * Profile management commands
 */

import { getLogger } from '../logger.ts';
import {
  loadProfiles,
  addProfile as addProfileToConfig,
  removeProfile as removeProfileFromConfig,
  loadModelerProfiles,
  convertModelerProfile,
  type Profile,
} from '../config.ts';

/**
 * List all profiles
 */
export function listProfiles(): void {
  const logger = getLogger();
  const c8ctlProfiles = loadProfiles();
  const modelerProfiles = loadModelerProfiles();
  
  const totalProfiles = c8ctlProfiles.length + modelerProfiles.length;
  
  if (totalProfiles === 0) {
    logger.info('No profiles configured');
    return;
  }

  interface ProfileTableRow {
    Name: string;
    'Base URL': string;
    'Client ID': string;
    'Default Tenant': string;
  }
  
  const tableData: ProfileTableRow[] = [];
  
  // Add c8ctl profiles
  for (const p of c8ctlProfiles) {
    tableData.push({
      Name: p.name,
      'Base URL': p.baseUrl,
      'Client ID': p.clientId || '(none)',
      'Default Tenant': p.defaultTenantId || '<default>',
    });
  }
  
  // Add modeler profiles with 'modeler:' prefix
  for (const mp of modelerProfiles) {
    const converted = convertModelerProfile(mp);
    tableData.push({
      Name: converted.name,
      'Base URL': converted.baseUrl,
      'Client ID': converted.clientId || '(none)',
      'Default Tenant': converted.defaultTenantId || '<default>',
    });
  }

  logger.table(tableData);
}

/**
 * Add a profile
 */
export function addProfile(name: string, options: {
  baseUrl?: string;
  clientId?: string;
  clientSecret?: string;
  audience?: string;
  oAuthUrl?: string;
  defaultTenantId?: string;
}): void {
  const logger = getLogger();

  // Validate required fields
  if (!options.baseUrl) {
    logger.error('Base URL is required. Use --baseUrl flag');
    process.exit(1);
  }

  const profile: Profile = {
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
export function removeProfile(name: string): void {
  const logger = getLogger();
  
  const removed = removeProfileFromConfig(name);
  if (removed) {
    logger.success(`Profile '${name}' removed`);
  } else {
    logger.error(`Profile '${name}' not found`);
    process.exit(1);
  }
}
