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

import { execFile as execFileCb, spawn } from "node:child_process";

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

/**
 * Outcome of a spawned child.
 *
 * `status` is the exit code, or `null` when the child was terminated by a
 * signal. `timedOut` is true when the helper itself killed the child because
 * it exceeded `timeout`; stderr then ends with an explicit "timed out" note so
 * an assertion that prints stderr names the real cause instead of reading like
 * an ordinary non-zero exit. `timedOut` is tracked independently of the final
 * exit code/signal: a child that installs a SIGTERM handler and then exits 0 or
 * 1 of its own accord is still reported as timed out, with its actual exit
 * `status`/`signal` preserved.
 */
export interface SpawnResult {
	stdout: string;
	stderr: string;
	status: number | null;
	signal: NodeJS.Signals | null;
	timedOut: boolean;
}

/** Note appended to stderr when the helper killed the child on timeout. */
function timeoutNote(timeout: number | undefined, signal: string): string {
	return `\n[spawn helper] child timed out after ${timeout} ms and was killed with ${signal}\n`;
}

export async function asyncSpawn(
	command: string,
	args: string[],
	options?: SpawnOptions,
): Promise<SpawnResult> {
	const env = resolveSpawnEnv(options);
	validateSpawnInputs(command, args, { ...options, env });
	return await new Promise<SpawnResult>((resolve) => {
		const child = execFileCb(
			command,
			args,
			{
				cwd: options?.cwd,
				env,
				maxBuffer: 10 * 1024 * 1024,
				...(options?.timeout !== undefined ? { timeout: options.timeout } : {}),
			},
			(err, stdout, stderr) => {
				// This helper never calls kill() itself, so `child.killed` is true
				// only when execFile's own `timeout` killed the child. Key the
				// diagnostic on it rather than on a terminal signal: a child that
				// handles the timeout's SIGTERM and exits normally closes with a
				// null signal (and exit code 0 or 1), yet it was still timed out.
				const timedOut = child.killed === true;
				const signal = err?.signal ?? null;
				const status =
					err === null
						? 0
						: typeof err.code === "number"
							? err.code
							: signal
								? null
								: 1;
				resolve({
					stdout: stdout ?? "",
					stderr:
						(stderr ?? "") +
						(timedOut
							? timeoutNote(options?.timeout, signal ?? "SIGTERM")
							: ""),
					status,
					signal,
					timedOut,
				});
			},
		);
	});
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
	const statusPromise = new Promise<{
		code: number | null;
		signal: NodeJS.Signals | null;
	}>((resolve, reject) => {
		child.on("close", (code, signal) => resolve({ code, signal }));
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

	const { code, signal } = await statusPromise;
	// spawn()'s `timeout` kills via `child.kill()`, which sets `killed`; this
	// helper never calls kill() for any other reason, so `killed` alone marks a
	// timeout. A child that handles SIGTERM and exits normally closes with a
	// null signal (and exit code 0 or 1) but is still a timeout, so do not
	// require a terminal signal here.
	const timedOut = child.killed;
	if (timedOut) stderr += timeoutNote(options?.timeout, signal ?? "SIGTERM");

	return { stdout, stderr, status: code, signal, timedOut };
}
