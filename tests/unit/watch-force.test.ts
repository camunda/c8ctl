/**
 * Unit tests for watch --force mode
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

describe('Watch Force Mode', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `c8ctl-watch-force-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  test('help watch shows --force flag', () => {
    const result = spawnSync('node', [
      '--experimental-strip-types',
      join(process.cwd(), 'src/index.ts'),
      'help', 'watch',
    ], {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 5000,
      env: { ...process.env, C8CTL_DATA_DIR: testDir },
    });

    assert.ok(result.stdout.includes('--force'), 'help output should include --force flag');
    assert.ok(result.stdout.includes('Continue watching after deployment errors'),
      'help output should describe --force purpose');
  });

  test('help watch alias w shows --force flag', () => {
    const result = spawnSync('node', [
      '--experimental-strip-types',
      join(process.cwd(), 'src/index.ts'),
      'help', 'w',
    ], {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 5000,
      env: { ...process.env, C8CTL_DATA_DIR: testDir },
    });

    assert.ok(result.stdout.includes('--force'), 'help output for alias w should include --force flag');
  });

  test('watch --force shows force mode message', () => {
    // Create a temp directory with a dummy bpmn file to watch
    const watchDir = join(testDir, 'watch-test');
    mkdirSync(watchDir, { recursive: true });
    writeFileSync(join(watchDir, 'test.bpmn'), '<definitions/>');

    // Start watch --force and kill after getting initial output
    const result = spawnSync('node', [
      '--experimental-strip-types',
      join(process.cwd(), 'src/index.ts'),
      'watch', '--force', watchDir,
    ], {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 3000,
      env: { ...process.env, C8CTL_DATA_DIR: testDir },
    });

    // The watch command will timeout (exit due to timeout), but we should see the force mode message
    const output = (result.stdout || '') + (result.stderr || '');
    assert.ok(output.includes('Force mode'), 'watch --force should display force mode message');
  });

  test('watch without --force does not show force mode message', () => {
    const watchDir = join(testDir, 'watch-test');
    mkdirSync(watchDir, { recursive: true });
    writeFileSync(join(watchDir, 'test.bpmn'), '<definitions/>');

    const result = spawnSync('node', [
      '--experimental-strip-types',
      join(process.cwd(), 'src/index.ts'),
      'watch', watchDir,
    ], {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 3000,
      env: { ...process.env, C8CTL_DATA_DIR: testDir },
    });

    const output = (result.stdout || '') + (result.stderr || '');
    assert.ok(!output.includes('Force mode'), 'watch without --force should NOT display force mode message');
  });
});
