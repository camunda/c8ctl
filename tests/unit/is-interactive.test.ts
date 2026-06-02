/**
 * Unit tests for isInteractive() env-var precedence.
 *
 * isInteractive() is a pure function of process.env + TTY state.
 * Since test subprocesses are never TTY, all tests here exercise the
 * env-var paths and verify the TTY gate.
 */

import assert from "node:assert";
import { describe, test } from "node:test";
import { isInteractive } from "../../src/framework/index.ts";

// In test subprocesses, stdin/stderr are NOT TTYs, so the baseline
// return value (no env overrides) is always false.

describe("isInteractive()", () => {
	// Save and restore env vars around each test
	function withEnv(
		vars: Record<string, string | undefined>,
		fn: () => void,
	): void {
		const saved: Record<string, string | undefined> = {};
		for (const key of Object.keys(vars)) {
			saved[key] = process.env[key];
			if (vars[key] === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = vars[key];
			}
		}
		try {
			fn();
		} finally {
			for (const key of Object.keys(saved)) {
				if (saved[key] === undefined) {
					delete process.env[key];
				} else {
					process.env[key] = saved[key];
				}
			}
		}
	}

	const clean = {
		C8CTL_INTERACTIVE: undefined,
		C8CTL_NON_INTERACTIVE: undefined,
		CI: undefined,
	};

	test("returns false when no env vars and no TTY", () => {
		withEnv(clean, () => {
			assert.strictEqual(isInteractive(), false);
		});
	});

	test("C8CTL_INTERACTIVE=false forces non-interactive", () => {
		withEnv({ ...clean, C8CTL_INTERACTIVE: "false" }, () => {
			assert.strictEqual(isInteractive(), false);
		});
	});

	test("C8CTL_INTERACTIVE=0 forces non-interactive", () => {
		withEnv({ ...clean, C8CTL_INTERACTIVE: "0" }, () => {
			assert.strictEqual(isInteractive(), false);
		});
	});

	test("C8CTL_INTERACTIVE=true still returns false without TTY", () => {
		withEnv({ ...clean, C8CTL_INTERACTIVE: "true" }, () => {
			// Even with explicit opt-in, no TTY means non-interactive
			assert.strictEqual(isInteractive(), false);
		});
	});

	test("C8CTL_NON_INTERACTIVE=1 forces non-interactive", () => {
		withEnv({ ...clean, C8CTL_NON_INTERACTIVE: "1" }, () => {
			assert.strictEqual(isInteractive(), false);
		});
	});

	test("C8CTL_NON_INTERACTIVE=true forces non-interactive", () => {
		withEnv({ ...clean, C8CTL_NON_INTERACTIVE: "true" }, () => {
			assert.strictEqual(isInteractive(), false);
		});
	});

	test("CI=true forces non-interactive", () => {
		withEnv({ ...clean, CI: "true" }, () => {
			assert.strictEqual(isInteractive(), false);
		});
	});

	test("CI=1 forces non-interactive", () => {
		withEnv({ ...clean, CI: "1" }, () => {
			assert.strictEqual(isInteractive(), false);
		});
	});

	test("any non-empty CI value forces non-interactive", () => {
		withEnv({ ...clean, CI: "yes" }, () => {
			assert.strictEqual(isInteractive(), false);
		});
	});

	test("C8CTL_INTERACTIVE=false takes precedence over CI=true", () => {
		withEnv({ ...clean, C8CTL_INTERACTIVE: "false", CI: "true" }, () => {
			assert.strictEqual(isInteractive(), false);
		});
	});

	test("C8CTL_INTERACTIVE=false takes precedence over C8CTL_NON_INTERACTIVE", () => {
		withEnv(
			{ ...clean, C8CTL_INTERACTIVE: "false", C8CTL_NON_INTERACTIVE: "0" },
			() => {
				assert.strictEqual(isInteractive(), false);
			},
		);
	});

	test("case insensitive env values", () => {
		withEnv({ ...clean, C8CTL_INTERACTIVE: "FALSE" }, () => {
			assert.strictEqual(isInteractive(), false);
		});
		withEnv({ ...clean, CI: "TRUE" }, () => {
			assert.strictEqual(isInteractive(), false);
		});
	});
});
