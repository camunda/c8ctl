/**
 * Centralized error handling for c8ctl command operations.
 *
 * When --verbose is set, errors are re-thrown so the full stack trace is
 * visible. When it is not set, a terse user-friendly message is emitted and
 * the process exits with a non-zero code, with a hint about using --verbose.
 */

import type { Logger } from "./logger.ts";
import { c8ctl } from "./runtime.ts";

/**
 * Marker error: the caller has already rendered a rich, user-facing
 * error message (e.g. multi-line context, hints, formatted detail) and
 * just needs the framework to exit non-zero. `handleCommandError` skips
 * its default `logger.error(...)` + verbose-hint render for these,
 * avoiding duplicate "Failed to <verb>: <message>" summary lines on
 * top of the rich pre-rendered output.
 *
 * Use this only when the helper has already produced a complete,
 * user-actionable failure message. For ordinary errors that just need
 * to bubble up, throw a plain `Error` and let the framework format it.
 */
export class SilentError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SilentError";
	}
}

/**
 * Handle a command error in a consistent way across the codebase.
 *
 * - In verbose mode (`--verbose`): the original error is re-thrown so Node.js
 *   prints the full stack trace.
 * - In normal mode: a terse message is printed via the logger, followed by any
 *   optional additional hints, and then a hint to re-run with `--verbose`.
 *   The process exits with code 1.
 * - For `SilentError`: skip the default render entirely (the caller has
 *   already shown a user-facing error), and just exit non-zero (or
 *   rethrow in verbose mode).
 */
export function handleCommandError(
	logger: Logger,
	message: string,
	error: unknown,
	additionalHints?: string[],
): never {
	const normalizedError =
		error instanceof Error ? error : new Error(String(error));

	if (c8ctl.verbose) {
		throw normalizedError;
	}

	if (error instanceof SilentError) {
		// Caller already rendered a rich user-facing message. Don't
		// stack a "Failed to ...: <message>" + verbose-hint summary on
		// top — just exit non-zero.
		process.exit(1);
	}

	logger.error(message, normalizedError);
	if (additionalHints) {
		for (const hint of additionalHints) {
			logger.info(hint);
		}
	}
	logger.info("For more details on the error, run with the --verbose flag");
	process.exit(1);
}
