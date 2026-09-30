/**
 * Pure helpers for a plugin verb's declared flags (`{ flags, handler }`).
 *
 * A plugin's effective flag table is `GLOBAL_FLAGS ∪ plugin.flags`. A plugin
 * flag whose long name is also a global flag is *reserved*: the host consumes
 * it as the global, so the plugin can never receive it. A plugin short alias
 * that is also a global alias is dropped (the long flag keeps working). This
 * module works that out once, without logging, so the runtime (warn only when
 * the user actually typed a reserved flag), `c8ctl doctor plugin` (author
 * diagnostic) and `help` (never advertise a flag that cannot work) all agree.
 */

import {
	globalOptions,
	type ParsedValues,
	type ParseOptions,
} from "../argv-parser.ts";
import type { FlagDef } from "../command-registry.ts";

export interface PluginFlagAnalysis {
	/** `GLOBAL_FLAGS ∪` the plugin flags that can actually be parsed. Null-prototype. */
	options: ParseOptions;
	/** Plugin flag names that collide with a global flag name and are therefore never delivered. */
	reservedNames: string[];
	/** Plugin short aliases that collide with a global alias: `{ name, short }`. The long flag still works. */
	reservedShorts: { name: string; short: string }[];
	/** The plugin's flags minus the reserved ones, with reserved short aliases removed — what help should show. */
	usable: Record<string, FlagDef>;
}

export function analyzePluginFlags(
	flagDefs: Record<string, FlagDef>,
): PluginFlagAnalysis {
	const globals = globalOptions();
	const globalShorts = new Set(
		Object.values(globals)
			.map((o) => o.short)
			.filter((s): s is string => s !== undefined),
	);
	const options = globalOptions();
	const reservedNames: string[] = [];
	const reservedShorts: { name: string; short: string }[] = [];
	const usable: Record<string, FlagDef> = {};

	for (const [name, def] of Object.entries(flagDefs)) {
		if (Object.hasOwn(globals, name)) {
			reservedNames.push(name);
			continue;
		}
		const shortReserved =
			def.short !== undefined && globalShorts.has(def.short);
		if (shortReserved && def.short !== undefined) {
			reservedShorts.push({ name, short: def.short });
		}
		const { short: _dropped, ...withoutShort } = def;
		usable[name] = shortReserved ? withoutShort : def;
		options[name] = {
			type: def.type,
			...(def.short && !shortReserved && { short: def.short }),
			...(def.multiple && { multiple: true }),
		};
	}
	return { options, reservedNames, reservedShorts, usable };
}

/**
 * The reserved flags the user actually typed (before any `--`), as they
 * should be displayed: `--name` or `-x`.
 */
export function typedReservedFlags({
	argv,
	analysis,
}: {
	argv: readonly string[];
	analysis: PluginFlagAnalysis;
}): string[] {
	const reservedNames = new Set(analysis.reservedNames);
	const reservedShorts = new Set(analysis.reservedShorts.map((r) => r.short));
	const typed = new Set<string>();
	for (const token of argv) {
		if (token === "--") break;
		if (token.startsWith("--")) {
			const eq = token.indexOf("=");
			const name = eq < 0 ? token.slice(2) : token.slice(2, eq);
			if (reservedNames.has(name)) typed.add(`--${name}`);
		} else if (token.length === 2 && token.startsWith("-")) {
			if (reservedShorts.has(token[1])) typed.add(token);
		}
	}
	return [...typed];
}

/** Display form of a parsed flag name: `--long` or `-s`. */
export function displayFlag(name: string): string {
	return name.length === 1 ? `-${name}` : `--${name}`;
}

/** Parsed flag names that are not in `options` — the flags the user typed that nothing declares. */
export function undeclaredFlagNames({
	values,
	options,
}: {
	values: ParsedValues;
	options: ParseOptions;
}): string[] {
	return Object.keys(values).filter((name) => !Object.hasOwn(options, name));
}
