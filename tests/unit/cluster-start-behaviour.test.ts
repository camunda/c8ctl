/**
 * CLI behavioural smoke tests for `c8ctl cluster start`.
 *
 * These tests exercise the full dispatch path by spawning the CLI
 * as a subprocess. They verify that error output is clear and actionable
 * when cluster startup fails.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { c8 } from '../utils/cli.ts';

describe('CLI behavioural: cluster start failure', () => {

  test('start with nonexistent version exits with error and logs actionable message', async () => {
    const result = await c8('cluster', 'start', '--c8-version', '0.0.0-nonexistent');

    assert.notStrictEqual(result.status, 0, 'Should exit with non-zero status');
    const combined = result.stdout + result.stderr;
    assert.ok(
      combined.includes('Failed to start cluster'),
      `Expected "Failed to start cluster" in output, got:\n${combined}`,
    );
    assert.ok(
      combined.includes('check the version exists') || combined.includes('try a different version'),
      `Expected actionable hint in output, got:\n${combined}`,
    );
  });
});
