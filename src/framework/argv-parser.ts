/**
 * Two-stage command-line parser (#373).
 *
 * ```
 * c8ctl [global flags] <verb> [<resource>] [verb flags + post-verb globals] [args]
 * ```
 *
 * - **Stage 1** ({@link splitGlobals}) parses `GLOBAL_FLAGS` only, walking the
 *   argv from the start, and stops at the first positional — the verb. Every
 *   token after the verb is returned untouched (`rest`) so stage 2 can parse
 *   it against the flag table of *that* command.
 * - **Stage 2** ({@link parseBuiltinVerbArgs} for built-in verbs, or
 *   {@link parseFlags} with a caller-built table for plugin verbs) parses
 *   `rest` against `GLOBAL_FLAGS ∪ effectiveFlags(verb, resource)`. Globals
 *   stay accepted after the verb (the lenient variant of #373), so
 *   `c8ctl list pi --json` keeps working.
 *
 * Because each command is parsed against its own table, a flag name can mean
 * different things on different commands without any handler re-reading
 * `process.argv`: `--variables` is boolean for `get pi` and a string for
 * `create pi`; `--version` is a boolean global before the verb (show the CLI
 * version) and the string definition-version filter after `list pi`.
 *
 * This module also owns the raw-argv helpers the host needs for plugin
 * commands (global-flag stripping for passthrough plugins, blocked-flag
 * stripping for the plugin flag re-parse), so there is one place that knows
 * how to walk flag tokens.
 */

import { parseArgs } from "node:util";
import {
	COMMAND_REGISTRY_BY_VERB,
	type FlagDef,
	GLOBAL_FLAGS,
	getCommandDef,
	resolveAlias,
	resolveVerbAlias,
	VERB_ALIASES,
} from "./command-registry.ts";

// ─── Option tables ───────────────────────────────────────────────────────────

/** One entry of a `node:util` `parseArgs` options table. */
export interface ParseOption {
	type: "string" | "boolean";
	short?: string;
	multiple?: boolean;
}

/** A `parseArgs` options table. Null-prototype so flag names like `__proto__` are inert. */
export type ParseOptions = Record<string, ParseOption>;

/** Values produced by `parseArgs` with `strict: false`. */
export type ParsedValues = Record<
	string,
	string | boolean | (string | boolean)[] | undefined
>;

/** A token as reported by `parseArgs({ tokens: true })`. */
type ArgToken = NonNullable<ReturnType<typeof parseArgs>["tokens"]>[number];

type FlagDefs = Record<
	string,
	Pick<FlagDef, "type" | "short" | "multiple"> | undefined
>;

function emptyOptions(): ParseOptions {
	return Object.create(null);
}

/** Add `defs` to `target`. On a name clash `string` wins and `multiple` sticks. */
function addOptions({
	target,
	defs,
}: {
	target: ParseOptions;
	defs: FlagDefs;
}): ParseOptions {
	for (const [name, def] of Object.entries(defs)) {
		if (!def) continue;
		const existing = target[name];
		if (!existing) {
			target[name] = {
				type: def.type,
				...(def.short && { short: def.short }),
				...(def.multiple && { multiple: true }),
			};
			continue;
		}
		if (def.type === "string") existing.type = "string";
		if (def.short && !existing.short) existing.short = def.short;
		if (def.multiple) existing.multiple = true;
	}
	return target;
}

/** `GLOBAL_FLAGS` exactly as declared (`--version` is a string: the post-verb definition-version filter). */
export function globalOptions(): ParseOptions {
	return addOptions({ target: emptyOptions(), defs: GLOBAL_FLAGS });
}

/**
 * The stage-1 table: `GLOBAL_FLAGS`, except that `--version` / `-v` is a
 * plain boolean. Before the verb it can only mean "show the CLI version", and
 * a boolean cannot swallow the verb that follows it (`c8ctl --version list pi`).
 */
