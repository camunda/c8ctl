// Public barrel for the `framework` layer.
//
// Other layers (commands, utils) and the composition root MUST import framework
// symbols through this barrel (`../framework/index.ts`), never from deep
// framework files. Intra-framework imports use direct sibling paths. Enforced by
// tests/unit/layering-import-boundary.test.ts (Rules A and B).
export * from "./command-framework.ts";
export * from "./command-registry.ts";
export * from "./command-validation.ts";
export * from "./plugins/plugin-loader.ts";
export * from "./plugins/plugin-registry.ts";
export * from "./plugins/plugin-version.ts";
export * from "./ui/completion.ts";
export * from "./ui/help.ts";
export * from "./ui/prompt.ts";
