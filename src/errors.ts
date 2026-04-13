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
 * Handle a command error in a consistent way across the codebase.
 *
 * - In verbose mode (`--verbose`): the original error is re-thrown so Node.js
 *   prints the full stack trace.
 * - In normal mode: a terse message is printed via the logger, followed by any
 *   optional additional hints, and then a hint to re-run with `--verbose`.
 *   The process exits with code 1.
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

	logger.error(message, normalizedError);
	if (additionalHints) {
		for (const hint of additionalHints) {
			logger.info(hint);
		}
	}
	logger.info("For more details on the error, run with the --verbose flag");
	process.exit(1);
}
