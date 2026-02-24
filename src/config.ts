/**
 * Configuration and session state management for c8ctl
 *
 * c8ctl stores its own profiles in DATA_DIR/c8ctl/profiles.json
 * Modeler connections are read from settings.json (read-only) with "modeler:" prefix
 */

import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { OutputMode } from './logger.ts';
import { c8ctl } from './runtime.ts';

// ============================================================================
// Constants - matching Camunda Modeler exactly
// ============================================================================

export const TARGET_TYPES = {
  CAMUNDA_CLOUD: 'camundaCloud',
  SELF_HOSTED: 'selfHosted',
} as const;

export type TargetType = typeof TARGET_TYPES[keyof typeof TARGET_TYPES];

export const AUTH_TYPES = {
  NONE: 'none',
  BASIC: 'basic',
  OAUTH: 'oauth',
} as const;

export type AuthType = typeof AUTH_TYPES[keyof typeof AUTH_TYPES];

// ============================================================================
// Connection Types - matching Camunda Modeler's connection-manager-plugin
// ============================================================================

/**
 * Connection structure matching Camunda Modeler's ConnectionManagerSettingsProperties
 * @see https://github.com/camunda/camunda-modeler/blob/main/client/src/plugins/zeebe-plugin/connection-manager-plugin/ConnectionManagerSettingsProperties.js
 */
export interface Connection {
  /** Unique identifier (UUID) */
  id: string;
  /** Human-readable connection name */
  name?: string;
  /** Target environment type */
  targetType: TargetType;

  // Camunda Cloud (SaaS) properties
  /** Camunda Cloud cluster URL (e.g., https://xxx.bru-2.zeebe.camunda.io/xxx) */
  camundaCloudClusterUrl?: string;
  /** Camunda Cloud client ID */
  camundaCloudClientId?: string;
  /** Camunda Cloud client secret */
  camundaCloudClientSecret?: string;

  // Self-Hosted properties
  /** Self-hosted cluster URL (e.g., http://localhost:8080/v2) */
  contactPoint?: string;
  /** Authentication type for self-hosted */
  authType?: AuthType;
  /** Tenant ID (optional) */
  tenantId?: string;
  /** Operate URL (optional) */
  operateUrl?: string;

  // Basic Auth (self-hosted)
  basicAuthUsername?: string;
  basicAuthPassword?: string;

  // OAuth (self-hosted)
  clientId?: string;
  clientSecret?: string;
  oauthURL?: string;
  audience?: string;
  scope?: string;
}

/**
 * c8ctl Profile interface - stored in DATA_DIR/c8ctl/profiles.json
 * This is c8ctl's native profile format
 */
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

// ============================================================================
// Validation - matching Camunda Modeler's validation rules
// ============================================================================

const VALIDATION_PATTERNS = {
  URL: /^https?:\/\//,
  CAMUNDA_CLOUD_REST_URL: /^https:\/\/[a-z]+-\d+\.zeebe\.camunda\.io(:443|)\/[a-z\d-]+\/?$/,
};

// Cloud URLs must be REST URLs (HTTP-based)
const CAMUNDA_CLOUD_URL_PATTERN = VALIDATION_PATTERNS.CAMUNDA_CLOUD_REST_URL;

/**
 * Validate a connection configuration
 * Returns array of error messages (empty if valid)
 */
export function validateConnection(conn: Partial<Connection>): string[] {
  const errors: string[] = [];

  if (!conn) {
    errors.push('Connection configuration is required');
    return errors;
  }

  if (!conn.id) {
    errors.push('Connection must have an ID');
  }

  if (!conn.targetType) {
    errors.push('Target type is required (camundaCloud or selfHosted)');
    return errors;
  }

  if (conn.targetType === TARGET_TYPES.CAMUNDA_CLOUD) {
    if (!conn.camundaCloudClusterUrl) {
      errors.push('Cluster URL is required for Camunda Cloud');
    } else if (!CAMUNDA_CLOUD_URL_PATTERN.test(conn.camundaCloudClusterUrl)) {
      errors.push('Cluster URL must be a valid Camunda 8 SaaS URL');
    }
    if (!conn.camundaCloudClientId) {
      errors.push('Client ID is required for Camunda Cloud');
    }
    if (!conn.camundaCloudClientSecret) {
      errors.push('Client Secret is required for Camunda Cloud');
    }
  } else if (conn.targetType === TARGET_TYPES.SELF_HOSTED) {
    if (!conn.contactPoint) {
      errors.push('Cluster URL (contactPoint) is required for Self-Hosted');
    } else if (!VALIDATION_PATTERNS.URL.test(conn.contactPoint)) {
      errors.push('Cluster URL must start with http:// or https://');
    }

    if (conn.authType === AUTH_TYPES.BASIC) {
      if (!conn.basicAuthUsername) {
        errors.push('Username is required for Basic authentication');
      }
      if (!conn.basicAuthPassword) {
        errors.push('Password is required for Basic authentication');
      }
    } else if (conn.authType === AUTH_TYPES.OAUTH) {
      if (!conn.clientId) {
        errors.push('Client ID is required for OAuth authentication');
      }
      if (!conn.clientSecret) {
        errors.push('Client Secret is required for OAuth authentication');
      }
      if (!conn.oauthURL) {
        errors.push('OAuth URL is required for OAuth authentication');
      }
      if (!conn.audience) {
        errors.push('Audience is required for OAuth authentication');
      }
    }
  } else {
    errors.push(`Unknown target type: ${conn.targetType}`);
  }

  return errors;
}

