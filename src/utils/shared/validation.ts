/**
 * Generic CLI input validators with no dependency on the command registry.
 *
 * These narrow raw CLI strings to validated values and exit with code 1 on
 * invalid input. They live in `utils/` (leaf layer, core-only deps) so that
 * non-command modules — e.g. `utils/command-local/open-helpers.ts` — can reuse
 * them without importing the `framework/` layer.
 */

import { getLogger } from "../../core/index.ts";

/**
 * Validate that a positional argument is present and non-empty.
 * Unlike requireOption (for --flags), this uses a descriptive label
 * in the error message.
 * Exits with code 1 if missing.
 */
export function requirePositional(
	value: string | undefined,
	label: string,
	hint?: string,
): string {
	if (!value) {
		const logger = getLogger();
		logger.error(`${label} is required`);
		if (hint) logger.info(hint);
		process.exit(1);
	}
	return value;
}

/**
 * Validate that a string value is one of an allowed set.
 * Works with readonly tuples (e.g. `OPEN_APPS as const`).
 * Uses .find() so TypeScript narrows to T with no cast.
 * Exits with code 1 if invalid, listing valid values.
 */
export function requireOneOf<T extends string>(
	value: string,
	allowed: readonly T[],
	label: string,
	hint?: string,
): T {
	const match = allowed.find((v) => v === value);
	if (match === undefined) {
		const logger = getLogger();
		logger.error(
			`Unknown ${label} '${value}'. Available: ${allowed.join(", ")}`,
		);
		if (hint) logger.info(hint);
		process.exit(1);
	}
	return match;
}
