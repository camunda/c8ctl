/**
 * CLI behavioural tests for form, topology, and run commands.
 *
 * These tests exercise the full dispatch path by spawning the CLI
 * as a subprocess with --dry-run. They verify that the dry-run preview
 * emits the correct method, endpoint, and body for each command.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { c8, parseJson } from '../utils/cli.ts';

// ─── helpers ─────────────────────────────────────────────────────────────────

function assertDryRun(
  out: Record<string, unknown>,
  expected: { method: string; urlSuffix: string },
) {
  assert.strictEqual(out.dryRun, true);
  assert.strictEqual(out.method, expected.method);
  assert.ok(
    (out.url as string).endsWith(expected.urlSuffix),
    `Expected URL to end with "${expected.urlSuffix}", got "${out.url}"`,
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Topology
// ═══════════════════════════════════════════════════════════════════════════════

describe('CLI behavioural: get topology', () => {

  test('--dry-run emits GET to /topology', async () => {
    const result = await c8('get', 'topology', '--dry-run');
    assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    assertDryRun(parseJson(result), { method: 'GET', urlSuffix: '/topology' });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Forms
// ═══════════════════════════════════════════════════════════════════════════════

describe('CLI behavioural: get form', () => {

  test('--dry-run with --userTask emits GET to /user-tasks/<key>/form', async () => {
    const result = await c8('get', 'form', '12345', '--userTask', '--dry-run');
    assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    assertDryRun(parseJson(result), { method: 'GET', urlSuffix: '/user-tasks/12345/form' });
  });

  test('--dry-run with --ut alias emits GET to /user-tasks/<key>/form', async () => {
    const result = await c8('get', 'form', '99', '--ut', '--dry-run');
    assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    assertDryRun(parseJson(result), { method: 'GET', urlSuffix: '/user-tasks/99/form' });
  });

  test('--dry-run with --processDefinition emits GET to /process-definitions/<key>/form', async () => {
    const result = await c8('get', 'form', '67890', '--processDefinition', '--dry-run');
    assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    assertDryRun(parseJson(result), { method: 'GET', urlSuffix: '/process-definitions/67890/form' });
  });

  test('--dry-run with --pd alias emits GET to /process-definitions/<key>/form', async () => {
    const result = await c8('get', 'form', '42', '--pd', '--dry-run');
    assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    assertDryRun(parseJson(result), { method: 'GET', urlSuffix: '/process-definitions/42/form' });
  });

  test('--dry-run without type flag emits generic form lookup', async () => {
    const result = await c8('get', 'form', 'abc', '--dry-run');
    assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    const out = parseJson(result);
    assert.strictEqual(out.dryRun, true);
    assert.strictEqual(out.method, 'GET');
    // The generic form lookup tries user-tasks first, then process-definitions
    assert.ok(
      (out.url as string).includes('/user-tasks/abc/form'),
      `Expected URL to contain /user-tasks/abc/form, got "${out.url}"`,
    );
  });

  test('rejects missing key with exit code 1', async () => {
    const result = await c8('get', 'form', '--dry-run');
    assert.strictEqual(result.status, 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Run
// ═══════════════════════════════════════════════════════════════════════════════

describe('CLI behavioural: run', () => {

  test('--dry-run emits POST with path in body', async () => {
    const result = await c8('run', 'test.bpmn', '--dry-run');
    assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    const out = parseJson(result);
    assert.strictEqual(out.dryRun, true);
    assert.strictEqual(out.method, 'POST');
    assert.ok(
      (out.url as string).includes('/deployments'),
      `Expected URL to contain /deployments, got "${out.url}"`,
    );
    const body = out.body as Record<string, unknown>;
    assert.strictEqual(body.path, 'test.bpmn');
  });

  test('--dry-run includes variables in body', async () => {
    const result = await c8('run', 'test.bpmn', '--dry-run', '--variables', '{"x":1}');
    assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    const out = parseJson(result);
    assert.strictEqual(out.dryRun, true);
    const body = out.body as Record<string, unknown>;
    assert.strictEqual(body.path, 'test.bpmn');
    assert.strictEqual(body.variables, '{"x":1}');
  });

  test('shows usage when path is missing', async () => {
    const result = await c8('run');
    assert.strictEqual(result.status, 1);
    assert.ok(result.stdout.includes('Usage: c8ctl run'));
  });
});
