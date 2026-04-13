/**
 * CLI behavioural tests for the --fields agent flag.
 *
 * These tests exercise the full dispatch path by spawning the CLI
 * as a subprocess with --dry-run and --fields. They verify that
 * the --fields flag filters the JSON output keys end-to-end.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { c8, parseJson } from '../utils/cli.ts';

// ─── --fields filters dry-run output ─────────────────────────────────────────

describe('CLI behavioural: --fields flag', () => {

  test('filters dry-run output to only requested keys', async () => {
    const result = await c8(
      'list', 'pi', '--dry-run',
      '--fields', 'method,url',
    );

    assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    const out = parseJson(result);

    // Requested fields should be present
    assert.ok('method' in out, 'Expected "method" in output');
    assert.ok('url' in out, 'Expected "url" in output');

    // Non-requested fields should be filtered out
    assert.ok(!('dryRun' in out), 'Expected "dryRun" to be filtered out');
    assert.ok(!('command' in out), 'Expected "command" to be filtered out');
    assert.ok(!('body' in out), 'Expected "body" to be filtered out');
  });

  test('field matching is case-insensitive', async () => {
    const result = await c8(
      'list', 'pd', '--dry-run',
      '--fields', 'Method,URL',
    );

    assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    const out = parseJson(result);
    // Keys should still appear (case-insensitive match)
    const keys = Object.keys(out);
    assert.ok(
      keys.some(k => k.toLowerCase() === 'method'),
      `Expected a "method" key (case-insensitive), got: ${keys}`,
    );
    assert.ok(
      keys.some(k => k.toLowerCase() === 'url'),
      `Expected a "url" key (case-insensitive), got: ${keys}`,
    );
  });

  test('single field returns only that key', async () => {
    const result = await c8(
      'get', 'pi', '--dry-run', '12345',
      '--fields', 'url',
    );

    assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    const out = parseJson(result);
    const keys = Object.keys(out);
    assert.strictEqual(keys.length, 1, `Expected 1 key, got ${keys.length}: ${keys}`);
    assert.ok(
      keys[0].toLowerCase() === 'url',
      `Expected "url", got "${keys[0]}"`,
    );
  });

  test('works with search commands and filters', async () => {
    const result = await c8(
      'search', 'pi', '--dry-run',
      '--state', 'ACTIVE',
      '--fields', 'method,body',
    );

    assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    const out = parseJson(result);

    assert.ok('method' in out, 'Expected "method"');
    assert.ok('body' in out, 'Expected "body"');
    assert.ok(!('url' in out), 'Expected "url" to be filtered out');
    assert.ok(!('dryRun' in out), 'Expected "dryRun" to be filtered out');
  });

  test('handles whitespace in comma-separated fields', async () => {
    const result = await c8(
      'list', 'ut', '--dry-run',
      '--fields', ' method , url ',
    );

    assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    const out = parseJson(result);
    assert.ok('method' in out || 'url' in out, 'Expected at least one matched field');
    assert.ok(!('dryRun' in out), 'Expected "dryRun" to be filtered out');
  });
});
