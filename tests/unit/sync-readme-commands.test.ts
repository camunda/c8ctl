/**
 * Tests for scripts/sync-readme-commands.ts
 *
 * Verifies that the README command reference generator correctly
 * derives documentation from COMMAND_REGISTRY.
 */

import assert from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
	END_MARKER,
	filterVerbSpecificFlags,
	formatFlag,
	generate,
	renderFlagsTable,
	renderPositionals,
	resourceDisplay,
	START_MARKER,
	uniqueAliases,
} from "../../scripts/sync-readme-commands.ts";
import type {
	CommandDef,
	FlagDef,
	PositionalDef,
} from "../../src/command-registry.ts";
import {
	COMMAND_REGISTRY,
	GLOBAL_FLAGS,
	SEARCH_FLAGS,
} from "../../src/command-registry.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, "../..");
const README_PATH = resolve(ROOT, "README.md");

/** Widened registry for iteration */
const REGISTRY: Readonly<Record<string, CommandDef>> = COMMAND_REGISTRY;

// ─── generate() structural tests ─────────────────────────────────────────────

describe("generate() output structure", () => {
	const output = generate();

	test("starts with Command Reference heading", () => {
		assert.ok(output.startsWith("## Command Reference"));
	});

	test("contains auto-generated notice", () => {
		assert.ok(output.includes("Auto-generated from"));
		assert.ok(output.includes("COMMAND_REGISTRY"));
	});

	test("contains Global Flags section", () => {
		assert.ok(output.includes("### Global Flags"));
	});

	test("contains Resource Aliases section", () => {
		assert.ok(output.includes("### Resource Aliases"));
	});

	test("contains Search Flags section", () => {
		assert.ok(output.includes("### Search Flags"));
	});

	test("contains Commands section", () => {
		assert.ok(output.includes("### Commands"));
	});
});

// ─── Every verb in the registry appears in generated output ──────────────────

describe("generate() includes all registry verbs", () => {
	const output = generate();

	for (const verb of Object.keys(REGISTRY)) {
		test(`verb "${verb}" appears as a heading`, () => {
			assert.ok(
				output.includes(`#### \`${verb}\``),
				`Missing heading for verb "${verb}"`,
			);
		});
	}
});

// ─── Every verb description appears ─────────────────────────────────────────

describe("generate() includes verb descriptions", () => {
	const output = generate();

	for (const [verb, def] of Object.entries(REGISTRY)) {
		test(`verb "${verb}" shows its description`, () => {
			const expected = def.helpDescription ?? def.description;
			assert.ok(
				output.includes(expected),
				`Missing description for "${verb}": expected "${expected}"`,
			);
		});
	}
});

// ─── Global flags all appear ─────────────────────────────────────────────────

describe("generate() includes all global flags", () => {
	const output = generate();

	for (const flagName of Object.keys(GLOBAL_FLAGS)) {
		test(`global flag "--${flagName}" appears`, () => {
			assert.ok(
				output.includes(`\`--${flagName}\``),
				`Missing global flag "--${flagName}"`,
			);
		});
	}
});

// ─── Search flags all appear ─────────────────────────────────────────────────

describe("generate() includes all search flags", () => {
	const output = generate();

	for (const flagName of Object.keys(SEARCH_FLAGS)) {
		test(`search flag "--${flagName}" appears`, () => {
			assert.ok(
				output.includes(`\`--${flagName}\``),
				`Missing search flag "--${flagName}"`,
			);
		});
	}
});

// ─── Resource aliases appear ─────────────────────────────────────────────────

describe("generate() includes resource aliases", () => {
	const output = generate();
	const aliases = uniqueAliases();

	for (const { alias, canonical } of aliases) {
		test(`alias "${alias}" → "${canonical}" appears`, () => {
			assert.ok(
				output.includes(`\`${alias}\``) && output.includes(`\`${canonical}\``),
				`Missing alias mapping "${alias}" → "${canonical}"`,
			);
		});
	}
});

// ─── Verbs with aliases show them ────────────────────────────────────────────

describe("generate() shows verb aliases", () => {
	const output = generate();

	for (const [verb, def] of Object.entries(REGISTRY)) {
		if (def.aliases && def.aliases.length > 0) {
			test(`verb "${verb}" lists aliases: ${def.aliases.join(", ")}`, () => {
				for (const alias of def.aliases ?? []) {
					assert.ok(
						output.includes(`\`${alias}\``),
						`Missing alias "${alias}" for verb "${verb}"`,
					);
				}
			});
		}
	}
});

// ─── Verbs with examples show them ───────────────────────────────────────────

describe("generate() includes help examples", () => {
	const output = generate();

	for (const [verb, def] of Object.entries(REGISTRY)) {
		if (def.helpExamples && def.helpExamples.length > 0) {
			test(`verb "${verb}" includes example commands`, () => {
				for (const ex of def.helpExamples ?? []) {
					assert.ok(
						output.includes(ex.command),
						`Missing example command "${ex.command}" for verb "${verb}"`,
					);
				}
			});
		}
	}
});

