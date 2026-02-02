/**
 * Configuration and session state management for c8ctl
 * Uses Camunda Modeler's connection format for compatibility
 * Connections are stored in Modeler's config.json at connectionManagerPlugin.c8connections
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
 * Legacy Profile interface for backward compatibility during migration
 * @deprecated Use Connection interface instead
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
  URL: /^(http|grpc)s?:\/\//,
  CAMUNDA_CLOUD_GRPC_URL: /^((https|grpcs):\/\/|)[a-z\d-]+\.[a-z]+-\d+\.zeebe\.camunda\.io(:443|)\/?$/,
  CAMUNDA_CLOUD_REST_URL: /^https:\/\/[a-z]+-\d+\.zeebe\.camunda\.io(:443|)\/[a-z\d-]+\/?$/,
};

// Combined pattern for cloud URLs
const CAMUNDA_CLOUD_URL_PATTERN = new RegExp(
  `${VALIDATION_PATTERNS.CAMUNDA_CLOUD_GRPC_URL.source}|${VALIDATION_PATTERNS.CAMUNDA_CLOUD_REST_URL.source}`
);

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
      errors.push('Cluster URL must start with http://, https://, grpc://, or grpcs://');
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
      return join(process.env.XDG_DATA_HOME || join(home, '.local', 'share'), 'c8ctl');
  }
}

/**
 * Get platform-specific Camunda Modeler data directory
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

function getSessionStatePath(): string {
  return join(ensureUserDataDir(), 'session.json');
}

function getModelerConfigPath(): string {
  return join(getModelerDataDir(), 'settings.json');
}

// ============================================================================
// Connection Management - Modeler-compatible
// ============================================================================

const CONNECTIONS_KEY = 'connectionManagerPlugin.c8connections';

interface ModelerConfigFile {
  [key: string]: unknown;
}

/**
 * Load all connections from Modeler's config.json
 */
