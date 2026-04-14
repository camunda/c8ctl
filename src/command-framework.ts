/**
 * Type-safe command definition framework.
 *
 * Provides `defineCommand(verb, resource, handler)` — flags and positionals
 * are derived from the command registry, so handlers receive branded SDK types
 * without any ceremony or `as` casts.
 *
 * Handlers return a `CommandResult` discriminated union. The framework renders
 * results and catches errors in a single place, eliminating per-handler
 * boilerplate for table/json output, empty-list messages, dry-run emission,
 * sorting, and error handling.
 *
 * Phase 2 of #230.
 */

import type { CamundaClient } from "@camunda8/orchestration-cluster-api";

import {
	COMMAND_REGISTRY,
	type CommandDef,
	type FlagDef,
	type PositionalDef,
} from "./command-registry.ts";
import { resolveClusterConfig } from "./config.ts";
import { handleCommandError } from "./errors.ts";
import {
	getLogger,
	type Logger,
	type SortOrder,
	sortTableData,
} from "./logger.ts";
import { c8ctl } from "./runtime.ts";

export type { PositionalDef };

// ─── Registry type ───────────────────────────────────────────────────────────

/** Narrow type of the registry — preserves literal keys and `as const` values. */
type Registry = typeof COMMAND_REGISTRY;

// ─── ResolvedFlags / ResolvedPositionals ─────────────────────────────────────

/**
 * Resolve the flag schema for a verb×resource pair.
 *
 * If the verb has `resourceFlags[R]`, use it. Otherwise fall back to
 * the verb-level `flags` superset.
 */
export type ResolvedFlags<
	V extends keyof Registry,
	R extends string,
> = Registry[V] extends {
	resourceFlags: Record<string, Record<string, FlagDef>>;
}
	? R extends keyof Registry[V]["resourceFlags"]
		? Registry[V]["resourceFlags"][R]
		: Registry[V]["flags"]
	: Registry[V]["flags"];

/**
 * Resolve the positional schema for a verb×resource pair.
 *
 * If the verb has `resourcePositionals[R]`, use it. Otherwise the
 * command has no positional arguments.
 */
export type ResolvedPositionals<
	V extends keyof Registry,
	R extends string,
> = Registry[V] extends {
	resourcePositionals: Record<string, readonly PositionalDef[]>;
}
	? R extends keyof Registry[V]["resourcePositionals"]
		? Registry[V]["resourcePositionals"][R]
		: readonly []
	: readonly [];

// ─── InferFlags ──────────────────────────────────────────────────────────────

/**
 * Map a flag schema to typed handler parameters.
 *
 * - Flags with `validate` → the validator's return type (branded) | undefined
 * - Boolean flags → boolean | undefined
 * - Everything else → string | undefined
 *
 * All flags are optional because CLI users may omit any flag.
 *
 * The type parameter is unconstrained so conditional types like
 * `ResolvedFlags<V, R>` can be passed through without constraint errors.
 */
// biome-ignore lint/suspicious/noExplicitAny: unconstrained to accept conditional types
export type InferFlags<F extends Record<string, any>> = {
	[K in keyof F]: F[K] extends { validate: (v: string) => infer R }
		? R | undefined
		: F[K] extends { type: "boolean" }
			? boolean | undefined
			: string | undefined;
};

// ─── InferPositionals ────────────────────────────────────────────────────────

/**
 * Map a readonly positional schema tuple to a named record of typed values.
 *
 * - Positionals with `validate` → the validator's return type
 * - Positionals without `validate` → string
 * - Required positionals → non-optional
 * - Optional positionals → `| undefined`
 *
 * Accepts any type and uses a conditional guard so deferred types
 * like `ResolvedPositionals<V, R>` pass through cleanly.
 */
export type InferPositionals<P> = P extends readonly PositionalDef[]
	? {
			[K in P[number] as K["name"]]: K extends {
				validate: (v: string) => infer R;
			}
				? K extends { required: true }
					? R
					: R | undefined
				: K extends { required: true }
					? string
					: string | undefined;
		}
	: Record<string, never>;

// ─── CommandResult ───────────────────────────────────────────────────────────

/**
 * Discriminated union returned by command handlers.
 *
 * The framework's `execute` method renders these centrally — handlers
 * never call `logger.table()` or `logger.json()` directly.
 */

/** List/search command: render as table or JSON array. */
export interface ListResult {
	readonly kind: "list";
	/** Already-mapped display rows (e.g. { Key, "Process ID", State }). */
	readonly items: Record<string, unknown>[];
	/** Message when items is empty (e.g. "No process instances found"). */
	readonly emptyMessage: string;
}

/** Get command: render a single object as JSON. */
export interface GetResult {
	readonly kind: "get";
	/** The raw API response object. */
	readonly data: unknown;
	/** Optional info message logged before the JSON data (e.g. source hint). */
	readonly message?: string;
}