// ─── Verbs with positionals show them ────────────────────────────────────────

describe("generate() includes positional arguments", () => {
	const output = generate();

	for (const [verb, def] of Object.entries(REGISTRY)) {
		if (!def.resourcePositionals) continue;
		for (const [resource, positionals] of Object.entries(
			def.resourcePositionals,
		)) {
			// biome-ignore lint/plugin: positionals are readonly PositionalDef[] from the registry but typed as unknown via Object.entries
			const pos = positionals as readonly PositionalDef[];
			for (const p of pos) {
				test(`verb "${verb}" resource "${resource}" shows positional "<${p.name}>"`, () => {
					assert.ok(
						output.includes(`<${p.name}>`),
						`Missing positional "<${p.name}>" for ${verb}/${resource}`,
					);
				});
			}
		}
	}
});

// ─── Verbs with resource-specific flags show them ────────────────────────────

describe("generate() includes resource-specific flags", () => {
	const output = generate();

	for (const [verb, def] of Object.entries(REGISTRY)) {
		if (!def.resourceFlags) continue;
		for (const [resource, rFlags] of Object.entries(def.resourceFlags)) {
			// biome-ignore lint/plugin: rFlags are Record<string, FlagDef> from the registry but typed as unknown via Object.entries
			const flags = rFlags as Record<string, FlagDef>;
			if (Object.keys(flags).length === 0) continue;
			test(`verb "${verb}" shows resource "${resource}" flags section`, () => {
				assert.ok(
					output.includes(`<code>${resource}</code>`),
					`Missing resource flag section for "${resource}" in verb "${verb}"`,
				);
			});
		}
	}
});

// ─── filterVerbSpecificFlags ─────────────────────────────────────────────────

describe("filterVerbSpecificFlags()", () => {
	test("excludes global flags", () => {
		const mockDef = {
			description: "test",
			mutating: false,
			requiresResource: false,
			resources: [],
			flags: {
				help: { type: "boolean" as const, description: "Show help" },
				customFlag: {
					type: "string" as const,
					description: "Custom",
				},
			},
		} satisfies CommandDef;

		const result = filterVerbSpecificFlags(mockDef);
		assert.ok(!("help" in result), "help should be excluded (global flag)");
		assert.ok("customFlag" in result, "customFlag should be included");
	});

	test("excludes search flags", () => {
		const mockDef = {
			description: "test",
			mutating: false,
			requiresResource: false,
			resources: [],
			flags: {
				sortBy: {
					type: "string" as const,
					description: "Sort results",
				},
				myFlag: { type: "string" as const, description: "Mine" },
			},
		} satisfies CommandDef;

		const result = filterVerbSpecificFlags(mockDef);
		assert.ok(!("sortBy" in result), "sortBy should be excluded (search flag)");
		assert.ok("myFlag" in result, "myFlag should be included");
	});

	test("excludes flags already shown in resourceFlags", () => {
		const mockDef = {
			description: "test",
			mutating: false,
			requiresResource: true,
			resources: ["thing"],
			flags: {
				sharedFlag: {
					type: "string" as const,
					description: "Shared",
				},
				verbOnly: {
					type: "string" as const,
					description: "Verb only",
				},
			},
			resourceFlags: {
				thing: {
					sharedFlag: {
						type: "string" as const,
						description: "Shared",
					},
				},
			},
		} satisfies CommandDef;

		const result = filterVerbSpecificFlags(mockDef);
		assert.ok(
			!("sharedFlag" in result),
			"sharedFlag should be excluded (shown per-resource)",
		);
		assert.ok("verbOnly" in result, "verbOnly should be included");
	});
});

// ─── formatFlag() ────────────────────────────────────────────────────────────

describe("formatFlag()", () => {
	test("renders flag without short alias", () => {
		const result = formatFlag("verbose", {
			type: "boolean",
			description: "Verbose output",
		});
		assert.strictEqual(result, "`--verbose`");
	});

	test("renders flag with short alias", () => {
		const result = formatFlag("help", {
			type: "boolean",
			description: "Show help",
			short: "h",
		});
		assert.strictEqual(result, "`--help` / `-h`");
	});
});

// ─── renderFlagsTable() ─────────────────────────────────────────────────────

describe("renderFlagsTable()", () => {
	test("returns empty array for empty flags", () => {
		const result = renderFlagsTable({});
		assert.deepStrictEqual(result, []);
	});

	test("renders table header and rows", () => {
		const result = renderFlagsTable({
			name: {
				type: "string",
				description: "The name",
				required: true,
			},
			verbose: { type: "boolean", description: "Verbose mode" },
		});
		assert.strictEqual(result[0], "| Flag | Type | Required | Description |");
		assert.strictEqual(result[1], "|------|------|----------|-------------|");
		assert.ok(result[2]?.includes("Yes"));
		assert.ok(result[2]?.includes("The name"));
		assert.ok(result[3]?.includes("Verbose mode"));
		assert.ok(!result[3]?.includes("Yes"));
	});
});

