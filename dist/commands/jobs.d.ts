/**
 * Job commands
 */
/**
 * List jobs
 */
export declare function listJobs(options: {
    profile?: string;
    state?: string;
    type?: string;
}): Promise<void>;
/**
 * Activate jobs
 */
export declare function activateJobs(type: string, options: {
    profile?: string;
    maxJobsToActivate?: number;
    timeout?: number;
    worker?: string;
}): Promise<void>;
/**
 * Complete job
 */
export declare function completeJob(key: string, options: {
    profile?: string;
    variables?: string;
}): Promise<void>;
/**
 * Fail job
 */
export declare function failJob(key: string, options: {
    profile?: string;
    retries?: number;
    errorMessage?: string;
}): Promise<void>;
//# sourceMappingURL=jobs.d.ts.map