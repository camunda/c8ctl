/**
 * CLI boundary validation utilities.
 *
 * These functions validate raw CLI string inputs and narrow them to
 * SDK types. They exit with code 1 on invalid input, so callers
 * receive only valid, typed values.
 *
 * This module is the single chokepoint for input validation — command
 * handlers receive already-validated types and need no internal guards.
 *
 * Extension points for future issues:
 * - #212: add validateAcceptedFlags(values, accepted, verb, resource)
 * - #213: add requireResource(verb, resource, verbResourceMap)
 */

import { getLogger } from "./logger.ts";

/**
 * Validate that a required CLI option is present and non-empty.
 * Exits with code 1 if missing.
 */
export function requireOption(
	value: string | undefined,
	flagName: string,
): string {
	if (!value) {
		getLogger().error(`--${flagName} is required`);
		process.exit(1);
	}
	return value;
}

/**
 * Validate that a string value is a valid member of an SDK enum.
 * Uses Object.values().find() so TypeScript narrows to T with no cast.
 * Exits with code 1 if invalid, listing valid values.
 */
export function requireEnum<T extends string>(
	value: string,
	enumValues: Record<string, T>,
	flagName: string,
): T {
	const validValues = Object.values(enumValues);
	const match = validValues.find((v) => v === value);
	if (match === undefined) {
		getLogger().error(
			`Invalid --${flagName} "${value}". Valid values: ${validValues.join(", ")}`,
		);
		process.exit(1);
	}
	return match;
}

/**
 * Validate a comma-separated string where each element must be a
 * valid member of an SDK enum. Splits on commas, trims whitespace,
 * and filters empty strings before validation.
 * Exits with code 1 if any element is invalid.
 */
export function requireCsvEnum<T extends string>(
	value: string,
	enumValues: Record<string, T>,
	flagName: string,
): T[] {
	const validValues = Object.values(enumValues);
	const items = value
		.split(",")
		.map((p) => p.trim())
		.filter((p) => p.length > 0);

	const result: T[] = [];
	const invalid: string[] = [];
	for (const item of items) {
		const match = validValues.find((v) => v === item);
		if (match !== undefined) {
			result.push(match);
		} else {
			invalid.push(item);
		}
	}

	if (invalid.length > 0) {
		getLogger().error(
			`Invalid --${flagName}: ${invalid.join(", ")}. Valid values: ${validValues.join(", ")}`,
		);
		process.exit(1);
	}

	return result;
}
