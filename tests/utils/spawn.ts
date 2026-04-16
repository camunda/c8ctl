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

function assertSafeProcessString(value: string, fieldName: string): void {
	// Reject control characters that can corrupt process invocation semantics.
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
	assertSafeProcessString(command, "command");

	for (const [index, arg] of args.entries()) {
		assertSafeProcessString(arg, `args[${index}]`);
	}

	if (options?.cwd !== undefined) {
		assertSafeProcessString(options.cwd, "cwd");
	}

	if (options?.env) {
		for (const [key, value] of Object.entries(options.env)) {
			assertSafeProcessString(key, `env key (${key})`);
			if (typeof value === "string") {
				assertSafeProcessString(value, `env value (${key})`);
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
	options?: { cwd?: string; env?: NodeJS.ProcessEnv },
): Promise<SpawnResult> {
	validateSpawnInputs(command, args, options);
	try {
		const { stdout, stderr } = await execFile(command, args, {
			...options,
			maxBuffer: 10 * 1024 * 1024,
		});
		return { stdout: stdout ?? "", stderr: stderr ?? "", status: 0 };
	} catch (err) {
		const e = err as ExecFileException & { stdout?: string; stderr?: string };
		return {
			stdout: e.stdout ?? "",
			stderr: e.stderr ?? "",
			status: typeof e.code === "number" ? e.code : 1,
		};
	}
}