export function loadConnections(): Connection[] {
  const configPath = getModelerConfigPath();

  if (!existsSync(configPath)) {
    return [];
  }

  try {
    const data = readFileSync(configPath, 'utf-8');
    const config: ModelerConfigFile = JSON.parse(data);
    const connections = config[CONNECTIONS_KEY] as Connection[] | undefined;

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
 * Save connections to Modeler's config.json
 * Preserves other settings in the config file
 */
export function saveConnections(connections: Connection[]): void {
  const configPath = getModelerConfigPath();
  const modelerDir = getModelerDataDir();

  // Ensure modeler directory exists
  if (!existsSync(modelerDir)) {
    mkdirSync(modelerDir, { recursive: true });
  }

  let config: ModelerConfigFile = {};

  // Load existing config to preserve other settings
  if (existsSync(configPath)) {
    try {
      const data = readFileSync(configPath, 'utf-8');
      config = JSON.parse(data);
    } catch {
      // Start fresh if parsing fails
      config = {};
    }
  }

  config[CONNECTIONS_KEY] = connections;
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * Get a connection by ID or name
 */
export function getConnection(identifier: string): Connection | undefined {
  const connections = loadConnections();
  return connections.find(c => c.id === identifier || c.name === identifier);
}

/**
 * Add or update a connection
 */
export function saveConnection(connection: Connection): void {
  const connections = loadConnections();
  const existingIndex = connections.findIndex(c => c.id === connection.id);

  if (existingIndex >= 0) {
    connections[existingIndex] = connection;
  } else {
    connections.push(connection);
  }

  saveConnections(connections);
}

/**
 * Remove a connection by ID or name
 */
export function removeConnection(identifier: string): boolean {
  const connections = loadConnections();
  const filtered = connections.filter(c => c.id !== identifier && c.name !== identifier);

  if (filtered.length === connections.length) {
    return false;
  }

  saveConnections(filtered);
  return true;
}

/**
 * Generate a new connection with default values
 */
export function createConnection(name?: string): Connection {
  const connections = loadConnections();
  const connectionName = name || `New connection ${connections.length + 1}`;

  return {
    id: randomUUID(),
    name: connectionName,
    targetType: TARGET_TYPES.SELF_HOSTED,
    contactPoint: 'http://localhost:8080/v2',
    authType: AUTH_TYPES.NONE,
  };
}

/**
 * Create a default local connection (c8run style)
 */
export function createDefaultLocalConnection(): Connection {
  return {
    id: randomUUID(),
    name: 'c8run (local)',
    targetType: TARGET_TYPES.SELF_HOSTED,
    contactPoint: 'http://localhost:8080/v2',
    operateUrl: 'http://localhost:8080/operate',
    authType: AUTH_TYPES.NONE,
  };
}

// ============================================================================
// Conversion Utilities
// ============================================================================

/**
 * Convert a Connection to ClusterConfig for API client use
 */
export function connectionToClusterConfig(conn: Connection): ClusterConfig {
  if (conn.targetType === TARGET_TYPES.CAMUNDA_CLOUD) {
    return {
      baseUrl: conn.camundaCloudClusterUrl || '',
      clientId: conn.camundaCloudClientId,
      clientSecret: conn.camundaCloudClientSecret,
      audience: conn.camundaCloudClusterUrl, // Cloud uses URL as audience
      oAuthUrl: 'https://login.cloud.camunda.io/oauth/token',
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
 * Convert Connection to legacy Profile format
 * @deprecated Use Connection interface directly
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
  // 1. Try profile flag (connection ID or name)
  if (profileFlag) {
    const connection = getConnection(profileFlag);
    if (connection) {
      return connectionToClusterConfig(connection);
    }
  }

  // 2. Try session profile
  if (c8ctl.activeProfile) {
    const connection = getConnection(c8ctl.activeProfile);
    if (connection) {
      return connectionToClusterConfig(connection);
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
  return {
    baseUrl: 'http://localhost:8080/v2',
    username: 'demo',
    password: 'demo',
  };
}

/**
 * Resolve tenant ID from session, connection, env vars, or default
 * Priority: session tenant → connection tenant → env var → '<default>'
 */
export function resolveTenantId(profileFlag?: string): string {
  // 1. Try session tenant
  if (c8ctl.activeTenant) {
    return c8ctl.activeTenant;
  }

  // 2. Try connection default tenant (from flag or session)
  const connectionName = profileFlag || c8ctl.activeProfile;
  if (connectionName) {
    const connection = getConnection(connectionName);
    if (connection?.tenantId) {
      return connection.tenantId;
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

// ============================================================================
// Legacy API - Deprecated, for backward compatibility during migration
// ============================================================================

/**
 * @deprecated Use loadConnections() instead
 */
export function loadProfiles(): Profile[] {
  return loadConnections().map(connectionToProfile);
}

/**
 * @deprecated Use getConnection() instead
 */
export function getProfile(name: string): Profile | undefined {
  const connection = getConnection(name);
  return connection ? connectionToProfile(connection) : undefined;
}

/**
 * @deprecated Use saveConnection() instead
 */
export function addProfile(profile: Profile): void {
  // Convert profile to connection
  const isCloud = profile.baseUrl.includes('zeebe.camunda.io');

  const connection: Connection = {
    id: randomUUID(),
    name: profile.name,
    targetType: isCloud ? TARGET_TYPES.CAMUNDA_CLOUD : TARGET_TYPES.SELF_HOSTED,
    tenantId: profile.defaultTenantId,
  };

  if (isCloud) {
    connection.camundaCloudClusterUrl = profile.baseUrl;
    connection.camundaCloudClientId = profile.clientId;
    connection.camundaCloudClientSecret = profile.clientSecret;
  } else {
    connection.contactPoint = profile.baseUrl;

    if (profile.username && profile.password) {
      connection.authType = AUTH_TYPES.BASIC;
      connection.basicAuthUsername = profile.username;
      connection.basicAuthPassword = profile.password;
    } else if (profile.clientId && profile.clientSecret) {
      connection.authType = AUTH_TYPES.OAUTH;
      connection.clientId = profile.clientId;
      connection.clientSecret = profile.clientSecret;
      connection.oauthURL = profile.oAuthUrl;
      connection.audience = profile.audience;
    } else {
      connection.authType = AUTH_TYPES.NONE;
    }
  }

  saveConnection(connection);
}

/**
 * @deprecated Use removeConnection() instead
 */
export function removeProfile(name: string): boolean {
  return removeConnection(name);
}

/**
 * @deprecated Use saveConnections() instead
 */
export function saveProfiles(profiles: Profile[]): void {
  // This is lossy - only use for migration
  for (const profile of profiles) {
    addProfile(profile);
  }
}
