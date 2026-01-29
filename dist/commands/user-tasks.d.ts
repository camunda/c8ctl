/**
 * User task commands
 */
/**
 * List user tasks
 */
export declare function listUserTasks(options: {
    profile?: string;
    state?: string;
    assignee?: string;
    all?: boolean;
}): Promise<void>;
/**
 * Complete user task
 */
export declare function completeUserTask(key: string, options: {
    profile?: string;
    variables?: string;
}): Promise<void>;
//# sourceMappingURL=user-tasks.d.ts.map