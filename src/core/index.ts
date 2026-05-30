// Public barrel for the `core` layer.
//
// Other layers (commands, framework, utils) and the composition root MUST import
// core symbols through this barrel (`../core/index.ts`), never from deep core
// files. Intra-core imports use direct sibling paths. This contract is enforced
// by tests/unit/layering-import-boundary.test.ts (Rules A and B).
export * from "./client.ts";
export * from "./config.ts";
export * from "./errors.ts";
export * from "./logger.ts";
export * from "./runtime.ts";
export * from "./update-check.ts";
