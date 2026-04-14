/**
 * Type-safe command definition framework.
 *
 * Provides `defineCommand()` — a builder that infers handler parameter types
 * from the flag schema, ensuring handlers receive branded SDK types without
 * any `as` casts. Works with the `as const satisfies` flag sets from
 * command-registry.ts.
 *
 * Phase 2 of #230.
 */

import type { CamundaClient } from "@camunda8/orchestration-cluster-api";

import type { FlagDef } from "./command-registry.ts";
import type { Logger, SortOrder } from "./logger.ts";

// ─── InferFlags ──────────────────────────────────────────────────────────────

/**
 * Map a flag schema to typed handler parameters.
 *
 * - Flags with `validate` → the validator's return type (branded) | undefined
 * - Boolean flags → boolean | undefined
 * - Everything else → string | undefined
 *
 * All flags are optional because CLI users may omit any flag.
 */
export type InferFlags<F extends Record<string, FlagDef>> = {
	[K in keyof F]: F[K] extends { validate: (v: string) => infer R }
		? R | undefined
		: F[K] extends { type: "boolean" }
			? boolean | undefined
			: string | undefined;
};

// ─── CommandContext ───────────────────────────────────────────────────────────

/**
 * Shared dependencies injected into every command handler.
 *
 * Replaces the current pattern where each handler independently calls
 * createClient(), resolveTenantId(), getLogger().
 */
export interface CommandContext {
	/** Authenticated SDK client for the active profile. */
	client: CamundaClient;
	/** Logger configured for the current output mode. */
	logger: Logger;
	/** Tenant ID from the active profile (undefined if not multi-tenant). */
	tenantId: string | undefined;
	/** Normalised resource name (e.g. "process-instance"). */
	resource: string;
	/** Positional arguments after verb and resource (e.g. the key in `get pi <key>`). */
	positionals: string[];
	/** Sort direction from --asc / --desc flags. */
	sortOrder: SortOrder;
	/** Pagination limit from --limit flag (parsed to number). */
	limit: number | undefined;
	/** Whether --dry-run was set. */
	dryRun: boolean;
	/** Active profile name (for client/tenant resolution). */
	profile: string | undefined;
}

// ─── CommandDefinition ───────────────────────────────────────────────────────

/**
 * A fully typed command definition. The handler's `flags` parameter is
 * inferred from `F`, so branded types flow through without casts.
 */
export interface CommandDefinition<F extends Record<string, FlagDef>> {
	verb: string;
	resources: string[];
	flags: F;
	handler: (ctx: CommandContext, flags: InferFlags<F>) => Promise<void>;
}

/**
 * Define a command with type-safe flag inference.
 *
 * TypeScript infers `F` from the `flags` property, then threads the
 * concrete validator return types into the handler's `flags` parameter.
 *
 * ```ts
 * const cmd = defineCommand({
 *   verb: "search",
 *   resources: ["pi"],
 *   flags: { ...SEARCH_FLAGS, ...PI_SEARCH_FLAGS },
 *   handler: async (ctx, flags) => {
 *     // flags.processDefinitionKey is ProcessDefinitionKey | undefined
 *   },
 * });
 * ```
 */
export function defineCommand<F extends Record<string, FlagDef>>(
	def: CommandDefinition<F>,
): CommandDefinition<F> {
	return def;
}

// ─── deserializeFlags ────────────────────────────────────────────────────────

/**
 * Deserialize raw parseArgs values into typed flags.
 *
 * For each flag in the schema:
 * - If the flag has a `validate` function and the raw value is a non-empty
 *   string, call the validator (which returns a branded type).
 * - If the flag is boolean, extract the boolean value.
 * - Otherwise, extract the string value.
 *
 * Validators that throw are intentionally NOT caught here — validation
 * errors should propagate to the top-level error handler.
 */
export function deserializeFlags<F extends Record<string, FlagDef>>(
	values: Record<string, unknown>,
	flagDefs: F,
): InferFlags<F> {
	const result: Record<string, unknown> = {};

	for (const [key, def] of Object.entries(flagDefs)) {
		const raw = values[key];

		if (raw === undefined || raw === false) {
			result[key] = undefined;
			continue;
		}

		if (def.type === "boolean") {
			result[key] = typeof raw === "boolean" ? raw : undefined;
		} else if (typeof raw === "string" && raw !== "") {
			result[key] = def.validate ? def.validate(raw) : raw;
		} else {
			result[key] = undefined;
		}
	}

	// biome-ignore lint/plugin: internal assertion — result is built key-by-key from flagDefs, matching InferFlags<F> structurally
	return result as InferFlags<F>;
}
