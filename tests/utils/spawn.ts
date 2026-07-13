/**
 * Async spawn utility for tests
 *
 * Replaces spawnSync to avoid the Node.js test runner IPC deserialization error:
 *   "Unable to deserialize cloned data due to invalid or unsupported version."
 *
 * spawnSync blocks the event loop, preventing the test runner from processing
 * its IPC messages. Uses the native promisified execFile to keep the event loop
 * free while collecting stdout/stderr.
 */

import {
	type ExecFileException,
	execFile as execFileCb,
	spawn,
} from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

// Strict allowlist of binaries this test utility is permitted to invoke.
// Callers pass a bare command name; the allowlist prevents an unexpected
// absolute path or uncontrolled value from being spawned. This also satisfies
// CodeQL's "Shell command built from environment values" query by sanitising
// the taint flow into `command`.
const ALLOWED_COMMANDS = new Set(["node", "sh", "bash", "zsh", "fish"]);

function assertAllowedCommand(command: string): void {
	if (!ALLOWED_COMMANDS.has(command)) {
		throw new Error(
			`Unsafe command: ${JSON.stringify(command)} is not in the allowlist`,
		);
	}
}

function assertNoNul(value: string, fieldName: string): void {
	// NUL terminates argv/envp on POSIX, so it corrupts process invocation.
	if (value.includes("\u0000")) {
		throw new Error(`Unsafe ${fieldName}: contains NUL byte`);
	}
}

function assertNoControlChars(value: string, fieldName: string): void {
	// For command and cwd, also reject newlines/CR that can confuse path handling
	// and downstream shell invocations that may embed them into scripts.
	if (
		value.includes("\u0000") ||
		value.includes("\n") ||
		value.includes("\r")
	) {
		throw new Error(
			`Unsafe ${fieldName}: contains disallowed control characters`,
		);
	}
}

/**
 * Options accepted by the spawn helpers.
 *
 * `color` opts the child *in* to colored output. By default the helpers
 * neutralise color-forcing environment variables (see {@link resolveSpawnEnv})
 * so output is deterministic regardless of the developer's shell. Set
 * `color: true` only for the rare test that asserts ANSI escapes are present.
 */
export interface SpawnOptions {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	timeout?: number;
	color?: boolean;
}

/**
 * Build the environment passed to a spawned child.
 *
 * Unless `color: true` is requested, this strips the color-forcing variables
 * (`FORCE_COLOR`, `CLICOLOR_FORCE`, `CLICOLOR`) inherited from the caller's
 * shell and sets `NO_COLOR=1`. `node:util`'s `styleText` (and the CLI's
 * formatters built on it) only emit ANSI escapes when the stream reports color
 * support; a developer who exports `FORCE_COLOR` would otherwise force color
 * into the piped child and break assertions that match plain text (e.g.
 * `/\swarning\s/` or `^\s+ID\s+…`). CI doesn't set those variables, so this
 * keeps local runs deterministic and aligned with CI.
 *
 * When `color: true`, the caller's env is passed through untouched so tests
 * that explicitly set `FORCE_COLOR` can assert on the escapes.
 */
function resolveSpawnEnv(options?: SpawnOptions): NodeJS.ProcessEnv {
	const base = options?.env ?? process.env;
	if (options?.color) {
		return { ...base };
	}
	const env: NodeJS.ProcessEnv = { ...base, NO_COLOR: "1" };
	delete env.FORCE_COLOR;
	delete env.CLICOLOR_FORCE;
	delete env.CLICOLOR;
	return env;
}

