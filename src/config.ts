/**
 * Configuration and session state management for c8ctl
 * Handles profiles, session state, and credential resolution
 */

import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import type { OutputMode } from './logger.ts';
import { c8ctl } from './runtime.ts';

export interface Profile {
  name: string;
  baseUrl: string;
  clientId?: string;
  clientSecret?: string;
  audience?: string;
  oAuthUrl?: string;
  username?: string;
  password?: string;
  defaultTenantId?: string;
}

export interface SessionState {
  activeProfile?: string;
  activeTenant?: string;
  outputMode: OutputMode;
}

export interface ClusterConfig {
  baseUrl: string;
  clientId?: string;
  clientSecret?: string;
  audience?: string;
  oAuthUrl?: string;
  username?: string;
  password?: string;
}

/**
 * Camunda Modeler profile structure
 */
export interface ModelerProfile {
  name?: string;
  clusterId?: string;
  clusterUrl?: string;
  audience?: string;
  clientId?: string;
  clientSecret?: string;
}

/**
 * Camunda Modeler profiles.json structure
 */
interface ModelerProfilesFile {
  profiles?: ModelerProfile[];
}

/**
 * Get platform-specific user data directory
 */
export function getUserDataDir(): string {
  // Allow override for testing
  if (process.env.C8CTL_DATA_DIR) {
    return process.env.C8CTL_DATA_DIR;
  }
  
  const plat = platform();
  const home = homedir();

  switch (plat) {
    case 'win32':
      return join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'c8ctl');
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'c8ctl');
    default: // linux and others
      return join(process.env.XDG_DATA_HOME || join(home, '.local', 'share'), 'c8ctl');
  }
}

/**
 * Get platform-specific Camunda Modeler data directory
 */
export function getModelerDataDir(): string {
  const plat = platform();
  const home = homedir();

  switch (plat) {
    case 'win32':
      return join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'camunda-modeler');
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'camunda-modeler');
    default: // linux and others
      return join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'camunda-modeler');
  }
}

/**
 * Ensure user data directory exists
 */
