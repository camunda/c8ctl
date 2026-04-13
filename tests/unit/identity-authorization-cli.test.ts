/**
 * CLI behavioral tests for identity authorization commands.
 *
 * These tests exercise the full dispatch path by spawning the CLI
 * as a subprocess with --dry-run. They verify that CLI flags flow
 * correctly through index.ts dispatch → validation → handler → JSON output.
 *
 * This catches wiring regressions in index.ts (e.g., missing str(values.X))
 * that direct-call unit tests cannot detect.
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
      // Suppress any profile file lookup
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

// ─── create authorization ────────────────────────────────────────────────────

describe('CLI behavioral: create authorization', () => {

  test('--dry-run emits correct JSON body shape with all fields', async () => {
    const result = await c8(
      'create', 'authorization',
      '--dry-run',
      '--ownerId', 'alice',
      '--ownerType', 'USER',
      '--resourceType', 'PROCESS_DEFINITION',
      '--resourceId', 'my-process',
      '--permissions', 'READ,UPDATE',
    );

    assert.strictEqual(result.status, 0, `CLI exited with ${result.status}\nstderr: ${result.stderr}`);
    const out = parseJson(result);

    assert.strictEqual(out.dryRun, true);
    assert.strictEqual(out.method, 'POST');
    assert.ok((out.url as string).endsWith('/authorizations'));

    const body = out.body as Record<string, unknown>;
    assert.strictEqual(body.ownerId, 'alice');
    assert.strictEqual(body.ownerType, 'USER');
    assert.strictEqual(body.resourceType, 'PROCESS_DEFINITION');
    assert.strictEqual(body.resourceId, 'my-process');
    assert.deepStrictEqual(body.permissionTypes, ['READ', 'UPDATE']);
  });

  test('--dry-run trims whitespace in permissions CSV', async () => {
    const result = await c8(
      'create', 'authorization',
      '--dry-run',
      '--ownerId', 'bob',
      '--ownerType', 'CLIENT',
      '--resourceType', 'DECISION_DEFINITION',
      '--resourceId', '*',
      '--permissions', ' READ , UPDATE , DELETE ',
    );

    assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    const body = parseJson(result).body as Record<string, unknown>;
    assert.deepStrictEqual(body.permissionTypes, ['READ', 'UPDATE', 'DELETE']);
  });

  test('rejects invalid --ownerType with exit code 1', async () => {
    const result = await c8(
      'create', 'authorization',
      '--ownerId', 'alice',
      '--ownerType', 'BOGUS',
      '--resourceType', 'PROCESS_DEFINITION',
      '--resourceId', 'r',
      '--permissions', 'READ',
    );

    assert.strictEqual(result.status, 1);
    assert.ok(result.stderr.includes('Invalid --ownerType "BOGUS"'), `stderr: ${result.stderr}`);
    assert.ok(result.stderr.includes('Valid values:'), `stderr: ${result.stderr}`);
  });

  test('rejects invalid --resourceType with exit code 1', async () => {
    const result = await c8(
      'create', 'authorization',
      '--ownerId', 'alice',
      '--ownerType', 'USER',
      '--resourceType', 'NOPE',
      '--resourceId', 'r',
      '--permissions', 'READ',
    );

    assert.strictEqual(result.status, 1);
    assert.ok(result.stderr.includes('Invalid --resourceType "NOPE"'), `stderr: ${result.stderr}`);
  });

  test('rejects invalid --permissions with exit code 1', async () => {
    const result = await c8(
      'create', 'authorization',
      '--ownerId', 'alice',
      '--ownerType', 'USER',
      '--resourceType', 'PROCESS_DEFINITION',
      '--resourceId', 'r',
      '--permissions', 'READ,BOGUS',
    );

    assert.strictEqual(result.status, 1);
    assert.ok(result.stderr.includes('Invalid --permissions: BOGUS'), `stderr: ${result.stderr}`);
  });

  test('rejects missing --ownerId with exit code 1', async () => {
    const result = await c8(
      'create', 'authorization',
      '--ownerType', 'USER',
      '--resourceType', 'PROCESS_DEFINITION',
      '--resourceId', 'r',
      '--permissions', 'READ',
    );

    assert.strictEqual(result.status, 1);
    assert.ok(result.stderr.includes('--ownerId is required'), `stderr: ${result.stderr}`);
  });

  test('rejects missing --permissions with exit code 1', async () => {
    const result = await c8(
      'create', 'authorization',
      '--ownerId', 'alice',
      '--ownerType', 'USER',
      '--resourceType', 'PROCESS_DEFINITION',
      '--resourceId', 'r',
    );

    assert.strictEqual(result.status, 1);
    assert.ok(result.stderr.includes('--permissions is required'), `stderr: ${result.stderr}`);
  });
});

// ─── delete authorization ────────────────────────────────────────────────────

describe('CLI behavioral: delete authorization', () => {

  test('--dry-run emits DELETE to /authorizations/:key', async () => {
    const result = await c8(
      'delete', 'authorization',
      '--dry-run',
      'auth-key-42',
    );

    assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    const out = parseJson(result);
    assert.strictEqual(out.dryRun, true);
    assert.strictEqual(out.method, 'DELETE');
    assert.ok((out.url as string).endsWith('/authorizations/auth-key-42'));
  });
});