function stage1Options(): ParseOptions {
	const options = globalOptions();
	options.version = { type: "boolean", short: GLOBAL_FLAGS.version.short };
	return options;
}

// ─── Core tokenising parse ───────────────────────────────────────────────────

/** True when `token` is a flag in `options` (or the `--` terminator) and so cannot be a flag's value. */
function isKnownFlagToken({
	token,
	options,
}: {
	token: string;
	options: ParseOptions;
}): boolean {
	if (token === "--") return true;
	if (token.startsWith("--")) {
		const eq = token.indexOf("=");
		return Object.hasOwn(options, eq < 0 ? token.slice(2) : token.slice(2, eq));
	}
	return (
		token.length === 2 &&
		token.startsWith("-") &&
		Object.values(options).some((o) => o.short === token[1])
	);
}

/**
 * Stand-in value for "a string flag that was given no value because the next
 * token is another flag". NUL cannot occur in an argv entry, so it cannot
 * collide with real input. {@link parseFlags} turns it into `true` — the same
 * thing `parseArgs` reports for a string flag at the very end of the line.
 */
const NO_VALUE = "\u0000no-value";

/**
 * `parseArgs` hands the next token to a string flag as its value even when
 * that token is itself a flag (`--fields --dry-run` yields
 * `fields: "--dry-run"` and silently drops `--dry-run`). Rewrite such a
 * string flag to `--name=<NO_VALUE>` so the following known flag is parsed as
 * a flag and the string flag reads as `true` (given, no value). Token
 * positions are preserved. Only *known* flags are treated this way, so
 * values that merely start with a dash (`--limit -5`) are untouched.
 */
function protectFlagLikeValues({
	args,
	options,
}: {
	args: readonly string[];
	options: ParseOptions;
}): string[] {
	const out = [...args];
	const nameForShort = (char: string): string | undefined =>
		Object.entries(options).find(([, o]) => o.short === char)?.[0];
	for (let i = 0; i < out.length - 1; i++) {
		const token = out[i];
		if (token === "--") break;
		let name: string | undefined;
		if (token.startsWith("--") && !token.includes("=")) {
			name = token.slice(2);
		} else if (
			token.length === 2 &&
			token.startsWith("-") &&
			token[1] !== "-"
		) {
			name = nameForShort(token[1]);
		}
		if (name === undefined || options[name]?.type !== "string") continue;
		if (isKnownFlagToken({ token: out[i + 1], options })) {
			out[i] = `--${name}=${NO_VALUE}`;
		}
	}
	return out;
}

/**
 * The one place `parseArgs` is called for command-line parsing. Lenient
 * (`strict: false`): unknown flags never throw — they are reported later as
 * warnings by the unknown-flag detector.
 */
export function parseFlags({
	args,
	options,
}: {
	args: readonly string[];
	options: ParseOptions;
}): { values: ParsedValues; positionals: string[]; tokens: ArgToken[] } {
	const { values, positionals, tokens } = parseArgs({
		args: protectFlagLikeValues({ args, options }),
		options,
		allowPositionals: true,
		strict: false,
		tokens: true,
	});
	const resolved: ParsedValues = Object.create(null);
	for (const [name, value] of Object.entries(values)) {
		resolved[name] = Array.isArray(value)
			? value.map((v) => (v === NO_VALUE ? true : v))
			: value === NO_VALUE
				? true
				: value;
	}
	return { values: resolved, positionals, tokens: tokens ?? [] };
}

// ─── Stage 1 ─────────────────────────────────────────────────────────────────

export interface Stage1Result {
	/** Global flags that appeared before the verb. `version` is `true` when `--version` / `-v` was given. */
	globals: ParsedValues;
	/** The raw verb token (may be an alias or a plugin verb), or `undefined` when there is none. */
	verb: string | undefined;
	/** Every argv token after the verb, verbatim. */
	rest: string[];
}

/**
 * Stage 1: parse `GLOBAL_FLAGS` from the front of `argv` and stop at the
 * verb. A `--` terminator is skipped, so `c8ctl -- list pi` still dispatches
 * `list`; a `--` after the verb is left in `rest` for stage 2.
 */
