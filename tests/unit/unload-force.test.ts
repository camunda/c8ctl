/**
 * Unit tests for unload plugin --force mode
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { clearRegistryCache } from '../../src/plugin-registry.ts';

describe('Unload Plugin --force mode', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `c8ctl-unload-force-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    clearRegistryCache();
  });

  afterEach(() => {
    clearRegistryCache();
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  test('help plugin shows --force flag for unload', () => {
    const result = spawnSync('node', [
      '--experimental-strip-types',
      join(process.cwd(), 'src/index.ts'),
      'help', 'plugin',
    ], {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 5000,
      env: { ...process.env, C8CTL_DATA_DIR: testDir },
    });

    const output = result.stdout + result.stderr;
    assert.ok(output.includes('--force'), 'help plugin output should include --force flag');
    assert.ok(output.includes('unload plugin'), 'help plugin output should mention unload plugin');
  });

  test('unload plugin on non-existent plugin shows "neither registered nor installed" error', () => {
    // Plugin is not in the registry and not physically installed
    const result = spawnSync('node', [
      '--experimental-strip-types',
      join(process.cwd(), 'src/index.ts'),
      'unload', 'plugin', 'non-existent-plugin-xyz',
    ], {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 5000,
      env: { ...process.env, C8CTL_DATA_DIR: testDir },
    });

    const output = result.stdout + result.stderr;
    assert.ok(result.status !== 0, 'should exit with non-zero status');
    assert.ok(
      output.includes('neither registered nor installed'),
      'should show "neither registered nor installed" error'
    );
  });

  test('unload plugin --force on non-existent plugin still shows "neither registered nor installed" error', () => {
    // Even with --force, if the plugin is nowhere to be found, exit with error
    const result = spawnSync('node', [
      '--experimental-strip-types',
      join(process.cwd(), 'src/index.ts'),
      'unload', 'plugin', 'non-existent-plugin-xyz', '--force',
    ], {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 5000,
      env: { ...process.env, C8CTL_DATA_DIR: testDir },
    });

    const output = result.stdout + result.stderr;
    assert.ok(result.status !== 0, 'should exit with non-zero status even with --force');
    assert.ok(
      output.includes('neither registered nor installed'),
      'should show "neither registered nor installed" error even with --force'
    );
  });

  test('unload plugin without --force on limbo plugin (installed but not registered) shows limbo error', () => {
    // Simulate a limbo plugin: installed in node_modules but not in the registry
    const pluginsNodeModulesDir = join(testDir, 'plugins', 'node_modules', 'limbo-test-plugin');
    mkdirSync(pluginsNodeModulesDir, { recursive: true });
    writeFileSync(join(pluginsNodeModulesDir, 'c8ctl-plugin.js'), 'export const commands = {};');

    const result = spawnSync('node', [
      '--experimental-strip-types',
      join(process.cwd(), 'src/index.ts'),
      'unload', 'plugin', 'limbo-test-plugin',
    ], {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 5000,
      env: {
        ...process.env,
        C8CTL_DATA_DIR: testDir,
      },
    });

    const output = result.stdout + result.stderr;
    assert.ok(result.status !== 0, 'should exit with non-zero status');
    assert.ok(
      output.includes('limbo') || output.includes('not in the registry'),
      'should show limbo state error message'
    );
    assert.ok(
      output.includes('--force'),
      'should suggest using --force to resolve the limbo state'
    );
  });
});
