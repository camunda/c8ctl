/**
 * Unit tests for the --verbose flag and centralized error handling
 */

import assert from "node:assert";
import { afterEach, beforeEach, describe, test } from "node:test";
import { handleCommandError } from "../../src/errors.ts";
import { isRecord, Logger } from "../../src/logger.ts";
import { c8ctl } from "../../src/runtime.ts";
import { mockProcessExit } from "../utils/mocks.ts";

describe("handleCommandError", () => {
	let errorSpy: string[];
	let infoSpy: string[];
	let originalErr: typeof console.error;
	let originalLog: typeof console.log;
	let restoreExit: () => void;
	let originalVerbose: typeof c8ctl.verbose;
	let originalOutputMode: typeof c8ctl.outputMode;
	let logger: Logger;

	beforeEach(() => {
		errorSpy = [];
		infoSpy = [];
		originalErr = console.error;
		originalLog = console.log;
		originalVerbose = c8ctl.verbose;
		originalOutputMode = c8ctl.outputMode;

		console.error = (...args: unknown[]) => {
			errorSpy.push(args.join(" "));
		};
		console.log = (...args: unknown[]) => {
			infoSpy.push(args.join(" "));
		};
		restoreExit = mockProcessExit((code) => {
			throw new Error(`process.exit(${code})`);
		});

		c8ctl.verbose = false;
		c8ctl.outputMode = "text";
		logger = new Logger();
	});

	afterEach(() => {
		console.error = originalErr;
		console.log = originalLog;
		restoreExit();
		c8ctl.verbose = originalVerbose;
		c8ctl.outputMode = originalOutputMode;
	});

	describe("non-verbose mode (default)", () => {
		test("logs user-friendly error message", () => {
			assert.throws(() => {
				handleCommandError(
					logger,
					"Failed to get topology",
					new Error("fetch failed"),
				);
			});
			assert.ok(
				errorSpy.some((line) => line.includes("Failed to get topology")),
			);
		});

		test("emits verbose hint message", () => {
			assert.throws(() => {
				handleCommandError(
					logger,
					"Failed to get topology",
					new Error("fetch failed"),
				);
			});
			const allOutput = [...errorSpy, ...infoSpy].join("\n");
			assert.ok(
				allOutput.includes("--verbose"),
				"Should include --verbose hint",
			);
		});

		test("emits additional hints when provided", () => {
			assert.throws(() => {
				handleCommandError(
					logger,
					"Failed to load plugin",
					new Error("network error"),
					["Check your network connection"],
				);
			});
			const allOutput = [...errorSpy, ...infoSpy].join("\n");
			assert.ok(allOutput.includes("Check your network connection"));
		});

		test("emits --verbose hint even with additional hints", () => {
			assert.throws(() => {
				handleCommandError(
					logger,
					"Failed to load plugin",
					new Error("network error"),
					["Check your network connection"],
				);
			});
			const allOutput = [...errorSpy, ...infoSpy].join("\n");
			assert.ok(allOutput.includes("--verbose"));
		});

		test("exits with code 1", () => {
			assert.throws(
				() =>
					handleCommandError(
						logger,
						"Failed to get topology",
						new Error("fetch failed"),
					),
				(err: Error) => err.message === "process.exit(1)",
			);
		});

		test("does not duplicate the prefix line when normalizeToError fell back to the caller message (text mode)", () => {
			// Class-of-defect guard: when a non-Error throw lacks RFC 9457
			// fields, `normalizeToError` synthesizes an Error whose message
			// is the caller's `message` argument. `Logger.error(message,
			// error)` would then print the same string twice — once as
			// the prefix line "✗ <message>" and once as the indented
			// "  <error.message>" line. `handleCommandError` must elide
			// the second pass.
			c8ctl.outputMode = "text";
			const messageLine = "Failed to do the thing";
			assert.throws(() => {
				// Non-Error throw with no actionable fields → normalizeToError
				// will fall back to `message`.
				handleCommandError(logger, messageLine, "opaque");
			});
			const occurrences = errorSpy.filter((line) =>
				line.includes(messageLine),
			).length;
			assert.strictEqual(
				occurrences,
				1,
				`expected the message to appear exactly once in stderr, got ${occurrences}. ` +
					`Output:\n${errorSpy.join("\n")}`,
			);
		});

		test("does not duplicate the message in JSON mode when normalizeToError fell back to the caller message", () => {
			// Same defect class as above, but in JSON output mode the
			// duplication shows up as both `message` and `error` fields
			// carrying identical strings. The `error` field should be
			// omitted in that case.
			c8ctl.outputMode = "json";
			const messageLine = "Failed to do the thing";
			assert.throws(() => {
				handleCommandError(logger, messageLine, "opaque");
			});
			const errorLine = errorSpy.find((line) => line.includes(messageLine));
			assert.ok(
				errorLine,
				`no error line emitted. Output:\n${errorSpy.join("\n")}`,
			);
			const parsed: unknown = JSON.parse(errorLine);
			assert.ok(
				isRecord(parsed) && "message" in parsed,
				"expected JSON output with a message field",
			);
			assert.ok(
				!("error" in parsed) || parsed.error !== messageLine,
				`JSON 'error' field must not duplicate 'message' when there is no extra detail. Output: ${errorLine}`,
			);
		});
	});

	describe("verbose mode (--verbose flag set)", () => {
		test("re-throws the original error instead of logging", () => {
			c8ctl.verbose = true;
			const originalError = new Error("fetch failed");

			assert.throws(
				() =>
					handleCommandError(logger, "Failed to get topology", originalError),
				(thrown) => thrown === originalError,
			);
		});

		test("does not emit the verbose hint when re-throwing", () => {
			c8ctl.verbose = true;
			try {
				handleCommandError(
					logger,
					"Failed to get topology",
					new Error("fetch failed"),
				);
			} catch {
				// expected
			}
			const allOutput = [...errorSpy, ...infoSpy].join("\n");
			assert.ok(
				!allOutput.includes("--verbose"),
				"Should not print --verbose hint in verbose mode",
			);
		});

		test("re-throws non-Error objects normalized as Error", () => {
			c8ctl.verbose = true;
			const originalError = {
				code: "ECONNREFUSED",
				message: "connection refused",
			};

			// `normalizeToError` (src/errors.ts) wraps non-Error throws in an
			// Error whose message is built from RFC 9457 problem-detail fields
			// (`title` / `detail` / `status`) when present, falling back to
			// the caller's message otherwise. The original is preserved as
			// `cause`. The previous behaviour (`new Error(String(error))` →
			// `Error: [object Object]`) lost all actionable information.
			assert.throws(
				() => handleCommandError(logger, "Failed to connect", originalError),
				(thrown) =>
					thrown instanceof Error &&
					thrown.message === "Failed to connect" &&
					thrown.cause === originalError,
			);
		});
	});
});

describe("c8ctl.verbose runtime property", () => {
	let originalVerbose: typeof c8ctl.verbose;

	beforeEach(() => {
		originalVerbose = c8ctl.verbose;
	});

	afterEach(() => {
		c8ctl.verbose = originalVerbose;
	});

	test("defaults to undefined", () => {
		c8ctl.verbose = undefined;
		assert.strictEqual(c8ctl.verbose, undefined);
	});

	test("can be set to true", () => {
		c8ctl.verbose = true;
		assert.strictEqual(c8ctl.verbose, true);
	});

	test("can be set to false", () => {
		c8ctl.verbose = false;
		assert.strictEqual(c8ctl.verbose, false);
	});
});
