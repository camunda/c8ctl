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

function validateSpawnInputs(
	command: string,
	args: string[],
	options?: { cwd?: string; env?: NodeJS.ProcessEnv },
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
}

export interface SpawnResult {
	stdout: string;
	stderr: string;
	status: number | null;
}

export async function asyncSpawn(
	command: string,
	args: string[],
	options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number },
): Promise<SpawnResult> {
	validateSpawnInputs(command, args, options);
	try {
		const { stdout, stderr } = await execFile(command, args, {
			...options,
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
