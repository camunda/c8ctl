/**
 * Process instance commands
 */
/**
 * List process instances
 */
export declare function listProcessInstances(options: {
    profile?: string;
    processDefinitionId?: string;
    state?: string;
    all?: boolean;
}): Promise<void>;
/**
 * Get process instance by key
 */
export declare function getProcessInstance(key: string, options: {
    profile?: string;
}): Promise<void>;
/**
 * Create process instance
 */
export declare function createProcessInstance(options: {
    profile?: string;
    processDefinitionId?: string;
    version?: number;
    variables?: string;
}): Promise<void>;
/**
 * Cancel process instance
 */
export declare function cancelProcessInstance(key: string, options: {
    profile?: string;
}): Promise<void>;
//# sourceMappingURL=process-instances.d.ts.map