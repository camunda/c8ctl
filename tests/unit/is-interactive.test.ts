/**
 * Unit tests for isInteractive() env-var precedence.
 *
 * isInteractive() is a pure function of process.env + TTY state.
 * Tests use env vars to exercise the priority logic. The actual
 * TTY state varies between CI (piped) and local terminals, so
 * assertions that depend on it use the runtime hasTTY value.
 */

import assert from "node:assert";
import { describe, test } from "node:test";
import { isInteractive } from "../../src/framework/index.ts";

const hasTTY = !!process.stdin.isTTY && !!process.stderr.isTTY;

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

	test("returns hasTTY when no env vars are set", () => {
		withEnv(clean, () => {
			assert.strictEqual(isInteractive(), hasTTY);
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

	test("C8CTL_INTERACTIVE=true returns hasTTY", () => {
		withEnv({ ...clean, C8CTL_INTERACTIVE: "true" }, () => {
			// Opt-in still requires actual TTY capability
			assert.strictEqual(isInteractive(), hasTTY);
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
