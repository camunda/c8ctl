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
 * So on Windows the shim is run through `cmd.exe` via `execSync(commandString)`.
 * Using `execFileSync(cmd, args, { shell: true })` would achieve the same effect
 * but triggers Node's DEP0190 deprecation warning (passing an args array with
 * `shell: true` is deprecated as of Node ≥ 22). `execSync` takes a pre-built
 * command string instead of an args array and is not subject to DEP0190.
 *
 * Because `cmd.exe` receives the arguments as a single command line, every
 * argument must be quoted — plugin directories on Windows routinely contain
 * spaces (`C:\Users\First Last\AppData\Roaming\c8ctl\plugins`).
 *
 * Double quoting is sound on Windows because `"`, `<`, `>` and `|` are illegal
 * in filenames and `cmd.exe` does not interpret `&`, `^` or `|` inside double
 * quotes. Arguments still originate from user input (plugin names, URLs), so
 * the two constructs that survive double quotes — an embedded `"` and a
 * `%VAR%` environment-variable reference — are rejected outright rather than
 * escaped.
 *
 * A second Windows-only hazard is npm's own `--prefix` handling: a CLI
 * `--prefix` sets the *global* prefix as well as the local one, and Windows
 * puts the global install root directly under the prefix, so for a plain
 * `npm install --prefix <dir>` npm cannot tell a local install apart from a
 * global one and silently installs the *process cwd* instead (#526). That case
 * is re-expressed as a cwd — see `rescopeWindowsLocalInstall()`.
 */

import {
	type ExecFileSyncOptions,
	execFileSync,
	execSync,
} from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface NpmInvocation {
	/** Executable to spawn. */
	command: string;
	/** Arguments, quoted when `shell` is true. */
	args: string[];
	/** Whether the invocation must go through a shell. */
	shell: boolean;
	/** Directory to run npm in; `undefined` inherits the process cwd. */
	cwd?: string;
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

/** npm's `install` verb and every alias npm maps onto it (`npm help install`, `lib/utils/cmd-list.js`). */
const NPM_INSTALL_COMMANDS = new Set([
	"install",
	"add",
	"i",
	"in",
	"ins",
	"inst",
	"insta",
	"instal",
	"isnt",
	"isnta",
	"isntal",
	"isntall",
]);

/** True when `flag` is already set in any spelling npm accepts (`--no-x`, `--x`, `--x=…`). */
function hasBooleanFlag(args: readonly string[], name: string): boolean {
	return args.some(
		(arg) =>
			arg === `--no-${name}` ||
			arg === `--${name}` ||
			arg.startsWith(`--${name}=`),
	);
}

/**
 * npm's `uninstall` verb and every alias npm maps onto it
 * (`npm help uninstall`, `lib/utils/cmd-list.js`).
 */
const NPM_UNINSTALL_COMMANDS = new Set([
	"uninstall",
	"unlink",
	"remove",
	"rm",
	"r",
	"un",
]);

/**
 * npm commands that trigger the registry `audit`/`fund` round-trip: everything
 * that mutates the dependency tree (install and uninstall families).
 */
function triggersAudit(command: string): boolean {
	return (
		NPM_INSTALL_COMMANDS.has(command) || NPM_UNINSTALL_COMMANDS.has(command)
	);
}

/**
 * Harden tree-mutating npm invocations by disabling `audit` and `fund`.
 *
 * Both trigger a blocking network round-trip to the registry on every
 * install/uninstall. `audit` in particular stalls for minutes when the prefix's
 * dependency tree contains a `file:`/`link` dependency (as every plugin prefix
 * does), which is what makes `c8 load`/`c8 unload plugin` — and the
 * plugin-lifecycle integration tests — hang until their `spawnSync` timeout
 * fires. Neither is relevant to (un)loading a plugin, so we always opt out.
 * Idempotent: never doubles a flag the caller set.
 */
export function hardenInstallArgs(args: readonly string[]): string[] {
	const command = args.find((arg) => !arg.startsWith("-"));
	if (command === undefined || !triggersAudit(command)) {
		return [...args];
	}
	const hardened = [...args];
	if (!hasBooleanFlag(args, "audit")) hardened.push("--no-audit");
	if (!hasBooleanFlag(args, "fund")) hardened.push("--no-fund");
	return hardened;
}

/** `--prefix` and its documented short form `-C`. */
function isPrefixFlag(arg: string): boolean {
	return arg === "--prefix" || arg === "-C";
}

/** `-g`, any single-dash cluster containing `g` (`-gf`), `--global`, or `--location=global`. */
function isGlobalFlag(arg: string): boolean {
	if (arg === "--global" || arg === "--global=true") return true;
	if (arg === "--location=global") return true;
	return /^-[a-z]*g[a-z]*$/i.test(arg);
}

/** Any spelling of npm's workspace selectors — `-w`, `--workspace(s)`, `--no-workspaces`. */
function isWorkspaceFlag(arg: string): boolean {
	return arg === "-w" || /^--(no-)?workspaces?(=|$)/.test(arg);
}

interface RescopedInvocation {
	args: string[];
	cwd: string;
}

/** What a prefix directory's `package.json` says, or `null` if there is none. */
export interface PrefixManifest {
	/** Whether the manifest declares a `workspaces` field. */
	declaresWorkspaces: boolean;
}

/**
 * Re-express `npm install --prefix <dir>` (no package specs) as an npm run
 * whose *working directory* is `<dir>`.
 *
 * npm applies a CLI `--prefix` to both the local and the global prefix. On
 * Windows the global install root is `<prefix>\node_modules`, while on POSIX
 * it is `<prefix>/lib/node_modules`, so on Windows `npm install --prefix <dir>`
 * makes the local install target (`npm.prefix`) and the global install target
 * (`dirname(npm.globalDir)`) the *same* directory. npm's install command reads
 * that as a global install of the current directory:
 *
 *     // `npm i -g` => "install this package globally"
 *     if (where === globalTop && !args.length) { args = ['.'] }
 *
 * `.` is then resolved against the *process* cwd, so npm stops installing the
 * dependencies declared in `<dir>` and instead tries to read `package.json`
 * from the cwd — the ENOENT reported in #526. POSIX never trips the collision.
 *
 * Setting npm's cwd expresses the same intent without the prefix collision:
 * `npm.localPrefix` walks up from the cwd and settles on `<dir>`, which is
 * where the `package.json` lives. The two are not *quite* interchangeable —
 * having settled on `<dir>`, npm keeps walking up to see whether an ancestor
 * declares `<dir>` as one of its workspaces and promotes the local prefix to
 * that ancestor if so, something `--prefix` never does — so the rewrite also
 * passes `--workspaces=false`, which makes npm stop at `<dir>` (see
 * `@npmcli/config`'s `loadLocalPrefix()`). The rewrite is deliberately
 * conservative:
 *
 *   - only the install verb with no package spec is affected — every other npm
 *     command, and `npm install <pkg> --prefix <dir>`, resolves `--prefix`
 *     correctly on Windows;
 *   - a global install keeps `--prefix`, which is exactly what it means there;
 *   - any other bare token (e.g. the value of `--loglevel warn`) is treated as
 *     a possible package spec and suppresses the rewrite;
 *   - `<dir>` must actually contain a `package.json`, so npm can never walk up
 *     past `<dir>` and install some parent directory's dependencies instead;
 *   - a `<dir>` that is itself a workspace root, or an invocation that already
 *     carries a workspace selector, is left alone: `--workspaces=false` would
 *     drop the workspaces from the install instead of merely bounding the
 *     walk-up.
 */
function rescopeWindowsLocalInstall(
	args: readonly string[],
	readPrefixManifest: (dir: string) => PrefixManifest | null,
): RescopedInvocation | null {
	const kept: string[] = [];
	const bareTokens: string[] = [];
	let prefix: string | undefined;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === undefined) continue;
		if (isGlobalFlag(arg) || isWorkspaceFlag(arg)) return null;
		if (isPrefixFlag(arg)) {
			const value = args[i + 1];
			// A dangling `--prefix` is npm's problem to report, not ours.
			if (value === undefined || value.startsWith("-")) return null;
			prefix = value;
			i++;
			continue;
		}
		if (arg.startsWith("--prefix=")) {
			prefix = arg.slice("--prefix=".length);
			continue;
		}
		if (!arg.startsWith("-")) bareTokens.push(arg);
		kept.push(arg);
	}

	if (prefix === undefined || prefix === "") return null;
	const command = bareTokens[0];
	if (bareTokens.length !== 1 || command === undefined) return null;
	if (!NPM_INSTALL_COMMANDS.has(command)) return null;
	const manifest = readPrefixManifest(prefix);
	if (manifest === null || manifest.declaresWorkspaces) return null;

	return { args: [...kept, "--workspaces=false"], cwd: prefix };
}