// ============================================================================
// Directory and Path Utilities
// ============================================================================

/**
 * Get platform-specific user data directory for c8ctl
 */
export function getUserDataDir(): string {
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
    default:
      return join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'c8ctl');
  }
}

/**
 * Get platform-specific Camunda Modeler data directory
 * Modeler stores connections in settings.json
 */
export function getModelerDataDir(): string {
  // Allow override for testing
  if (process.env.C8CTL_MODELER_DIR) {
    return process.env.C8CTL_MODELER_DIR;
  }

  const plat = platform();
  const home = homedir();

  switch (plat) {
    case 'win32':
      return join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'camunda-modeler');
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'camunda-modeler');
    default:
      return join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'camunda-modeler');
  }
}

function ensureUserDataDir(): string {
  const dir = getUserDataDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Get the global plugins directory for c8ctl
 * This is where plugins are installed globally, independent of any project
 */
export function getPluginsDir(): string {
  return join(getUserDataDir(), 'plugins');
}

/**
 * Ensure plugins directory exists
 */
export function ensurePluginsDir(): string {
  const dir = getPluginsDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function getSessionStatePath(): string {
  return join(ensureUserDataDir(), 'session.json');
}

function getProfilesPath(): string {
  return join(ensureUserDataDir(), 'profiles.json');
}

function getModelerSettingsPath(): string {
  return join(getModelerDataDir(), 'settings.json');
}

// ============================================================================
// c8ctl Profile Management - stored in DATA_DIR/c8ctl/profiles.json
// ============================================================================

interface ProfilesFile {
  profiles: Profile[];
}

/**
 * Load c8ctl profiles from profiles.json
 */
export function loadProfiles(): Profile[] {
  const profilesPath = getProfilesPath();

  if (!existsSync(profilesPath)) {
    return [];
  }

  try {
    const data = readFileSync(profilesPath, 'utf-8');
    const profilesFile: ProfilesFile = JSON.parse(data);
    return profilesFile.profiles || [];
  } catch {
    return [];
  }
}

/**
 * Save c8ctl profiles to profiles.json
 */
export function saveProfiles(profiles: Profile[]): void {
  const profilesPath = getProfilesPath();
  const profilesFile: ProfilesFile = { profiles };
  writeFileSync(profilesPath, JSON.stringify(profilesFile, null, 2), 'utf-8');
}

/**
 * Get a c8ctl profile by name
 */
export function getProfile(name: string): Profile | undefined {
  const profiles = loadProfiles();
  return profiles.find(p => p.name === name);
}

/**
 * Add a c8ctl profile
 */
export function addProfile(profile: Profile): void {
  const profiles = loadProfiles();
  
  // Check if profile already exists
  const existingIndex = profiles.findIndex(p => p.name === profile.name);
  if (existingIndex >= 0) {
    profiles[existingIndex] = profile;
  } else {
    profiles.push(profile);
  }
  
  saveProfiles(profiles);
}

/**
 * Remove a c8ctl profile by name
 */
export function removeProfile(name: string): boolean {
  const profiles = loadProfiles();
  const filtered = profiles.filter(p => p.name !== name);
  
  if (filtered.length === profiles.length) {
    return false;
  }
  
  saveProfiles(filtered);
  return true;
}

// ============================================================================
// Modeler Connection Management - READ-ONLY from settings.json
// ============================================================================

export const MODELER_PREFIX = 'modeler:';

interface ModelerSettingsFile {
  'connectionManagerPlugin.c8connections'?: Connection[];
  [key: string]: unknown;
}

/**
 * Load connections from Modeler's settings.json (read-only)
 * These are NOT modified by c8ctl
 */
export function loadModelerConnections(): Connection[] {
  const settingsPath = getModelerSettingsPath();

  if (!existsSync(settingsPath)) {
    return [];
  }

  try {
    const data = readFileSync(settingsPath, 'utf-8');
    const settings: ModelerSettingsFile = JSON.parse(data);
    const connections = settings['connectionManagerPlugin.c8connections'];

    if (!connections || !Array.isArray(connections)) {
      return [];
    }

    // Filter out invalid connections (must have id)
    return connections.filter(c => c && c.id);
  } catch {
    return [];
  }
}

/**
 * Get all profiles including c8ctl profiles and Modeler connections
 * Modeler connections are prefixed with "modeler:"
 */
export function getAllProfiles(): Profile[] {
  const c8ctlProfiles = loadProfiles();
  const modelerConnections = loadModelerConnections();
  
  // Convert Modeler connections to Profile format with "modeler:" prefix
  const modelerProfiles = modelerConnections.map(connectionToProfile).map(p => ({
    ...p,
    name: `${MODELER_PREFIX}${p.name}`,
  }));
  
  return [...c8ctlProfiles, ...modelerProfiles];
}

/**
 * Get a profile by name, checking both c8ctl and Modeler sources
 * For Modeler profiles, accepts name with or without "modeler:" prefix
 */
export function getProfileOrModeler(name: string): Profile | undefined {
  // Try c8ctl profiles first
  const c8ctlProfile = getProfile(name);
  if (c8ctlProfile) {
    return c8ctlProfile;
  }
  
  // Try Modeler connections (with or without prefix)
  const modelerName = name.startsWith(MODELER_PREFIX) ? name.slice(MODELER_PREFIX.length) : name;
  const modelerConnections = loadModelerConnections();
  const modelerConnection = modelerConnections.find(
    c => c.name === modelerName || c.id === modelerName
  );
  
  if (modelerConnection) {
    const profile = connectionToProfile(modelerConnection);
    return {
      ...profile,
      name: `${MODELER_PREFIX}${profile.name}`,
    };
  }
  
  return undefined;
}

// ============================================================================
// Conversion Utilities
// ============================================================================

/**
 * Convert a Connection to ClusterConfig for API client use
 */
export function connectionToClusterConfig(conn: Connection): ClusterConfig {
  if (conn.targetType === TARGET_TYPES.CAMUNDA_CLOUD) {
    const audience = conn.audience?.trim();
    const oAuthUrl = conn.oauthURL?.trim();

    return {
      baseUrl: conn.camundaCloudClusterUrl || '',
      clientId: conn.camundaCloudClientId,
      clientSecret: conn.camundaCloudClientSecret,
      audience: audience || undefined,
      oAuthUrl: oAuthUrl || 'https://login.cloud.camunda.io/oauth/token',
    };
  }

  // Self-hosted
  const config: ClusterConfig = {
    baseUrl: conn.contactPoint || 'http://localhost:8080/v2',
  };

  if (conn.authType === AUTH_TYPES.BASIC) {
    config.username = conn.basicAuthUsername;
    config.password = conn.basicAuthPassword;
  } else if (conn.authType === AUTH_TYPES.OAUTH) {
    config.clientId = conn.clientId;
    config.clientSecret = conn.clientSecret;
    config.oAuthUrl = conn.oauthURL;
    config.audience = conn.audience;
  }

  return config;
}

/**
 * Convert Connection to Profile format
 * Used to convert read-only Modeler connections to c8ctl Profile format
 */
export function connectionToProfile(conn: Connection): Profile {
  const config = connectionToClusterConfig(conn);

  return {
    name: conn.name || conn.id,
    baseUrl: config.baseUrl,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    audience: config.audience,
    oAuthUrl: config.oAuthUrl,
    username: config.username,
    password: config.password,
    defaultTenantId: conn.tenantId,
  };
}

/**
 * Convert Profile to ClusterConfig for API client use
 */
export function profileToClusterConfig(profile: Profile): ClusterConfig {
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

/**
 * Get display label for a connection
 */
export function getConnectionLabel(conn: Connection): string {
  if (conn.name) {
    return conn.name;
  }

  // Fallback to URL-based label like Modeler does
  const url = conn.targetType === TARGET_TYPES.CAMUNDA_CLOUD
    ? conn.camundaCloudClusterUrl
    : conn.contactPoint;

  return url ? `Unnamed (${url})` : 'Unnamed connection';
}

/**
 * Get auth type label for display
 */
export function getAuthTypeLabel(conn: Connection): string {
  if (conn.targetType === TARGET_TYPES.CAMUNDA_CLOUD) {
    return 'OAuth (Cloud)';
  }

  switch (conn.authType) {
    case AUTH_TYPES.BASIC:
      return 'Basic';
    case AUTH_TYPES.OAUTH:
      return 'OAuth';
    case AUTH_TYPES.NONE:
    default:
      return 'None';
  }
}

/**
 * Get target type label for display
 */
export function getTargetTypeLabel(conn: Connection): string {
  return conn.targetType === TARGET_TYPES.CAMUNDA_CLOUD
    ? 'Camunda Cloud'
    : 'Self-Hosted';
}

// ============================================================================
// Session State Management
// ============================================================================

/**
 * Load session state from disk and populate c8ctl runtime object
 */
export function loadSessionState(): SessionState {
  const path = getSessionStatePath();

  if (!existsSync(path)) {
    return {
      activeProfile: c8ctl.activeProfile,
      activeTenant: c8ctl.activeTenant,
      outputMode: c8ctl.outputMode,
    };
  }

  try {
    const data = readFileSync(path, 'utf-8');
    const state = JSON.parse(data) as SessionState;

    c8ctl.activeProfile = state.activeProfile === null ? undefined : state.activeProfile;
    c8ctl.activeTenant = state.activeTenant === null ? undefined : state.activeTenant;
    c8ctl.outputMode = state.outputMode || 'text';

    return {
      activeProfile: c8ctl.activeProfile,
      activeTenant: c8ctl.activeTenant,
      outputMode: c8ctl.outputMode,
    };
  } catch {
    return {
      activeProfile: c8ctl.activeProfile,
      activeTenant: c8ctl.activeTenant,
      outputMode: c8ctl.outputMode,
    };
  }
}

/**
 * Save session state from c8ctl runtime object to disk
 */
export function saveSessionState(state?: SessionState): void {
  const stateToSave: SessionState = {
    activeProfile: state?.activeProfile ?? c8ctl.activeProfile,
    activeTenant: state?.activeTenant ?? c8ctl.activeTenant,
    outputMode: state?.outputMode ?? c8ctl.outputMode,
  };

  if (state) {
    c8ctl.activeProfile = state.activeProfile;
    c8ctl.activeTenant = state.activeTenant;
    c8ctl.outputMode = state.outputMode;
  }

  const path = getSessionStatePath();
  writeFileSync(
    path,
    JSON.stringify(stateToSave, (_, value) => (value === undefined ? null : value), 2),
    'utf-8'
  );
}

/**
 * Set active profile/connection in session and persist to disk
 */
export function setActiveProfile(name: string): void {
  c8ctl.activeProfile = name;
  saveSessionState();
}

/**
 * Set active tenant in session and persist to disk
 */
export function setActiveTenant(tenantId: string): void {
  c8ctl.activeTenant = tenantId;
  saveSessionState();
}

/**
 * Set output mode in session and persist to disk
 */
export function setOutputMode(mode: OutputMode): void {
  c8ctl.outputMode = mode;
  saveSessionState();
}

// ============================================================================
// Cluster Configuration Resolution
// ============================================================================

/**
 * Resolve cluster configuration from session, flags, env vars, or defaults
 * Priority: profileFlag → session profile → env vars → localhost fallback
 */
export function resolveClusterConfig(profileFlag?: string): ClusterConfig {
  // 1. Try profile flag (profile name, including modeler: prefix)
  if (profileFlag) {
    const profile = getProfileOrModeler(profileFlag);
    if (profile) {
      return profileToClusterConfig(profile);
    }
  }

  // 2. Try session profile
  if (c8ctl.activeProfile) {
    const profile = getProfileOrModeler(c8ctl.activeProfile);
    if (profile) {
      return profileToClusterConfig(profile);
    }
  }

  // 3. Try environment variables
  const baseUrl = process.env.CAMUNDA_BASE_URL;
  const clientId = process.env.CAMUNDA_CLIENT_ID;
  const clientSecret = process.env.CAMUNDA_CLIENT_SECRET;
  const audience = process.env.CAMUNDA_TOKEN_AUDIENCE;
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
  return {
    baseUrl: 'http://localhost:8080/v2',
    username: 'demo',
    password: 'demo',
  };
}

/**
 * Resolve tenant ID from session, profile, env vars, or default
 * Priority: session tenant → profile tenant → env var → '<default>'
 */
export function resolveTenantId(profileFlag?: string): string {
  // 1. Try session tenant
  if (c8ctl.activeTenant) {
    return c8ctl.activeTenant;
  }

  // 2. Try profile default tenant (from flag or session)
  const profileName = profileFlag || c8ctl.activeProfile;
  if (profileName) {
    const profile = getProfileOrModeler(profileName);
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
