/**
 * Post-install script: run `npm install` inside each default-plugin directory
 * that declares its own `dependencies`.
 *
 * This runs automatically after both:
 *   npm install          (development, source tree — plugins in default-plugins/)
 *   npm install -g @camunda8/cli  (global install — plugins in dist/default-plugins/)
 *
 * Each plugin owns its runtime deps exclusively in its own package.json.
 * This script is what causes those deps to actually be installed alongside c8ctl.
 */

import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// In development the source tree has default-plugins/ at the project root.
// After `npm install -g @camunda8/cli`, only dist/ is shipped, so look there.
const pluginsBase = existsSync("default-plugins")
	? "default-plugins"
	: join("dist", "default-plugins");

if (!existsSync(pluginsBase)) {
	process.exit(0);
}

for (const name of readdirSync(pluginsBase).sort()) {
	const pkgPath = join(pluginsBase, name, "package.json");
	if (!existsSync(pkgPath)) {
		continue;
	}

	let pkg;
	try {
		pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
	} catch {
		continue;
	}

	if (!pkg.dependencies || Object.keys(pkg.dependencies).length === 0) {
		continue;
	}

	const pluginDir = join(pluginsBase, name);
	console.log(`  installing deps for default plugin: ${name}`);
	execSync("npm install --no-package-lock", {
		cwd: pluginDir,
		stdio: "inherit",
	});
}