function ensureUserDataDir(): string {
  const dir = getUserDataDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Get profiles file path
 */
function getProfilesPath(): string {
  return join(ensureUserDataDir(), 'profiles.json');
}

/**
 * Get session state file path
 */
function getSessionStatePath(): string {
  return join(ensureUserDataDir(), 'session.json');
}

/**
 * Load all profiles
 */
export function loadProfiles(): Profile[] {
  const path = getProfilesPath();
  if (!existsSync(path)) {
    return [];
  }
  try {
    const data = readFileSync(path, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    return [];
  }
}

/**
 * Save profiles to disk
 */
export function saveProfiles(profiles: Profile[]): void {
  const path = getProfilesPath();
  writeFileSync(path, JSON.stringify(profiles, null, 2), 'utf-8');
}

/**
 * Get a profile by name
 * Supports both c8ctl profiles and modeler profiles (with 'modeler:' prefix)
 */
export function getProfile(name: string): Profile | undefined {
  // Check if this is a modeler profile request
  if (name.startsWith('modeler:')) {
    const modelerProfile = getModelerProfile(name);
    if (modelerProfile) {
      return convertModelerProfile(modelerProfile);
    }
    return undefined;
  }
  
  // Check c8ctl profiles
  const profiles = loadProfiles();
  return profiles.find(p => p.name === name);
}

/**
 * Add or update a profile
 */
export function addProfile(profile: Profile): void {
  const profiles = loadProfiles();
  const existingIndex = profiles.findIndex(p => p.name === profile.name);
  
  if (existingIndex >= 0) {
    profiles[existingIndex] = profile;
  } else {
    profiles.push(profile);
  }
  
  saveProfiles(profiles);
}

/**
 * Remove a profile
 */
export function removeProfile(name: string): boolean {
  const profiles = loadProfiles();
  const filtered = profiles.filter(p => p.name !== name);
  
  if (filtered.length === profiles.length) {
    return false; // Profile not found
  }
  
  saveProfiles(filtered);
  return true;
}

/**
 * Load session state from c8ctl runtime object
 */
export function loadSessionState(): SessionState {
  return {
    activeProfile: c8ctl.activeProfile,
    activeTenant: c8ctl.activeTenant,
    outputMode: c8ctl.outputMode,
  };
}

/**
 * Save session state to c8ctl runtime object
 * Note: Session state is no longer persisted to disk
 */
export function saveSessionState(state: SessionState): void {
  c8ctl.activeProfile = state.activeProfile;
  c8ctl.activeTenant = state.activeTenant;
  c8ctl.outputMode = state.outputMode;
}

/**
 * Set active profile in session
 */
export function setActiveProfile(name: string): void {
  c8ctl.activeProfile = name;
}

/**
 * Set active tenant in session
 */
export function setActiveTenant(tenantId: string): void {
  c8ctl.activeTenant = tenantId;
}

/**
 * Set output mode in session
 */
export function setOutputMode(mode: OutputMode): void {
  c8ctl.outputMode = mode;
}

/**
 * Resolve cluster configuration from session, flags, env vars, or defaults
 * Priority: profileFlag → session profile → env vars → localhost fallback
 */
export function resolveClusterConfig(profileFlag?: string): ClusterConfig {
  // 1. Try profile flag
  if (profileFlag) {
    const profile = getProfile(profileFlag);
    if (profile) {
      return {
        baseUrl: profile.baseUrl,
        clientId: profile.clientId,
        clientSecret: profile.clientSecret,
        audience: profile.audience,
        oAuthUrl: profile.oAuthUrl,
        username: profile.username,
        password: profile.password,
      };
    }
  }

  // 2. Try session profile
  if (c8ctl.activeProfile) {
    const profile = getProfile(c8ctl.activeProfile);
    if (profile) {
      return {
        baseUrl: profile.baseUrl,
        clientId: profile.clientId,
        clientSecret: profile.clientSecret,
        audience: profile.audience,
        oAuthUrl: profile.oAuthUrl,
        username: profile.username,
        password: profile.password,
      };
    }
  }

  // 3. Try environment variables
  const baseUrl = process.env.CAMUNDA_BASE_URL;
  const clientId = process.env.CAMUNDA_CLIENT_ID;
  const clientSecret = process.env.CAMUNDA_CLIENT_SECRET;
  const audience = process.env.CAMUNDA_AUDIENCE;
  const oAuthUrl = process.env.CAMUNDA_OAUTH_URL;
  const username = process.env.CAMUNDA_USERNAME;
  const password = process.env.CAMUNDA_PASSWORD;

  if (baseUrl) {
    return {
      baseUrl,
      clientId,
      clientSecret,
      audience,
      oAuthUrl,
      username,
      password,
    };
  }

  // 4. Localhost fallback with basic auth (demo/demo)
  // These default credentials match the docker-compose configuration
  // and are intended for local development only
  return {
    baseUrl: 'http://localhost:8080/v2',
    username: 'demo',
    password: 'demo',
  };
}

/**
 * Resolve tenant ID from session, profile, env vars, or default
 * Priority: session tenant → profile default tenant → env var → '<default>'
 */
export function resolveTenantId(profileFlag?: string): string {
  // 1. Try session tenant
  if (c8ctl.activeTenant) {
    return c8ctl.activeTenant;
  }

  // 2. Try profile default tenant (from flag or session)
  const profileName = profileFlag || c8ctl.activeProfile;
  if (profileName) {
    const profile = getProfile(profileName);
    if (profile?.defaultTenantId) {
      return profile.defaultTenantId;
    }
  }

  // 3. Try environment variable
  const envTenant = process.env.CAMUNDA_DEFAULT_TENANT_ID;
  if (envTenant) {
    return envTenant;
  }

  // 4. Default tenant
  return '<default>';
}

/**
 * Load Camunda Modeler profiles from profiles.json
 * Always reads fresh from disk (no caching)
 * 
 * TODO: Consider introducing caching mechanism for better performance.
 * Current implementation reads from disk on every call. For commands that
 * list profiles or look up multiple profiles, this could be optimized by
 * implementing per-execution memoization or a time-based cache.
 */
export function loadModelerProfiles(): ModelerProfile[] {
  try {
    const modelerDir = getModelerDataDir();
    const profilesPath = join(modelerDir, 'profiles.json');
    
    if (!existsSync(profilesPath)) {
      return [];
    }
    
    const data = readFileSync(profilesPath, 'utf-8');
    const parsed: ModelerProfilesFile = JSON.parse(data);
    
    return parsed.profiles || [];
  } catch (error) {
    // Silently return empty array if file can't be read or parsed
    return [];
  }
}

/**
 * Get a modeler profile by name or cluster ID
 * Accepts 'modeler:name' or 'modeler:id' format, or just 'name'/'id'
 */
export function getModelerProfile(identifier: string): ModelerProfile | undefined {
  const profiles = loadModelerProfiles();
  
  // Remove 'modeler:' prefix if present
  const searchId = identifier.startsWith('modeler:') 
    ? identifier.substring(8) 
    : identifier;
  
  // Search by name first, then by clusterId
  return profiles.find(p => 
    p.name === searchId || p.clusterId === searchId
  );
}

/**
 * Construct REST API URL from modeler profile
 * For cloud: uses clusterUrl as-is (Camunda cloud URLs don't need /v2)
 * For self-managed: localhost URLs get /v2 appended
 * Does not derive values - uses what's provided
 * 
 * Note: Self-managed clusters should include /v2 in their clusterUrl if needed
 */
export function constructApiUrl(profile: ModelerProfile): string {
  // If clusterUrl is provided, use it as the base
  if (profile.clusterUrl) {
    const url = profile.clusterUrl;
    
    // If it already has /v2 endpoint, use as-is
    if (url.includes('/v2')) {
      return url;
    }
    
    // Only append /v2 for localhost URLs
    // Self-managed clusters should include /v2 in their clusterUrl if needed
    if (url.includes('localhost') || url.includes('127.0.0.1')) {
      return `${url.replace(/\/$/, '')}/v2`;
    }
    
    // For all other URLs (including cloud), use as-is
    return url;
  }
  
  // If no clusterUrl but have clusterId, construct cloud URL
  if (profile.clusterId) {
    // Cloud cluster URLs follow pattern: https://{clusterId}.{region}.zeebe.camunda.io
    // We can't derive the region, so just use the clusterId as a fallback base
    return `https://${profile.clusterId}.zeebe.camunda.io`;
  }
  
  // Fallback to localhost
  return 'http://localhost:8080/v2';
}

/**
 * Convert a modeler profile to a c8ctl Profile
 */
export function convertModelerProfile(modelerProfile: ModelerProfile): Profile {
  const name = modelerProfile.name || modelerProfile.clusterId || 'unknown';
  const baseUrl = constructApiUrl(modelerProfile);
  
  return {
    name: `modeler:${name}`,
    baseUrl,
    clientId: modelerProfile.clientId,
    clientSecret: modelerProfile.clientSecret,
    audience: modelerProfile.audience,
    // Cloud clusters typically use the standard OAuth URL
    oAuthUrl: modelerProfile.audience ? 
      'https://login.cloud.camunda.io/oauth/token' : 
      undefined,
  };
}
