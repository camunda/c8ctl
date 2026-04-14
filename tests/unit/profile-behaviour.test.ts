/**
 * CLI behavioural tests for profile and use commands.
 *
 * These tests exercise the full dispatch path by spawning the CLI
 * as a subprocess. They verify that profile listing and the use
 * command produce expected output and exit codes.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { c8 } from '../utils/cli.ts';

// ─── list profiles ──────────────────────────────────────────────────────────

describe('CLI behavioural: list profiles', () => {

  test('exits 0 and includes the built-in local profile', async () => {
    const result = await c8('list', 'profiles');
    assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    assert.ok(result.stdout.includes('local'), 'Expected "local" profile');
  });

  test('shows URL column header', async () => {
    const result = await c8('list', 'profiles');
    assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    assert.ok(result.stdout.includes('URL'), 'Expected "URL" column header');
  });
});

// ─── use (without resource) ─────────────────────────────────────────────────

describe('CLI behavioural: use command', () => {

  test('exits 1 and shows available resources when no resource given', async () => {
    const result = await c8('use');
    assert.strictEqual(result.status, 1, `stderr: ${result.stderr}`);
    assert.ok(
      result.stdout.includes('profile') || result.stderr.includes('profile'),
      'Expected "profile" in available resources',
    );
  });
});
