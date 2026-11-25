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
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginsDir = join(root, "default-plugins");

const tsPlugins = readdirSync(pluginsDir).filter((name) =>
	existsSync(join(pluginsDir, name, "c8ctl-plugin.ts")),
);

/**
 * Load c8ctl's own modules (`src/`) from what tsc emits to `dist/` instead
 * of inlining a copy. Default plugins ship inside the package, so a plugin
 * calls the core's services and shares its `C8ctlError`; the cluster
 * client stays out of the bundles.
 */
function srcFromDist(outfile) {
	const srcDir = join(root, "src");
	return {
		name: "c8ctl-src-from-dist",
		setup(build) {
			build.onResolve({ filter: /^\.\.?\// }, (args) => {
				const target = resolve(args.resolveDir, args.path);
				if (!target.startsWith(srcDir + sep)) return undefined;
				const emitted = join(root, "dist", relative(srcDir, target)).replace(
					/\.ts$/,
					".js",
				);
				const path = relative(dirname(outfile), emitted).split(sep).join("/");
				return { path, external: true };
			});
		},
	};
}

for (const name of tsPlugins) {
	const outfile = join(root, "dist", "default-plugins", name, "c8ctl-plugin.js");
	await build({
		entryPoints: [join(pluginsDir, name, "c8ctl-plugin.ts")],
		outfile,
		bundle: true,
		format: "esm",
		platform: "node",
		target: "node22",
		// Prefer each dependency's ESM build: a bundled UMD/CJS entry (e.g.
		// jsonc-parser's) keeps runtime require() calls that fail inside an
		// ESM bundle.
		mainFields: ["module", "main"],
		plugins: [srcFromDist(outfile)],
		logLevel: "warning",
	});
	console.log(`build:plugins — bundled default-plugins/${name}`);
}
