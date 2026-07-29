/**
 * Cross-platform npm invocation.
 *
 * On POSIX, `npm` is a real executable on PATH and can be spawned directly.
 * On Windows, `npm` is a `npm.cmd` batch shim, and neither of the obvious
 * approaches works on the Node versions this CLI supports:
 *
 *   - bare `"npm"`      -> ENOENT (spawn does not apply PATHEXT resolution)
 *   - `"npm.cmd"` alone -> EINVAL (the CVE-2024-27980 hardening in Node
 *                          18.20.2 / 20.12.2 / 21.7.3+ refuses to spawn a
 *                          `.bat`/`.cmd` file without `shell: true`)
 *
 * So on Windows we run the shim through `cmd.exe` (`shell: true`). Node joins
 * the arguments verbatim into a single command line in that mode, so every
 * argument has to be quoted here — plugin directories on Windows routinely
 * contain spaces (`C:\Users\First Last\AppData\Roaming\c8ctl\plugins`).
 *
 * Double quoting is sound on Windows because `"`, `<`, `>` and `|` are illegal
 * in filenames and `cmd.exe` does not interpret `&`, `^` or `|` inside double
 * quotes. Arguments still originate from user input (plugin names, URLs), so
 * the two constructs that survive double quotes — an embedded `"` and a
 * `%VAR%` environment-variable reference — are rejected outright rather than
 * escaped.
 */

import { type ExecFileSyncOptions, execFileSync } from "node:child_process";

export interface NpmInvocation {
	/** Executable to spawn. */
	command: string;
	/** Arguments, quoted when `shell` is true. */
	args: string[];
	/** Whether the invocation must go through a shell. */
	shell: boolean;
}

export interface NpmResult {
	stdout?: string;
}

interface NpmArgs {
	args: readonly string[];
}

interface NpmArgsWithOutput extends NpmArgs {
	stdout: true;
}

interface NpmArgsWithoutOutput extends NpmArgs {
	stdio?: ExecFileSyncOptions["stdio"];
	stdout?: false;
}

/** Characters that cannot be represented inside a double-quoted cmd.exe argument: quotes, line breaks and NUL. */
const WINDOWS_UNQUOTABLE = /["\r\n\0]/;

/** A cmd.exe `%VAR%` environment-variable reference, which cmd.exe expands even inside double quotes.
 *  Requires the name to start with a letter or underscore so that percent-encoded URL sequences
 *  (which start with hex digits like `%20`) are not mistakenly treated as variable references.
 *  Parentheses are allowed to cover names like `%ProgramFiles(x86)%`. */
const WINDOWS_CMD_VARIABLE = /%[A-Z_][^%]*?%/i;

/**
 * Quote a single argument for a verbatim Windows command line.
 *
 * Trailing backslashes are doubled so that `C:\dir\` does not turn the closing
 * quote into an escaped literal quote.
 */
function quoteWindowsArg(arg: string): string {
	return `"${arg.replace(/(\\+)$/, "$1$1")}"`;
}

/**
 * Resolve how npm has to be spawned on the given platform.
 *
 * Exported for unit testing: pass an explicit `platform` to exercise the
 * Windows branch from a POSIX host.
 */
export function buildNpmInvocation({
	args,
	platform = process.platform,
}: {
	args: readonly string[];
	platform?: NodeJS.Platform;
}): NpmInvocation {
	if (platform !== "win32") {
		return { command: "npm", args: [...args], shell: false };
	}

	for (const arg of args) {
		if (WINDOWS_UNQUOTABLE.test(arg)) {
			throw new Error(
				`Refusing to run npm: argument contains a quote or line break that cannot be passed safely to cmd.exe: ${JSON.stringify(arg)}`,
			);
		}
		if (WINDOWS_CMD_VARIABLE.test(arg)) {
			throw new Error(
				`Refusing to run npm: argument contains a cmd.exe environment variable reference: ${JSON.stringify(arg)}`,
			);
		}
	}

	return {
		command: "npm.cmd",
		args: args.map(quoteWindowsArg),
		shell: true,
	};
}

/**
 * Run npm through the platform-aware wrapper.
 */
export function npm(options: NpmArgsWithOutput): { stdout: string };
export function npm(options: NpmArgsWithoutOutput): undefined;
export function npm({
	args,
	...opts
}: NpmArgsWithOutput | NpmArgsWithoutOutput): NpmResult | undefined {
	const { command, args: resolvedArgs, shell } = buildNpmInvocation({ args });
	if (opts.stdout) {
		return {
			stdout: execFileSync(command, resolvedArgs, {
				stdio: ["ignore", "pipe", "pipe"],
				encoding: "utf-8",
				shell,
			}),
		};
	}
	execFileSync(command, resolvedArgs, { stdio: opts.stdio, shell });
}
