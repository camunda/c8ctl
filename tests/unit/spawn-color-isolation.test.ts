/**
 * Guard for the test spawn helpers' color isolation.
 *
 * Regression context: a developer who exports `FORCE_COLOR` in their shell
 * used to break ~11 unit tests (bpmn-plugin, element-template). Those tests
 * spawn the CLI and match plain-text output (e.g. `/\swarning\s/`,
 * `^\s+ID\s+…`). With `FORCE_COLOR` inherited via `{ ...process.env }`,
 * `node:util`'s `styleText` wrapped the values in ANSI escapes and the
 * matches failed. CI never sets `FORCE_COLOR`, so it stayed green and the
 * failure only ever surfaced locally.
 *
 * The fix neutralises color-forcing variables at the spawn layer
 * (`resolveSpawnEnv` in tests/utils/spawn.ts) unless a caller explicitly opts
 * in with `color: true`. These tests pin that contract for the whole class of
 * spawn-based assertions, not just the original instances. The probe is a
 * tiny `node -e` script using `styleText` directly, so the guard does not
 * depend on any particular CLI command's formatting.
 */

import assert from "node:assert";
import { afterEach, beforeEach, describe, test } from "node:test";
import { asyncSpawn } from "../utils/spawn.ts";

// `node -e` probe: emit a styled string. styleText only adds ANSI escapes when
// the child stream reports color support, which is governed by the child's
// FORCE_COLOR / NO_COLOR environment.
const PROBE = [
	"-e",
	"const { styleText } = require('node:util');" +
		"process.stdout.write(styleText('red', 'PROBE'));",
];

// Build the ESC-sequence matcher from char codes so biome's
// noControlCharactersInRegex rule doesn't flag a literal control character.
const ansiRegex = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]+m`);

describe("spawn helpers: color isolation (regression guard)", () => {
	const saved = {
		FORCE_COLOR: process.env.FORCE_COLOR,
		CLICOLOR_FORCE: process.env.CLICOLOR_FORCE,
		CLICOLOR: process.env.CLICOLOR,
		NO_COLOR: process.env.NO_COLOR,
	};

	beforeEach(() => {
		// Simulate a developer shell that forces color on.
		process.env.FORCE_COLOR = "1";
		process.env.CLICOLOR_FORCE = "1";
		delete process.env.NO_COLOR;
	});

	afterEach(() => {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	});

	test("default spawn strips ambient FORCE_COLOR — output is plain", async () => {
		const result = await asyncSpawn("node", PROBE);
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assert.ok(
			!ansiRegex.test(result.stdout),
			`output should contain no ANSI escapes, got: ${JSON.stringify(result.stdout)}`,
		);
		assert.ok(
			result.stdout.includes("PROBE"),
			`output should still contain the plain text, got: ${JSON.stringify(result.stdout)}`,
		);
	});

	test("default spawn strips FORCE_COLOR even when caller spreads process.env", async () => {
		// This is the exact shape the previously-failing tests used.
		const result = await asyncSpawn("node", PROBE, { env: { ...process.env } });
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assert.ok(
			!ansiRegex.test(result.stdout),
			`output should contain no ANSI escapes, got: ${JSON.stringify(result.stdout)}`,
		);
	});

	test("color: true preserves caller's FORCE_COLOR — escapes are emitted", async () => {
		const result = await asyncSpawn("node", PROBE, {
			color: true,
			env: { ...process.env, FORCE_COLOR: "1" },
		});
		assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
		assert.ok(
			ansiRegex.test(result.stdout),
			`output should carry ANSI escapes when color is opted in, got: ${JSON.stringify(result.stdout)}`,
		);
	});
});