/** Read `<dir>/package.json`; `null` when it is absent or unreadable. */
function readPackageJson(dir: string): PrefixManifest | null {
	let parsed: unknown;
	try {
		const source = readFileSync(join(dir, "package.json"), "utf-8");
		// npm reads manifests through json-parse-even-better-errors, which
		// tolerates a leading BOM — Windows editors write them, and the whole
		// point of this branch is Windows.
		parsed = JSON.parse(source.replace(/^\uFEFF/, ""));
	} catch {
		// Absent or malformed: either way there is nothing to re-scope onto.
		return null;
	}
	const declaresWorkspaces =
		typeof parsed === "object" && parsed !== null && "workspaces" in parsed;
	return { declaresWorkspaces };
}

/**
 * Resolve how npm has to be spawned on the given platform.
 *
 * Exported for unit testing: pass an explicit `platform` to exercise the
 * Windows branch from a POSIX host, and `readPrefixManifest` to exercise the
 * Windows `--prefix` rescope without touching the filesystem.
 */
export function buildNpmInvocation({
	args,
	platform = process.platform,
	readPrefixManifest = readPackageJson,
}: {
	args: readonly string[];
	platform?: NodeJS.Platform;
	readPrefixManifest?: (dir: string) => PrefixManifest | null;
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

	// Validation runs on the arguments as given, so rescoping never widens what
	// is accepted: a hostile `--prefix` value is rejected before it can become a cwd.
	const rescoped = rescopeWindowsLocalInstall(args, readPrefixManifest);

	return {
		command: "npm.cmd",
		args: (rescoped?.args ?? args).map(quoteWindowsArg),
		shell: true,
		...(rescoped ? { cwd: rescoped.cwd } : {}),
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
	const {
		command,
		args: resolvedArgs,
		shell,
		cwd,
	} = buildNpmInvocation({ args: hardenInstallArgs(args) });
	// On Windows, `shell` is true because npm is a .cmd shim that requires cmd.exe.
	// execFileSync(command, args, { shell: true }) triggers DEP0190 in Node ≥ 22 when
	// an args array is combined with shell: true. execSync(commandString) takes a
	// pre-built string instead of an array, so it is not subject to DEP0190.
	// On POSIX, shell is false and execFileSync is used directly (no change).
	if (shell) {
		const cmdLine = [command, ...resolvedArgs].join(" ");
		if (opts.stdout) {
			return {
				stdout: execSync(cmdLine, {
					stdio: ["ignore", "pipe", "pipe"],
					encoding: "utf-8",
					cwd,
				}),
			};
		}
		execSync(cmdLine, { stdio: opts.stdio, cwd });
		return undefined;
	}
	if (opts.stdout) {
		return {
			stdout: execFileSync(command, resolvedArgs, {
				stdio: ["ignore", "pipe", "pipe"],
				encoding: "utf-8",
				shell: false,
				cwd,
			}),
		};
	}
	execFileSync(command, resolvedArgs, { stdio: opts.stdio, shell: false, cwd });
	return undefined;
}