export function splitGlobals(argv: readonly string[]): Stage1Result {
	const options = stage1Options();
	const { tokens, values } = parseFlags({ args: argv, options });
	for (const token of tokens) {
		if (token.kind !== "positional") continue;
		return {
			globals: parseFlags({ args: argv.slice(0, token.index), options }).values,
			verb: token.value,
			rest: argv.slice(token.index + 1),
		};
	}
	return { globals: values, verb: undefined, rest: [] };
}

// ─── Stage 2 (built-in verbs) ────────────────────────────────────────────────

/** Canonical verb names an input verb (canonical or alias) can refer to. */
function verbTargets(rawVerb: string): string[] {
	if (Object.hasOwn(COMMAND_REGISTRY_BY_VERB, rawVerb)) return [rawVerb];
	return Object.hasOwn(VERB_ALIASES, rawVerb) ? VERB_ALIASES[rawVerb] : [];
}

/**
 * Every flag any resource of `rawVerb` declares, plus globals. Used only to
 * *find* the resource token — which flag values to skip while looking — never
 * to parse the command. Names clash only across different verbs, so within
 * one verb this is unambiguous.
 */
function verbLocatorOptions(rawVerb: string): ParseOptions {
	const options = globalOptions();
	for (const target of verbTargets(rawVerb)) {
		const def = COMMAND_REGISTRY_BY_VERB[target];
		if (!def) continue;
		addOptions({ target: options, defs: def.flags });
		for (const bucket of Object.values(def.resourceFlags ?? {})) {
			addOptions({ target: options, defs: bucket });
		}
	}
	return options;
}

/**
 * `effectiveFlags(verb, resource)` as stage 2 parses it: the globals, the
 * verb-level flags, and the flag bucket of `resource` only — never the
 * buckets of sibling resources.
 */
export function stage2Options({
	verb,
	resource,
}: {
	verb: string;
	resource: string;
}): ParseOptions {
	const options = globalOptions();
	const def = getCommandDef(verb);
	if (!def) return options;
	addOptions({ target: options, defs: def.flags });
	// Same plural fallback `detectUnknownFlags` applies, so a flag accepted
	// there without a warning is also parsed here.
	const bucket =
		def.resourceFlags?.[resource] ??
		def.resourceFlags?.[resource.replace(/s$/, "")];
	if (bucket) addOptions({ target: options, defs: bucket });
	return options;
}

export interface VerbArgs {
	/** Canonical verb (aliases resolved). */
	verb: string;
	/** The resource as typed (alias/plural form), or `""`. */
	resource: string;
	/** The canonical resource name, or `""`. */
	normalizedResource: string;
	/** Positionals after the resource. */
	args: string[];
	/** Post-verb flag values (globals included). */
	values: ParsedValues;
}

/**
 * Stage 2: find the resource, pick `effectiveFlags(verb, resource)`, and
 * parse `rest` against exactly that table.
 *
 * A verb that is not in the registry (a plugin verb, the reserved `help` /
 * `menu` verbs, or a typo) is parsed against `GLOBAL_FLAGS` alone: a plugin's
 * own flags are re-parsed from `rest` by the host once it has loaded the
 * plugin's flag declarations.
 */
export function parseVerbArgs({
	rawVerb,
	rest,
}: {
	rawVerb: string;
	rest: readonly string[];
}): VerbArgs {
	const [located] = parseFlags({
		args: rest,
		options: verbLocatorOptions(rawVerb),
	}).positionals;
	const verb = resolveVerbAlias(rawVerb, located);
	const normalizedResource = located ? resolveAlias(located) : "";
	const { values, positionals } = parseFlags({
		args: rest,
		options: stage2Options({ verb, resource: normalizedResource }),
	});
	const [resource = "", ...args] = positionals;
	return {
		verb,
		resource,
		normalizedResource: resource ? resolveAlias(resource) : "",
		args,
		values,
	};
}

