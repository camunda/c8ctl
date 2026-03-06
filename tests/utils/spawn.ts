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

import { execFile as execFileCb, type ExecFileException } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

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
  try {
    const { stdout, stderr } = await execFile(command, args, {
      ...options,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { stdout: stdout ?? '', stderr: stderr ?? '', status: 0 };
  } catch (err) {
    const e = err as ExecFileException & { stdout?: string; stderr?: string };
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      status: typeof e.code === 'number' ? e.code : 1,
    };
  }
}
