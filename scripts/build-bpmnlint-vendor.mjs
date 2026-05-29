/**
 * Build the bpmnlint static-resolver vendor bundle.
 *
 * bpmnlint's default NodeResolver resolves rules and configs at runtime via
 * `require(<dynamic string>)` against the current working directory. That
 * cannot work in the published, self-contained CLI where `bpmnlint` and
 * `bpmnlint-plugin-camunda-compat` are no longer root dependencies.
 *
 * This script introspects the two installed packages, emits an entry that
 * builds a fully static StaticResolver cache (all bpmnlint recommended rules,
 * the recommended config, every camunda-compat rule, and every camunda-compat
 * config), and esbuilds it into a single CJS bundle. The bpmn plugin loads
 * this bundle via a relative require in both dev and prod (single code path).
 */

import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const recommended = require("bpmnlint/config/recommended");
const compat = require("bpmnlint-plugin-camunda-compat");

const bpmnlintRuleNames = Object.keys(recommended.rules);

// camunda-compat exposes most rules locally (`./rules/...`) but re-exports a
// few bpmnlint core rules under a `bpmnlint/<rule>` name. Map each to the
// StaticResolver cache key bpmnlint's Linter will ask for (pkg derived from
// the rule name) and the deep require that yields the factory.
const compatRules = Object.entries(compat.rules).map(([name, rel]) => {
	const path = String(rel);
	if (path.startsWith("./")) {
		return {
			cacheKey: `rule:bpmnlint-plugin-camunda-compat/${name}`,
			requireSpec: `bpmnlint-plugin-camunda-compat/${path.replace(/^\.\//, "")}`,
		};
	}
	// Non-local re-export, e.g. name/path "bpmnlint/start-event-required".
	const [pkg, ...ruleParts] = path.split("/");
	const ruleName = ruleParts.join("/");
	return {
		cacheKey: `rule:${pkg}/${ruleName}`,
		requireSpec: `${pkg}/rules/${ruleName}`,
	};
});

// Validate every rule referenced by a camunda-compat config is available, so
// the bundle can't silently miss a rule the linter will later ask for.
const compatRuleNames = new Set(Object.keys(compat.rules));
for (const [cfgName, cfg] of Object.entries(compat.configs)) {
	for (const ruleName of Object.keys(cfg.rules ?? {})) {
		if (!compatRuleNames.has(ruleName)) {
			throw new Error(
				`camunda-compat config '${cfgName}' references rule '${ruleName}' ` +
					"which is not in plugin.rules — static bundle would be incomplete.",
			);
		}
	}
}

const lines = [
	"const { Linter } = require('bpmnlint');",
	"const StaticResolver = require('bpmnlint/lib/resolver/static-resolver');",
	"const recommended = require('bpmnlint/config/recommended');",
	"const compat = require('bpmnlint-plugin-camunda-compat');",
	"",
	"const cache = {",
	"  'config:bpmnlint/recommended': recommended,",
	"};",
	"",
	...bpmnlintRuleNames.map(
		(name) =>
			`cache['rule:bpmnlint/${name}'] = require('bpmnlint/rules/${name}');`,
	),
	"",
	...compatRules.map(
		({ cacheKey, requireSpec }) =>
			`cache['${cacheKey}'] = require('${requireSpec}');`,
	),
	"",
	"for (const [name, cfg] of Object.entries(compat.configs)) {",
	"  cache['config:bpmnlint-plugin-camunda-compat/' + name] = cfg;",
	"}",
	"",
	"module.exports = {",
	"  Linter,",
	"  makeResolver: () => new StaticResolver(cache),",
	"  camundaCompatConfigNames: Object.keys(compat.configs),",
	"};",
	"",
];

await build({
	stdin: {
		contents: lines.join("\n"),
		resolveDir: root,
		sourcefile: "bpmnlint-vendor-entry.cjs",
		loader: "js",
	},
	bundle: true,
	format: "cjs",
	platform: "node",
	outfile: resolve(root, "dist/vendor/bpmnlint.cjs"),
	logLevel: "warning",
});

console.log(
	`build:vendor:bpmnlint — bundled ${bpmnlintRuleNames.length} bpmnlint rules + ` +
		`${compatRules.length} camunda-compat rules + ` +
		`${Object.keys(compat.configs).length} camunda-compat configs`,
);
