/**
 * Configuration and session state management for c8ctl
 * Handles profiles, session state, and credential resolution
 */
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
export declare function getUserDataDir(): string;
/**
 * Load all profiles
 */
export declare function loadProfiles(): Profile[];
/**
 * Save profiles to disk
 */
export declare function saveProfiles(profiles: Profile[]): void;
/**
 * Get a profile by name
 */
export declare function getProfile(name: string): Profile | undefined;
/**
 * Add or update a profile
 */
export declare function addProfile(profile: Profile): void;
/**
 * Remove a profile
 */
export declare function removeProfile(name: string): boolean;
/**
 * Load session state
 */
export declare function loadSessionState(): SessionState;
/**
 * Save session state to disk
 */
export declare function saveSessionState(state: SessionState): void;
/**
 * Set active profile in session
 */
export declare function setActiveProfile(name: string): void;
/**
 * Set active tenant in session
 */
export declare function setActiveTenant(tenantId: string): void;
/**
 * Set output mode in session
 */
export declare function setOutputMode(mode: OutputMode): void;
/**
 * Resolve cluster configuration from session, flags, env vars, or defaults
 * Priority: profileFlag → session profile → env vars → localhost fallback
 */
export declare function resolveClusterConfig(profileFlag?: string): ClusterConfig;
/**
 * Resolve tenant ID from session, profile, env vars, or default
 * Priority: session tenant → profile default tenant → env var → '<default>'
 */
export declare function resolveTenantId(profileFlag?: string): string;
//# sourceMappingURL=config.d.ts.map