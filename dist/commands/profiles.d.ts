/**
 * Profile management commands
 */
/**
 * List all profiles
 */
export declare function listProfiles(): void;
/**
 * Add a profile
 */
export declare function addProfile(name: string, options: {
    baseUrl?: string;
    clientId?: string;
    clientSecret?: string;
    audience?: string;
    oAuthUrl?: string;
    defaultTenantId?: string;
}): void;
/**
 * Remove a profile
 */
export declare function removeProfile(name: string): void;
//# sourceMappingURL=profiles.d.ts.map