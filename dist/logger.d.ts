/**
 * Logger component for c8ctl CLI
 * Handles output in multiple modes (text, json) based on session state
 */
export type OutputMode = 'text' | 'json';
export declare class Logger {
    private _mode;
    private _debugEnabled;
    constructor(mode?: OutputMode);
    get mode(): OutputMode;
    set mode(mode: OutputMode);
    get debugEnabled(): boolean;
    set debugEnabled(enabled: boolean);
    info(message: string): void;
    debug(message: string, ...args: any[]): void;
    success(message: string, key?: string | number): void;
    error(message: string, error?: Error): void;
    table(data: any[]): void;
    json(data: any): void;
}
export declare function getLogger(mode?: OutputMode): Logger;
//# sourceMappingURL=logger.d.ts.map