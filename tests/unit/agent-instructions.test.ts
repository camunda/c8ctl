/**
 * Guard for the agent instruction chain.
 *
 * `CLAUDE.md` carries the one tenet that must always be in context and
 * imports `AGENTS.md`; the `steward` skill points at `AGENTS.md`; and
 * `AGENTS.md` remains the single source for the triage procedure. If any
 * link in that chain is removed or renamed, agents silently stop seeing
 * the rule, so this test fails instead.
 */

import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, test } from "node:test";

const PROJECT_ROOT = resolve(import.meta.dirname, "..", "..");

function read(relativePath: string): string {
	return readFileSync(join(PROJECT_ROOT, relativePath), "utf8");
}

describe("agent instruction chain", () => {
	test("CLAUDE.md imports AGENTS.md on its own line", () => {
		const lines = read("CLAUDE.md").split(/\r?\n/);
		assert.ok(
			lines.includes("@AGENTS.md"),
			"CLAUDE.md must contain a line that is exactly '@AGENTS.md'",
		);
	});

	test("CLAUDE.md states the no-flaky-tests tenet inline", () => {
		assert.ok(
			read("CLAUDE.md").includes("There are no flaky tests."),
			"CLAUDE.md must contain the sentence 'There are no flaky tests.'",
		);
	});

	test("steward skill exists, is named steward and points at AGENTS.md", () => {
		const skill = read(".claude/skills/steward/SKILL.md");
		const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skill);
		assert.ok(frontmatter, "SKILL.md must start with YAML frontmatter");
		assert.match(frontmatter[1], /^name:\s*steward\s*$/m);
		assert.ok(skill.includes("AGENTS.md"), "SKILL.md must reference AGENTS.md");
	});

	test("AGENTS.md keeps the no-flaky-tests heading", () => {
		assert.ok(
			read("AGENTS.md").includes("\n#### There are no flaky tests\n"),
			"AGENTS.md must keep the '#### There are no flaky tests' section",
		);
	});
});
