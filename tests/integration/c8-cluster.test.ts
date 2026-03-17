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

  test('start/stop commands require c8-cluster resource', () => {
    // Test 'start' without resource
    const resultStart = spawnSync('node', ['--experimental-strip-types', CLI_PATH, 'start'], {
      encoding: 'utf-8',
      stdio: 'pipe',
    });

    // Should show error about unknown command or missing resource
    assert.ok(
      resultStart.stderr.includes('Unknown command: start') ||
      resultStart.stdout.includes('Unknown command: start'),
      'start without resource should show unknown command error'
    );

    // Test 'stop' without resource
    const resultStop = spawnSync('node', ['--experimental-strip-types', CLI_PATH, 'stop'], {
      encoding: 'utf-8',
      stdio: 'pipe',
    });

    // Should show error about unknown command or missing resource
    assert.ok(
      resultStop.stderr.includes('Unknown command: stop') ||
      resultStop.stdout.includes('Unknown command: stop'),
      'stop without resource should show unknown command error'
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

  test('help includes --debug flag for start c8-cluster', () => {
    const result = spawnSync('node', ['--experimental-strip-types', CLI_PATH, 'help'], {
      encoding: 'utf-8',
      stdio: 'pipe',
    });

    assert.strictEqual(result.status, 0, 'Help command should succeed');
    assert.ok(result.stdout.includes('--debug'), 'Help should mention --debug flag');
  });

  test('bash completion includes --debug flag', () => {
    const result = spawnSync('node', ['--experimental-strip-types', CLI_PATH, 'completion', 'bash'], {
      encoding: 'utf-8',
      stdio: 'pipe',
    });

    assert.strictEqual(result.status, 0, 'Bash completion should succeed');
    assert.ok(result.stdout.includes('--debug'), 'Bash completion should include --debug flag');
  });

  test('zsh completion includes --debug flag', () => {
    const result = spawnSync('node', ['--experimental-strip-types', CLI_PATH, 'completion', 'zsh'], {
      encoding: 'utf-8',
      stdio: 'pipe',
    });

    assert.strictEqual(result.status, 0, 'Zsh completion should succeed');
    assert.ok(result.stdout.includes('--debug'), 'Zsh completion should include --debug flag');
  });

  test('fish completion includes --debug flag', () => {
    const result = spawnSync('node', ['--experimental-strip-types', CLI_PATH, 'completion', 'fish'], {
      encoding: 'utf-8',
      stdio: 'pipe',
    });

    assert.strictEqual(result.status, 0, 'Fish completion should succeed');
    assert.ok(result.stdout.includes('--debug'), 'Fish completion should include --debug flag');
  });
});