// ─── Raw-argv helpers for plugin commands ────────────────────────────────────

/**
 * Strip GLOBAL_FLAGS (and the value of any string-typed global flag) from
 * the argv tail forwarded to a passthrough plugin handler (#366).
 * GLOBAL_FLAGS already affect the c8ctl runtime via their regular handling in
 * `main()`; the plugin must not see them again.
 *
 * Conservative behaviour: an isolated `--` terminator is preserved and
 * everything after it is forwarded verbatim, matching POSIX convention.
 */
export function stripGlobalFlags(argv: readonly string[]): string[] {
	const booleanFlags = new Set<string>();
	const stringFlags = new Set<string>();
	const booleanShorts = new Set<string>();
	const stringShorts = new Set<string>();

	for (const [name, def] of Object.entries(GLOBAL_FLAGS)) {
		const short = "short" in def ? def.short : undefined;
		if (def.type === "boolean") {
			booleanFlags.add(name);
			if (short) booleanShorts.add(short);
		} else {
			stringFlags.add(name);
			if (short) stringShorts.add(short);
		}
	}

	const out: string[] = [];
	let i = 0;
	let sawTerminator = false;
	while (i < argv.length) {
		const tok = argv[i];
		if (sawTerminator) {
			out.push(tok);
			i++;
			continue;
		}
		if (tok === "--") {
			sawTerminator = true;
			out.push(tok);
			i++;
			continue;
		}
		if (tok.startsWith("--")) {
			const eq = tok.indexOf("=");
			const name = eq >= 0 ? tok.slice(2, eq) : tok.slice(2);
			if (booleanFlags.has(name) || stringFlags.has(name)) {
				if (eq < 0 && stringFlags.has(name)) i++; // consume value
				i++;
				continue;
			}
		} else if (tok.startsWith("-") && tok.length === 2) {
			const short = tok.slice(1);
			if (booleanShorts.has(short)) {
				i++;
				continue;
			}
			if (stringShorts.has(short)) {
				i += 2; // consume short flag and its value
				continue;
			}
		}
		out.push(tok);
		i++;
	}
	return out;
}

/**
 * Remove tokens for blocked plugin flags from an argv slice so they cannot
 * shift positionals during the plugin-flag re-parse.
 *
 * Post-#373, "blocked" exclusively means "collides with a GLOBAL flag".
 * The user may have supplied a value token (`--name value`) intending
 * either:
 *   - the GLOBAL's interpretation (global type === "string"), or
 *   - the PLUGIN's interpretation (plugin type === "string", e.g. global
 *     is boolean but the plugin declared the same name as string).
 *
 * Either way the value is meaningless to both sides (plugin's flag is
 * blocked; global is consumed by the host elsewhere) and must not leak
 * into the plugin's positional args. Strip the following non-flag token
 * if either side typed the flag as string.
 */
export function stripBlockedFlagTokens({
	argv,
	blocked,
	pluginFlagDefs,
	globalFlagDefs,
}: {
	argv: readonly string[];
	blocked: ReadonlySet<string>;
	pluginFlagDefs: Record<string, { type: string }>;
	globalFlagDefs: Record<string, { type: string }>;
}): string[] {
	const out: string[] = [];
	let i = 0;
	while (i < argv.length) {
		const arg = argv[i];
		if (arg.startsWith("--")) {
			const eqIdx = arg.indexOf("=");
			const name = eqIdx >= 0 ? arg.slice(2, eqIdx) : arg.slice(2);
			if (blocked.has(name)) {
				const eitherIsString =
					pluginFlagDefs[name]?.type === "string" ||
					globalFlagDefs[name]?.type === "string";
				if (
					eqIdx < 0 &&
					eitherIsString &&
					i + 1 < argv.length &&
					!argv[i + 1].startsWith("-")
				) {
					i++;
				}
				i++;
				continue;
			}
		}
		out.push(arg);
		i++;
	}
	return out;
}
