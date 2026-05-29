/**
 * Bundle the TypeScript default plugins into self-contained ESM modules.
 *
 * Each default plugin declares its own runtime dependencies in its
 * package.json (resolved at dev/build time via npm workspaces). The published
 * CLI must not depend on those packages being installed, so this script
 * esbuild-bundles each plugin's `c8ctl-plugin.ts` entry — inlining its npm
 * dependencies — into `dist/default-plugins/<name>/c8ctl-plugin.js`.
 *
 * The prebuilt vendor bundles (bpmn-element-templates.cjs, bpmnlint.cjs) are
 * loaded at runtime via a dynamic, path-computed `require()`, which esbuild
 * leaves external automatically. JS-only plugins with no dependencies (e.g.
 * `cluster`) need no bundling and are copied verbatim by `copy-plugins`.
 */

import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginsDir = join(root, "default-plugins");

const tsPlugins = readdirSync(pluginsDir).filter((name) =>
	existsSync(join(pluginsDir, name, "c8ctl-plugin.ts")),
);

for (const name of tsPlugins) {
	await build({
		entryPoints: [join(pluginsDir, name, "c8ctl-plugin.ts")],
		outfile: join(root, "dist", "default-plugins", name, "c8ctl-plugin.js"),
		bundle: true,
		format: "esm",
		platform: "node",
		target: "node22",
		logLevel: "warning",
	});
	console.log(`build:plugins — bundled default-plugins/${name}`);
}
