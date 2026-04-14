/**
 * CLI boundary validation utilities.
 *
 * These functions validate raw CLI string inputs and narrow them to
 * SDK types. They exit with code 1 on invalid input, so callers
 * receive only valid, typed values.
 *
 * This module is the single chokepoint for input validation — command
 * handlers receive already-validated types and need no internal guards.
 */

import {
	type FlagDef,
	GLOBAL_FLAGS,
	getCommandDef,
} from "./command-registry.ts";
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

	if (items.length === 0) {
		getLogger().error(`--${flagName} is required`);
		process.exit(1);
	}

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

/**
 * Run all registered validators for provided flag values.
 *
 * For each flag that has a `validate` function on its FlagDef,
 * calls the validator with the raw string value. On failure,
 * logs the error and exits with code 1.
 *
 * Returns a map of flag name → validated value for flags that
 * had validators. Flags without validators are not included.
 */
export function validateFlags(
	values: Record<string, string | boolean | (string | boolean)[] | undefined>,
	flagDefs: Record<string, FlagDef>,
): Map<string, unknown> {
	const validated = new Map<string, unknown>();
	const logger = getLogger();

	for (const [flagName, def] of Object.entries(flagDefs)) {
		if (!def.validate) continue;

		const raw = values[flagName];
		if (raw === undefined || typeof raw !== "string") continue;

		try {
			validated.set(flagName, def.validate(raw));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.error(`Invalid --${flagName}: ${message}`);
			process.exit(1);
		}
	}

	return validated;
}

/** Flag names that are always valid regardless of verb or resource. */
const GLOBAL_FLAG_NAMES = new Set(Object.keys(GLOBAL_FLAGS));

/**
 * Detect flags the user provided that are not recognised for the given
 * verb (and, for verbs with resourceFlags, the specific resource).
 *
 * For verbs with resourceFlags (when a resource is provided): valid flags are
 *   GLOBAL_FLAGS ∪ shared verb flags ∪ resourceFlags[resource]
 *
 * Shared verb flags are derived automatically: verb-level flags that do NOT
 * appear in any resourceFlags entry (e.g. limit/sort for search, but not
 * resource-specific filter flags).
 *
 * For all other verbs: valid flags are
 *   GLOBAL_FLAGS ∪ verb flags
 *
 * Returns an empty array when the verb is not in the registry
 * (unknown verbs fall through to the plugin system).
 */
export function detectUnknownFlags(
	verb: string,
	resource: string,
	values: Record<string, unknown>,
): string[] {
	const commandDef = getCommandDef(verb);
	if (!commandDef) return [];

	const validFlags = new Set(GLOBAL_FLAG_NAMES);

	if (commandDef.resourceFlags && resource) {
		// Collect all resource-specific flag names
		const allResourceFlagNames = new Set<string>();
		for (const rFlags of Object.values(commandDef.resourceFlags)) {
			for (const f of Object.keys(rFlags)) allResourceFlagNames.add(f);
		}

		// Shared verb flags = verb-level flags NOT in any resource entry
		for (const f of Object.keys(commandDef.flags)) {
			if (!allResourceFlagNames.has(f)) validFlags.add(f);
		}

		// Resource-specific flags
		const perResource =
			commandDef.resourceFlags[resource] ||
			commandDef.resourceFlags[resource.replace(/s$/, "")];
		if (perResource) {
			for (const f of Object.keys(perResource)) validFlags.add(f);
		}
	} else {
		for (const f of Object.keys(commandDef.flags)) {
			validFlags.add(f);
		}
	}

	const unknown: string[] = [];
	for (const [key, val] of Object.entries(values)) {
		if (val === undefined || val === false) continue;
		if (validFlags.has(key)) continue;
		unknown.push(key);
	}
	return unknown;
}
