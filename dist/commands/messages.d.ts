/**
 * Message commands
 */
/**
 * Publish message
 */
export declare function publishMessage(name: string, options: {
    profile?: string;
    correlationKey?: string;
    variables?: string;
    timeToLive?: number;
}): Promise<void>;
/**
 * Correlate message (same as publish in most cases)
 */
export declare function correlateMessage(name: string, options: {
    profile?: string;
    correlationKey?: string;
    variables?: string;
    timeToLive?: number;
}): Promise<void>;
//# sourceMappingURL=messages.d.ts.map