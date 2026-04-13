/**
 * CLI behavioural tests for incident commands.
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

// ─── resolve incident ────────────────────────────────────────────────────────

describe('CLI behavioural: resolve incident', () => {

  test('--dry-run emits POST to /incidents/:key/resolution', async () => {
    const result = await c8(
      'resolve', 'incident',
      '--dry-run',
      '77777',
    );

    assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    const out = parseJson(result);

    assert.strictEqual(out.dryRun, true);
    assert.strictEqual(out.method, 'POST');
    assert.ok((out.url as string).includes('/incidents/77777/resolution'));
  });

  test('--dry-run works with inc alias', async () => {
    const result = await c8(
      'resolve', 'inc',
      '--dry-run',
      '77777',
    );

    assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    const out = parseJson(result);
    assert.strictEqual(out.dryRun, true);
    assert.ok((out.url as string).includes('/incidents/77777/resolution'));
  });

  test('rejects missing incident key with exit code 1', async () => {
    const result = await c8(
      'resolve', 'inc',
    );

    assert.strictEqual(result.status, 1);
    assert.ok(
      result.stderr.includes('Incident key required'),
      `stderr: ${result.stderr}`,
    );
  });
});
