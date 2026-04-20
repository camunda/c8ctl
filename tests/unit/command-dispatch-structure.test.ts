/**
 * Structural test: every value in COMMAND_DISPATCH must be produced by
 * `defineCommand(...)` (issue #290).
 *
 * COMMAND_DISPATCH is the seam between argument parsing and business logic.
 * Hand-rolled handlers can drift past the framework — skipping flag
 * deserialization, dry-run handling, result rendering, and the
 * `handleCommandError` wrapper. This test enforces that every dispatch entry
 * carries the `DEFINE_COMMAND_MARKER` brand stamped by `defineCommand`.
 *
 * It catches drift in both directions:
 *   1. An existing handler being downgraded to a hand-rolled function.
 *   2. A new handler being added to the dispatch map without going through
 *      `defineCommand` (e.g. plugin handlers, forgotten migrations).
 */

import assert from "node:assert";
import { describe, test } from "node:test";

import { COMMAND_DISPATCH } from "../../src/command-dispatch.ts";
import { isDefinedCommand } from "../../src/command-framework.ts";

describe("COMMAND_DISPATCH structural invariant (#290)", () => {
	test("every dispatch entry is produced by defineCommand()", () => {
		const offenders: string[] = [];

		for (const [key, handler] of COMMAND_DISPATCH) {
			if (!isDefinedCommand(handler)) {
				offenders.push(key);
			}
		}

		assert.deepStrictEqual(
			offenders,
			[],
			[
				"COMMAND_DISPATCH contains entries that were not produced by `defineCommand(...)`:",
				...offenders.map((k) => `  - ${k}`),
				"",
				"Wrap each offending handler with `defineCommand(verb, resource, handler)`",
				"so it goes through the framework's flag deserialization, dry-run handling,",
				"result rendering, and `handleCommandError` wrapper.",
				"",
				"See src/command-framework.ts and existing handlers in src/commands/ for examples.",
			].join("\n"),
		);
	});

	test("dispatch map is non-empty (sanity)", () => {
		assert.ok(
			COMMAND_DISPATCH.size > 0,
			"COMMAND_DISPATCH is empty — the structural test would trivially pass",
		);
	});

	test("isDefinedCommand rejects hand-rolled handlers (detector self-test)", () => {
		// A hand-rolled object with the same shape as CommandHandler but no
		// `DEFINE_COMMAND_MARKER` brand — exactly the drift this test guards
		// against. If `isDefinedCommand` ever returns true for this, the
		// structural assertion above becomes a no-op.
		const handRolled = {
			verb: "list",
			resource: "process-instance",
			execute: async () => {},
		};
		assert.strictEqual(isDefinedCommand(handRolled), false);
		assert.strictEqual(isDefinedCommand(null), false);
		assert.strictEqual(isDefinedCommand(undefined), false);
		assert.strictEqual(
			isDefinedCommand(() => {}),
			false,
		);
	});
});