// ─── renderPositionals() ────────────────────────────────────────────────────

describe("renderPositionals()", () => {
	test("renders required positional", () => {
		const result = renderPositionals([{ name: "key", required: true }]);
		assert.strictEqual(result, "`<key>` (required)");
	});

	test("renders optional positional", () => {
		const result = renderPositionals([{ name: "version" }]);
		assert.strictEqual(result, "`<version>` (optional)");
	});

	test("renders multiple positionals comma-separated", () => {
		const result = renderPositionals([
			{ name: "package", required: true },
			{ name: "version" },
		]);
		assert.strictEqual(
			result,
			"`<package>` (required), `<version>` (optional)",
		);
	});
});

// ─── resourceDisplay() ──────────────────────────────────────────────────────

describe("resourceDisplay()", () => {
	test("shows alias with canonical in parens for known aliases", () => {
		const result = resourceDisplay("pi");
		assert.strictEqual(result, "pi (process-instance)");
	});

	test("returns resource as-is when no alias exists", () => {
		const result = resourceDisplay("topology");
		assert.strictEqual(result, "topology");
	});
});

// ─── uniqueAliases() ────────────────────────────────────────────────────────

describe("uniqueAliases()", () => {
	test("returns sorted array", () => {
		const result = uniqueAliases();
		const canonicals = result.map((r) => r.canonical);
		const sorted = [...canonicals].sort();
		assert.deepStrictEqual(canonicals, sorted);
	});

	test("does not include long hyphenated aliases", () => {
		const result = uniqueAliases();
		for (const { alias } of result) {
			assert.ok(
				!alias.includes("-"),
				`Alias "${alias}" should not include hyphens (long form)`,
			);
		}
	});

	test("includes expected short aliases", () => {
		const result = uniqueAliases();
		const aliasNames = result.map((r) => r.alias);
		assert.ok(aliasNames.includes("pi"), "Should include pi alias");
		assert.ok(aliasNames.includes("pd"), "Should include pd alias");
		assert.ok(aliasNames.includes("ut"), "Should include ut alias");
		assert.ok(aliasNames.includes("inc"), "Should include inc alias");
	});
});

// ─── README markers exist ───────────────────────────────────────────────────

describe("README.md markers", () => {
	const readme = readFileSync(README_PATH, "utf-8");

	test("contains start marker", () => {
		assert.ok(
			readme.includes(START_MARKER),
			`README.md is missing ${START_MARKER}`,
		);
	});

	test("contains end marker", () => {
		assert.ok(
			readme.includes(END_MARKER),
			`README.md is missing ${END_MARKER}`,
		);
	});

	test("start marker appears before end marker", () => {
		const startIdx = readme.indexOf(START_MARKER);
		const endIdx = readme.indexOf(END_MARKER);
		assert.ok(startIdx < endIdx, "Start marker must appear before end marker");
	});
});

// ─── README is in sync (same assertion as --check mode) ──────────────────────

describe("README.md sync check", () => {
	test("generated content matches what is in README", () => {
		const readme = readFileSync(README_PATH, "utf-8");
		const startIdx = readme.indexOf(START_MARKER);
		const endIdx = readme.indexOf(END_MARKER);

		const generated = generate();
		const before = readme.slice(0, startIdx + START_MARKER.length);
		const after = readme.slice(endIdx);
		const expected = `${before}\n\n${generated}\n\n${after}`;

		assert.strictEqual(
			readme,
			expected,
			"README.md command reference is out of sync. Run: npm run sync:readme",
		);
	});
});

// ─── No verb in the registry is missing from the generated output ────────────

describe("generate() completeness guard", () => {
	const output = generate();
	const verbHeadings = [...output.matchAll(/^#### `(\S+)`$/gm)].map(
		(m) => m[1],
	);

	test("number of verb headings matches registry size", () => {
		const registrySize = Object.keys(REGISTRY).length;
		assert.strictEqual(
			verbHeadings.length,
			registrySize,
			`Generated ${verbHeadings.length} verb headings but registry has ${registrySize} verbs`,
		);
	});

	test("every registry verb has a matching heading", () => {
		for (const verb of Object.keys(REGISTRY)) {
			assert.ok(
				verbHeadings.includes(verb),
				`Verb "${verb}" is in the registry but missing from generated output`,
			);
		}
	});

	test("no extra headings beyond registry verbs", () => {
		const registryVerbs = new Set(Object.keys(REGISTRY));
		for (const heading of verbHeadings) {
			assert.ok(
				heading !== undefined && registryVerbs.has(heading),
				`Generated heading "${heading}" does not correspond to any registry verb`,
			);
		}
	});
});
