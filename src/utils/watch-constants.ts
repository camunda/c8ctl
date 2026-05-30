/**
 * Constants extracted from `src/commands/watch.ts` so tests can import
 * them without violating the test→commands import boundary (#291).
 */

/** Cooldown (ms) between successive file-watch deploys for the same resource. */
export const DEPLOY_COOLDOWN = 1000;