/** Raw output: emit a string verbatim (e.g. BPMN XML). */
export interface RawResult {
	readonly kind: "raw";
	/** String content to output verbatim. */
	readonly content: string;
}

/** Dry-run: handler determined a dry-run was emitted and wants to stop. */
export interface DryRunResult {
	readonly kind: "dryRun";
	/** Dry-run info object (passed to logger.json). */
	readonly info: Record<string, unknown>;
}

/** Info message: no data to display, just a message (e.g. "User task has no form"). */
export interface InfoResult {
	readonly kind: "info";
	/** Message to display. */
	readonly message: string;
}

/** Success message: a mutating operation succeeded (e.g. "Incident 77777 resolved"). */
export interface SuccessResult {
	readonly kind: "success";
	/** Human-readable success message. */
	readonly message: string;
	/** Optional resource key to display alongside the message. */
	readonly key?: string | number;
}

/** No result: side-effectful command that handles its own output (e.g. deploy, run, open). */
export interface NoResult {
	readonly kind: "none";
}

/** Never-returning command: runs indefinitely or takes over the process (e.g. watch, mcp-proxy). */
export interface NeverResult {
	readonly kind: "never";
}

export type CommandResult =
	| ListResult
	| GetResult
	| RawResult
	| DryRunResult
	| InfoResult
	| SuccessResult
	| NoResult
	| NeverResult;

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
	/** Sort field from --sortBy flag. */
	sortBy: string | undefined;
	/** Pagination limit from --limit flag (parsed to number). */
	limit: number | undefined;
	/** Whether --all was set (e.g. list all, disable default state filter). */
	all: boolean | undefined;
	/** Date range from --between flag (e.g. "7d", "2024-01-01..2024-12-31"). */
	between: string | undefined;
	/** Date field for --between filter. */
	dateField: string | undefined;
	/** Version filter (parsed from --version flag). */
	version?: number | undefined;
	/** Whether --dry-run was set. */
	dryRun: boolean | undefined;
	/** Active profile name (for client/tenant resolution). */
	profile: string | undefined;
}

// ─── CommandHandler ──────────────────────────────────────────────────────────

/**
 * Return type of `defineCommand`. Stores the verb, resource, and an
 * `execute` method that deserializes raw CLI input and calls the handler
 * with fully typed flags and positionals.
 */
export interface CommandHandler<V extends keyof Registry, R extends string> {
	verb: V;
	resource: R;
	execute: (
		ctx: CommandContext,
		rawValues: Record<string, unknown>,
		rawArgs: string[],
	) => Promise<void>;
}

/**
 * Type-erased command handler for use in dispatch maps.
 * Preserves the `execute` signature without carrying generic type params.
 */
export type AnyCommandHandler = CommandHandler<keyof Registry, string>;

// ─── defineCommand ───────────────────────────────────────────────────────────

/**
 * Define a command handler for a verb×resource pair.
 *
 * Flags and positionals are derived from the command registry —
 * no ceremony, no duplication. The handler receives fully typed
 * parameters.
 *
 * ```ts
 * export const getProcessDefinition = defineCommand(
 *   "get",
 *   "process-definition",
 *   async (ctx, flags, args) => {
 *     // ctx.client is CamundaClient
 *     // flags.xml is boolean | undefined
 *     // args.key is ProcessDefinitionKey
 *   },
 * );
 * ```
 */