function validateSpawnInputs(
	command: string,
	args: string[],
	options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number },
): void {
	assertAllowedCommand(command);
	assertNoControlChars(command, "command");

	// args may legitimately contain newlines (e.g. `bash -c "multi\nline"`);
	// only NUL bytes are truly unsafe.
	for (const [index, arg] of args.entries()) {
		assertNoNul(arg, `args[${index}]`);
	}

	if (options?.cwd !== undefined) {
		assertNoControlChars(options.cwd, "cwd");
	}

	if (options?.env) {
		for (const [key, value] of Object.entries(options.env)) {
			assertNoControlChars(key, `env key (${key})`);
			if (typeof value === "string") {
				assertNoNul(value, `env value (${key})`);
			}
		}
	}

	if (options?.timeout !== undefined) {
		if (
			typeof options.timeout !== "number" ||
			!Number.isFinite(options.timeout) ||
			options.timeout < 0 ||
			!Number.isSafeInteger(options.timeout)
		) {
			throw new Error(
				`Unsafe timeout: must be a non-negative safe integer (got ${String(options.timeout)})`,
			);
		}
	}
}

export interface SpawnResult {
	stdout: string;
	stderr: string;
	status: number | null;
}

export async function asyncSpawn(
	command: string,
	args: string[],
	options?: SpawnOptions,
): Promise<SpawnResult> {
	const env = resolveSpawnEnv(options);
	validateSpawnInputs(command, args, { ...options, env });
	try {
		const { stdout, stderr } = await execFile(command, args, {
			cwd: options?.cwd,
			env,
			maxBuffer: 10 * 1024 * 1024,
			...(options?.timeout !== undefined ? { timeout: options.timeout } : {}),
		});
		return { stdout: stdout ?? "", stderr: stderr ?? "", status: 0 };
	} catch (err) {
		// biome-ignore lint/plugin: unavoidable narrowing of catch-clause unknown to ExecFileException
		const e = err as ExecFileException & { stdout?: string; stderr?: string };
		return {
			stdout: e.stdout ?? "",
			stderr: e.stderr ?? "",
			status: typeof e.code === "number" ? e.code : 1,
		};
	}
}

/**
 * Spawn variant that lets callers drive stdin programmatically — needed
 * for testing pipeline behaviour (slow producers, multi-chunk writes).
 * The `writeStdin` callback receives the child's stdin stream and is
 * awaited before stdin is closed via end().
 */
export async function asyncSpawnWithStdin(
	command: string,
	args: string[],
	writeStdin: (stdin: NodeJS.WritableStream) => void | Promise<void>,
	options?: SpawnOptions,
): Promise<SpawnResult> {
	const env = resolveSpawnEnv(options);
	validateSpawnInputs(command, args, { ...options, env });
	const child = spawn(command, args, {
		stdio: ["pipe", "pipe", "pipe"],
		cwd: options?.cwd,
		env,
		...(options?.timeout !== undefined ? { timeout: options.timeout } : {}),
	});

	let stdout = "";
	let stderr = "";
	child.stdout?.setEncoding("utf-8");
	child.stderr?.setEncoding("utf-8");
	child.stdout?.on("data", (chunk: string) => {
		stdout += chunk;
	});
	child.stderr?.on("data", (chunk: string) => {
		stderr += chunk;
	});

	const stdin = child.stdin;
	if (!stdin) throw new Error("child has no stdin");
	stdin.on("error", (err: NodeJS.ErrnoException) => {
		if (err.code === "EPIPE") {
			// EPIPE is expected: the child may close stdin before we finish writing
			// (e.g. when the command rejects input early). Surfacing it would
			// mask the real test signal in stderr/exit.
			return;
		}
		// All other stdin errors are real failures; surface them in stderr so
		// they are visible in test output rather than silently swallowed.
		stderr += `stdin error: ${err.message}\n`;
	});

	// Create the close/error promise BEFORE awaiting writeStdin so we don't
	// miss the 'close' event if the child exits early (e.g. rejects input
	// immediately). Any buffered 'close' emission will be captured by the
	// already-registered listener rather than being lost between the two awaits.
	const statusPromise = new Promise<number | null>((resolve, reject) => {
		child.on("close", (code) => resolve(code));
		child.on("error", (err) => {
			stderr += `${err.message}\n`;
			reject(err);
		});
	});

	try {
		await writeStdin(stdin);
	} finally {
		stdin.end();
	}

	const status = await statusPromise;

	return { stdout, stderr, status };
}
