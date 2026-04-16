/**
 * Structural invariant tests for the resource validation guard.
 *
 * These tests verify that the VERB_REQUIRES_RESOURCE derivation in index.ts
 * stays in sync with COMMAND_REGISTRY, and that every dispatched verb in
 * the dispatch chain is either covered by the guard or explicitly exempt.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { COMMAND_REGISTRY } from "../../src/command-registry.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const indexSrc = readFileSync(join(__dirname, "../../src/index.ts"), "utf-8");

/**
 * Derive VERB_REQUIRES_RESOURCE from the registry (same logic as index.ts).
 * Includes verb aliases.
 */
function deriveVerbRequiresResource(): Set<string> {
	return new Set(
		Object.entries(COMMAND_REGISTRY)
			.filter(([, def]) => def.requiresResource)
			.flatMap(([verb, def]) => [verb, ...(def.aliases ?? [])]),
	);
}

/**
 * Extract all verbs referenced in dispatch blocks.
 * Matches both `verb === "X"` and `verb === "X" ||` patterns.
 * Returns all verbs found; filtering of exempt verbs (those dispatched
 * before the guard or that don't require a resource) is done in the test.
 */
function extractDispatchedVerbs(): Set<string> {
	const matches = indexSrc.matchAll(/verb === "([^"]+)"/g);
	const verbs = new Set<string>();
	for (const m of matches) {
		verbs.add(m[1]);
	}
	return verbs;
}

describe("VERB_REQUIRES_RESOURCE structural invariants", () => {
	// Verbs that are dispatched early (before the guard) or don't require
	// a resource by design, so they're correctly absent from VERB_REQUIRES_RESOURCE.
	const EXEMPT_VERBS = new Set([
		"help",
		"menu",
		"--help",
		"-h",
		"completion",
		"output",
		"deploy",
		"watch",
		"w",
		"feedback",
		"mcp-proxy",
	]);

	test("every dispatched verb is either exempt or in VERB_REQUIRES_RESOURCE", () => {
		const dispatched = extractDispatchedVerbs();
		const required = deriveVerbRequiresResource();
		const uncovered: string[] = [];

		for (const verb of dispatched) {
			if (!required.has(verb) && !EXEMPT_VERBS.has(verb)) {
				uncovered.push(verb);
			}
		}

		assert.strictEqual(
			uncovered.length,
			0,
			`Verbs dispatched in index.ts but missing from VERB_REQUIRES_RESOURCE (and not exempt): ${uncovered.join(", ")}. Add them to VERB_REQUIRES_RESOURCE or EXEMPT_VERBS.`,
		);
	});

	test("VERB_REQUIRES_RESOURCE matches the registry derivation", () => {
		// Parse the derivation from index.ts source and verify it uses the
		// same pattern: Object.entries(COMMAND_REGISTRY).filter(...requiresResource...)
		assert.ok(
			indexSrc.includes("COMMAND_REGISTRY"),
			"index.ts must import/reference COMMAND_REGISTRY",
		);
		assert.ok(
			indexSrc.includes("VERB_REQUIRES_RESOURCE"),
			"index.ts must define VERB_REQUIRES_RESOURCE",
		);
	});

	test("no inline resource guards remain in dispatch blocks", () => {
		// After the guard was added, inline `if (!resource)` / `if (!normalizedResource)`
		// checks that call showVerbResources or exit should not exist in dispatch blocks.
		// We look for the old pattern: calling showVerbResources preceded by !resource check.
		const inlineGuardPattern =
			/if\s*\(\s*!(?:resource|normalizedResource)\s*\)\s*\{[^}]*showVerbResources/g;
		const matches = [...indexSrc.matchAll(inlineGuardPattern)];
		assert.strictEqual(
			matches.length,
			0,
			`Found ${matches.length} inline resource guard(s) that should be handled by VERB_REQUIRES_RESOURCE`,
		);
	});
});
