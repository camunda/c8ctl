/**
 * Configuration and session state management for c8ctl
 * Handles profiles, session state, and credential resolution
 */

import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import type { OutputMode } from './logger.ts';

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
 * Get platform-specific user data directory
 */
export function getUserDataDir(): string {
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
 */
export function getProfile(name: string): Profile | undefined {
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
 * Load session state
 */
export function loadSessionState(): SessionState {
  const path = getSessionStatePath();
  if (!existsSync(path)) {
    return { outputMode: 'text' };
  }
  try {
    const data = readFileSync(path, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    return { outputMode: 'text' };
  }
}

/**
 * Save session state to disk
 */
export function saveSessionState(state: SessionState): void {
  const path = getSessionStatePath();
  writeFileSync(path, JSON.stringify(state, null, 2), 'utf-8');
}

/**
 * Set active profile in session
 */
export function setActiveProfile(name: string): void {
  const state = loadSessionState();
  state.activeProfile = name;
  saveSessionState(state);
}

/**
 * Set active tenant in session
 */
export function setActiveTenant(tenantId: string): void {
  const state = loadSessionState();
  state.activeTenant = tenantId;
  saveSessionState(state);
}

/**
 * Set output mode in session
 */
export function setOutputMode(mode: OutputMode): void {
  const state = loadSessionState();
  state.outputMode = mode;
  saveSessionState(state);
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
  const session = loadSessionState();
  if (session.activeProfile) {
    const profile = getProfile(session.activeProfile);
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
  const session = loadSessionState();
  if (session.activeTenant) {
    return session.activeTenant;
  }

  // 2. Try profile default tenant (from flag or session)
  const profileName = profileFlag || session.activeProfile;
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
