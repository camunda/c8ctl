/**
 * CLI behavioural tests for user-task commands.
 *
 * These tests exercise the full dispatch path by spawning the CLI
 * as a subprocess with --dry-run. They verify that CLI flags flow
 * correctly through index.ts dispatch → validation → handler → JSON output.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { asyncSpawn, type SpawnResult } from '../utils/spawn.ts';

const CLI = 'src/index.ts';

async function c8(...args: string[]): Promise<SpawnResult> {
  return asyncSpawn('node', ['--experimental-strip-types', CLI, ...args], {
    env: {
      ...process.env,
      CAMUNDA_BASE_URL: 'http://test-cluster/v2',
      HOME: '/tmp/c8ctl-test-nonexistent-home',
    },
  });
}

function parseJson(result: SpawnResult): Record<string, unknown> {
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`Failed to parse JSON from stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
}

// ─── complete user-task ──────────────────────────────────────────────────────

describe('CLI behavioural: complete user-task', () => {

  test('--dry-run emits POST to /user-tasks/:key/completion', async () => {
    const result = await c8(
      'complete', 'user-task',
      '--dry-run',
      '66666',
    );

    assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    const out = parseJson(result);

    assert.strictEqual(out.dryRun, true);
    assert.strictEqual(out.method, 'POST');
    assert.ok((out.url as string).includes('/user-tasks/66666/completion'));
  });

  test('--dry-run works with ut alias', async () => {
    const result = await c8(
      'complete', 'ut',
      '--dry-run',
      '66666',
    );

    assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    const out = parseJson(result);
    assert.strictEqual(out.dryRun, true);
    assert.ok((out.url as string).includes('/user-tasks/66666/completion'));
  });

  test('--dry-run includes variables when provided', async () => {
    const result = await c8(
      'complete', 'ut',
      '--dry-run',
      '66666',
      '--variables', '{"approved":true}',
    );

    assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    const body = parseJson(result).body as Record<string, unknown>;
    assert.deepStrictEqual(body.variables, { approved: true });
  });

  test('rejects missing user-task key with exit code 1', async () => {
    const result = await c8(
      'complete', 'ut',
    );

    assert.strictEqual(result.status, 1);
    assert.ok(
      result.stderr.includes('User task key required'),
      `stderr: ${result.stderr}`,
    );
  });
});
