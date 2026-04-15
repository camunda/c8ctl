/**
 * Unit tests for `c8 output` command
 *
 * Exercises the CLI as a subprocess to match AGENTS.md conventions.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { asyncSpawn } from '../utils/spawn.ts';

const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..');
const CLI = join(PROJECT_ROOT, 'src', 'index.ts');

let dataDir = '';

function cli(...args: string[]) {
  return asyncSpawn('node', ['--experimental-strip-types', CLI, ...args], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, C8CTL_DATA_DIR: dataDir } as NodeJS.ProcessEnv,
  });
}

describe('c8 output', () => {
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'c8ctl-output-mode-test-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });
  test('shows current output mode when invoked with no arguments', async () => {
    const result = await cli('output');
    const output = result.stdout + result.stderr;

    assert.strictEqual(result.status, 0, `Expected exit 0, got ${result.status}. stderr: ${result.stderr}`);
    assert.ok(output.includes('Current output mode:'), `Expected current mode in output, got stdout: ${result.stdout}, stderr: ${result.stderr}`);
    assert.ok(output.includes('Available modes: json|text'), `Expected available modes in output, got stdout: ${result.stdout}, stderr: ${result.stderr}`);
  });

  test('sets output mode to json', async () => {
    const result = await cli('output', 'json');

    assert.strictEqual(result.status, 0, `Expected exit 0, got ${result.status}. stderr: ${result.stderr}`);
    // In json mode, success goes to stderr per unix convention
    const output = result.stdout + result.stderr;
    assert.ok(output.includes('Output mode set to: json'), `Expected confirmation, got stdout: ${result.stdout}, stderr: ${result.stderr}`);
  });

  test('sets output mode to text', async () => {
    const result = await cli('output', 'text');

    assert.strictEqual(result.status, 0, `Expected exit 0, got ${result.status}. stderr: ${result.stderr}`);
    assert.ok(result.stdout.includes('Output mode set to: text'), `Expected confirmation, got: ${result.stdout}`);
  });

  test('rejects invalid output mode', async () => {
    const result = await cli('output', 'yaml');

    assert.notStrictEqual(result.status, 0, 'Expected non-zero exit for invalid mode');
  });
});
