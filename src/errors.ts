/**
 * Centralized error handling for c8ctl command operations.
 *
 * When --verbose is set, errors are normalized via `normalizeToError`
 * (Errors pass through unchanged; non-Error throws like RFC 9457
 * problem-detail objects are wrapped in an `Error` whose message is
 * built from `title` / `detail` / `status` and whose `cause` retains
 * the original value) and then thrown so Node.js prints a meaningful
 * stack trace. When it is not set, a terse user-friendly message is
 * emitted and the process exits with a non-zero code, with a hint
 * about using --verbose.
 */

import type { Logger } from "./logger.ts";
import { isRecord } from "./logger.ts";
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
 * Normalize any thrown value into an `Error` instance, with care taken
 * to preserve actionable information from RFC 9457 problem-detail
 * objects (which the Camunda SDK throws as plain objects, not Errors).
 *
 * - If `error` is already an `Error`, it is returned unchanged.
 * - If `error` looks like an RFC 9457 problem detail (has any of
 *   `title` / `detail` / `status`), the synthesized Error message is
 *   built from those fields so it is meaningful to a user (instead of
 *   the useless `"[object Object]"` produced by `String(error)`).
 * - Otherwise the synthesized Error uses `fallbackMessage`.
 *
 * The original value is always preserved as `cause` so it remains
 * inspectable (e.g. under `--verbose` stack output).
 *
 * Class of defect this guards against: `new Error(String(error))` for
 * non-Error throws collapses problem-detail responses to
 * `Error: [object Object]`, losing every actionable field.
 */
export function normalizeToError(
	error: unknown,
	fallbackMessage = "Operation failed",
): Error {
	if (error instanceof Error) {
		return error;
	}
	const raw: Record<string, unknown> = isRecord(error) ? error : {};
	const title = typeof raw.title === "string" ? raw.title : undefined;
	const detail = typeof raw.detail === "string" ? raw.detail : undefined;
	const status = typeof raw.status === "number" ? raw.status : undefined;
	const head = [title ?? fallbackMessage, detail]
		.filter((p): p is string => Boolean(p))
		.join(": ");
	const message = status !== undefined ? `${head} (status ${status})` : head;
	return new Error(message, { cause: error });
}

/**
 * Handle a command error in a consistent way across the codebase.
 *
 * - In verbose mode (`--verbose`): the input is run through
 *   `normalizeToError` and the resulting `Error` is thrown so Node.js
 *   prints the full stack trace. For inputs that are already an
 *   `Error` this is a no-op (the same instance is thrown). For non-
 *   Error throws the thrown value is the synthesized normalized
 *   `Error`, which preserves the original value as `cause`. (Callers
 *   that need the exact original reference can read `.cause` from the
 *   thrown error.)
 * - In normal mode: a terse message is printed via the logger,
 *   followed by any optional additional hints, and then a hint to
 *   re-run with `--verbose`. The process exits with code 1. To avoid
 *   duplicated output when the normalized error has no actionable
 *   detail beyond `message` (e.g. for primitive throws), the second
 *   `error` argument to `logger.error` is omitted in that case so the
 *   user message appears exactly once.
 * - For `SilentError`: skip the default render entirely (the caller
 *   has already shown a user-facing error), and just exit non-zero
 *   (or rethrow in verbose mode — `SilentError` is an `Error`, so
 *   normalization is a no-op and the same instance is thrown).
 */
export function handleCommandError(
	logger: Logger,
	message: string,
	error: unknown,
	additionalHints?: string[],
): never {
	const normalizedError = normalizeToError(error, message);

	if (c8ctl.verbose) {
		throw normalizedError;
	}

	if (error instanceof SilentError) {
		// Caller already rendered a rich user-facing message. Don't
		// stack a "Failed to ...: <message>" + verbose-hint summary on
		// top — just exit non-zero.
		process.exit(1);
	}

	// Avoid duplicated output when `normalizeToError` had no actionable
	// fields to extract and fell back to the caller's `message`. In that
	// case `Logger.error(message, error)` would print the same string
	// twice (the prefix line "✗ <message>" followed by the indented
	// "  <error.message>" line, or both `message` and `error` fields in
	// JSON mode). Pass only `message` so the second line / `error` field
	// is omitted.
	if (normalizedError.message === message) {
		logger.error(message);
	} else {
		logger.error(message, normalizedError);
	}
	if (additionalHints) {
		for (const hint of additionalHints) {
			logger.info(hint);
		}
	}
	logger.info("For more details on the error, run with the --verbose flag");
	process.exit(1);
}
