/**
 * c8ctl runtime object with environment information
 */
interface C8ctlEnv {
    version: string;
    nodeVersion: string;
    platform: string;
    arch: string;
    cwd: string;
    rootDir: string;
}
interface C8ctlRuntime {
    env: C8ctlEnv;
}
/**
 * Create the c8ctl runtime object
 */
export declare const c8ctl: C8ctlRuntime;
export {};
//# sourceMappingURL=runtime.d.ts.map