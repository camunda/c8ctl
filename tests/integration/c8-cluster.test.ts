/**
 * Integration tests for c8-cluster command
 * NOTE: These tests verify the CLI interface and help output
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const CLI_PATH = join(process.cwd(), 'src', 'index.ts');

describe('c8-cluster Integration Tests', () => {
  test('c8-cluster command is available in help', () => {
    const result = spawnSync('node', ['--experimental-strip-types', CLI_PATH, 'help'], {
      encoding: 'utf-8',
      stdio: 'pipe',
    });

    assert.strictEqual(result.status, 0, 'Help command should succeed');
    assert.ok(result.stdout.includes('c8-cluster'), 'Help should mention c8-cluster command');
    assert.ok(
      result.stdout.includes('start') || result.stdout.includes('Start local Camunda'),
      'Help should mention start action'
    );
  });

  test('c8-cluster requires an action (start/stop)', () => {
    const result = spawnSync('node', ['--experimental-strip-types', CLI_PATH, 'c8-cluster'], {
      encoding: 'utf-8',
      stdio: 'pipe',
    });

    // Should show error about unknown action or require action
    assert.notStrictEqual(result.status, 0, 'c8-cluster without action should fail');
    assert.ok(
      result.stderr.includes('Unknown c8-cluster action') || result.stderr.includes('start') || result.stderr.includes('stop'),
      'Error should mention available actions'
    );
  });

  test('bash completion includes c8-cluster', () => {
    const result = spawnSync('node', ['--experimental-strip-types', CLI_PATH, 'completion', 'bash'], {
      encoding: 'utf-8',
      stdio: 'pipe',
    });

    assert.strictEqual(result.status, 0, 'Bash completion generation should succeed');
    assert.ok(result.stdout.includes('c8-cluster'), 'Bash completion should include c8-cluster');
    assert.ok(result.stdout.includes('start'), 'Bash completion should include start action');
    assert.ok(result.stdout.includes('stop'), 'Bash completion should include stop action');
  });

  test('zsh completion includes c8-cluster', () => {
    const result = spawnSync('node', ['--experimental-strip-types', CLI_PATH, 'completion', 'zsh'], {
      encoding: 'utf-8',
      stdio: 'pipe',
    });

    assert.strictEqual(result.status, 0, 'Zsh completion generation should succeed');
    assert.ok(result.stdout.includes('c8-cluster'), 'Zsh completion should include c8-cluster');
    assert.ok(result.stdout.includes('start'), 'Zsh completion should include start action');
    assert.ok(result.stdout.includes('stop'), 'Zsh completion should include stop action');
  });

  test('fish completion includes c8-cluster', () => {
    const result = spawnSync('node', ['--experimental-strip-types', CLI_PATH, 'completion', 'fish'], {
      encoding: 'utf-8',
      stdio: 'pipe',
    });

    assert.strictEqual(result.status, 0, 'Fish completion generation should succeed');
    assert.ok(result.stdout.includes('c8-cluster'), 'Fish completion should include c8-cluster');
    assert.ok(result.stdout.includes('start'), 'Fish completion should include start action');
    assert.ok(result.stdout.includes('stop'), 'Fish completion should include stop action');
  });
});