export function defineCommand<V extends keyof Registry, R extends string>(
	verb: V,
	resource: R,
	handler: (
		ctx: CommandContext,
		flags: InferFlags<ResolvedFlags<V, R>>,
		args: InferPositionals<ResolvedPositionals<V, R>>,
	) => Promise<CommandResult | undefined>,
): CommandHandler<V, R> {
	// Widen to CommandDef so optional properties are accessible regardless of which verb V is
	const entry: CommandDef = COMMAND_REGISTRY[verb];
	const flagDefs = entry.resourceFlags?.[resource] ?? entry.flags;
	const positionalDefs = entry.resourcePositionals?.[resource] ?? [];

	return {
		verb,
		resource,
		execute: async (ctx, rawValues, rawArgs) => {
			const flags = deserializeFlags(rawValues, flagDefs);
			const args = deserializePositionals(
				rawArgs,
				positionalDefs,
				verb,
				resource,
			);
			try {
				const result = await handler(
					ctx,
					// biome-ignore lint/plugin: framework-internal assertion — flagDefs resolved from COMMAND_REGISTRY[V][R]
					flags as InferFlags<ResolvedFlags<V, R>>,
					// biome-ignore lint/plugin: framework-internal assertion — positionalDefs resolved from COMMAND_REGISTRY[V][R]
					args as InferPositionals<ResolvedPositionals<V, R>>,
				);
				if (result) renderResult(result, ctx);
			} catch (error) {
				handleCommandError(
					ctx.logger,
					`Failed to ${verb} ${resource.replace(/-/g, " ")}`,
					error,
				);
			}
		},
	};
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

// ─── deserializePositionals ──────────────────────────────────────────────────

/**
 * Deserialize raw positional strings into a typed named record.
 *
 * For each positional in the schema (in order):
 * - If required and missing, exits with an error message.
 * - If a `validate` function is present, calls it to produce a branded type.
 * - Otherwise, passes the raw string through.
 *
 * Returns a named record keyed by each positional's `name`.
 */
export function deserializePositionals<P extends readonly PositionalDef[]>(
	raw: string[],
	positionalDefs: P,
	verb: string,
	resource: string,
): InferPositionals<P> {
	const result: Record<string, unknown> = {};

	for (let i = 0; i < positionalDefs.length; i++) {
		const def = positionalDefs[i];
		const value = raw[i];

		if (!value) {
			if (def.required) {
				// Build a human-readable label from the positional name:
				// "roleId" → "role ID", "mappingRuleId" → "mapping rule ID", "key" → "key"
				const expandedName = def.name
					.replace(/([a-z])([A-Z])/g, "$1 $2")
					.toLowerCase()
					.replace(/\bid\b/gi, "ID");

				// If the expanded name already starts with the resource name,
				// use it directly (e.g. "username" for resource "user" → "Username required").
				// Otherwise, prepend the resource as context (e.g. "key" for "user-task" → "User task key required").
				const resourceNorm = resource.replace(/-/g, " ");
				const alreadyDescriptive = expandedName
					.toLowerCase()
					.startsWith(resourceNorm.toLowerCase());

				let displayLabel: string;
				if (alreadyDescriptive) {
					displayLabel =
						expandedName.charAt(0).toUpperCase() + expandedName.slice(1);
				} else {
					// Singularize trailing "s" for the prefix (e.g. "jobs" → "Job")
					const prefix = resourceNorm.replace(/s$/, "");
					displayLabel =
						prefix.charAt(0).toUpperCase() +
						prefix.slice(1) +
						" " +
						expandedName;
				}

				getLogger().error(
					`${displayLabel} required. Usage: c8 ${verb} ${resource} <${def.name}>`,
				);
				process.exit(1);
			}
			result[def.name] = undefined;
			continue;
		}

		result[def.name] = def.validate ? def.validate(value) : value;
	}

	// biome-ignore lint/plugin: internal assertion — result is built key-by-key from positionalDefs, matching InferPositionals<P> structurally
	return result as InferPositionals<P>;
}

// ─── renderResult ────────────────────────────────────────────────────────────

/**
 * Render a `CommandResult` to the user via the logger.
 *
 * This is the single rendering point for all command output —
 * handlers never call logger.table/json/output/info directly.
 *
 * During migration, handlers that still do their own I/O return
 * `undefined` (implicit void) — renderResult is a no-op in that case.
 */
function renderResult(result: CommandResult, ctx: CommandContext): void {
	if (!result) return;
	const { logger, sortBy, sortOrder } = ctx;

	switch (result.kind) {
		case "list":
			if (result.items.length > 0) {
				const sorted = sortTableData(result.items, sortBy, logger, sortOrder);
				logger.table(sorted);
			} else {
				logger.info(result.emptyMessage);
			}
			break;
		case "get":
			if (result.message) logger.info(result.message);
			logger.json(result.data);
			break;
		case "raw":
			logger.output(result.content);
			break;
		case "dryRun":
			logger.json(result.info);
			break;
		case "info":
			logger.info(result.message);
			break;
		case "success":
			logger.success(result.message, result.key);
			break;
		case "none":
		case "never":
			break;
	}
}

// ─── dryRun ──────────────────────────────────────────────────────────────────

/**
 * Check if dry-run mode is active and return a `DryRunResult` if so.
 *
 * Usage in handlers:
 * ```ts
 * const dr = dryRun({ command: "list pi", method: "POST", endpoint: "/process-instances/search", profile, body: filter });
 * if (dr) return dr;
 * ```
 *
 * Replaces the old `emitDryRun()` side-effecting pattern.
 */
export function dryRun(opts: {
	command: string;
	method: string;
	endpoint: string;
	profile?: string;
	body?: unknown;
}): DryRunResult | null {
	if (!c8ctl.dryRun) return null;
	const config = resolveClusterConfig(opts.profile);
	return {
		kind: "dryRun",
		info: {
			dryRun: true,
			command: opts.command,
			method: opts.method,
			url: `${config.baseUrl}${opts.endpoint}`,
			...(opts.body !== undefined && { body: opts.body }),
		},
	};
}
