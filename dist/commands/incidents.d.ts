/**
 * Incident commands
 */
/**
 * List incidents
 */
export declare function listIncidents(options: {
    profile?: string;
    state?: string;
    processInstanceKey?: string;
}): Promise<void>;
/**
 * Resolve incident
 */
export declare function resolveIncident(key: string, options: {
    profile?: string;
}): Promise<void>;
//# sourceMappingURL=incidents.d.ts.map