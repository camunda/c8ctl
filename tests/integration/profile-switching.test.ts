/**
 * Integration tests for profile switching
 * Tests the reflective c8 design - verifying that profile changes are reflected in operations
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pollUntil } from '../utils/polling.ts';
import { asyncSpawn } from '../utils/spawn.ts';

const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..');
const CLI = join(PROJECT_ROOT, 'src', 'index.ts');

function cli(dataDir: string, ...args: string[]) {
  return asyncSpawn('node', ['--experimental-strip-types', CLI, ...args], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, C8CTL_DATA_DIR: dataDir } as NodeJS.ProcessEnv,
  });
}

describe('Profile Switching Integration Tests', () => {
  let testDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'c8ctl-profile-switch-test-'));
    originalEnv = { ...process.env };
    process.env.C8CTL_DATA_DIR = testDir;

    // Create test profiles in-process (CLI `add profile` doesn't wire --username/--password)
    const { addProfile } = await import('../../src/config.ts');

    addProfile({
      name: 'one',
      baseUrl: 'http://localhost:8080',
      username: 'demo',
      password: 'demo',
    });

    addProfile({
      name: 'two',
      baseUrl: 'http://localhost:8080',
      username: 'demo',
      password: 'demo',
    });

    addProfile({
      name: 'invalid',
      baseUrl: 'http://localhost:9999',
      username: 'fake-user',
      password: 'fake-password',
    });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    process.env = originalEnv;
  });

  test('profile switching affects deployment and queries', async () => {
    // Step 1: Use profile "one" and deploy
    await cli(testDir, 'use', 'profile', 'one');
    await cli(testDir, 'deploy', 'tests/fixtures/list-pis/min-usertask.bpmn');

    // Create a process instance 
    await cli(testDir, 'create', 'pi', '--id', 'Process_0t60ay7');

    // Poll for Elasticsearch indexing
    const instanceFound = await pollUntil(async () => {
      const result = await cli(testDir, 'list', 'pi', '--id', 'Process_0t60ay7', '--all', '--output', 'json');
      return result.status === 0 && result.stdout.trim().length > 2;
    }, 10000, 200);
    assert.ok(instanceFound, 'Process instance should be indexed');

    // Step 2: Switch to profile "two" and list
    await cli(testDir, 'use', 'profile', 'two');

    const result = await cli(testDir, 'list', 'pi', '--id', 'Process_0t60ay7', '--all');
    assert.strictEqual(result.status, 0, `List should succeed with profile two. stderr: ${result.stderr}`);
    const output = result.stdout.trim();
    assert.ok(output.length > 0, 'Should have output from list command');

    // Since both profiles point to the same cluster, we should see the process instance
    assert.ok(
      output.includes('Process_0t60ay7') || output.includes('No process instances found'),
      'Should either show process instances or none found',
    );
  });

  test('invalid profile causes connection error', async () => {
    const useResult = await cli(testDir, 'use', 'profile', 'invalid');
    assert.strictEqual(useResult.status, 0, 'CLI should activate invalid profile');
    assert.ok(useResult.stdout.includes('Now using profile: invalid') || useResult.stderr.includes('Now using profile: invalid'), 'CLI should confirm profile switch');

    const listResult = await cli(testDir, 'list', 'pi', '--id', 'Process_0t60ay7');
    assert.notStrictEqual(listResult.status, 0, 'CLI should exit with non-zero status for invalid profile');
    const combinedOutput = `${listResult.stdout}\n${listResult.stderr}`;
    assert.ok(
      combinedOutput.includes('Failed to list process instances') ||
      combinedOutput.includes('ECONNREFUSED') ||
      combinedOutput.includes('connect') ||
      combinedOutput.includes('fetch failed'),
      `Error should mention connection failure. Got: ${combinedOutput}`,
    );
  });

  test('switching profiles affects cluster resolution', async () => {
    const { useProfile } = await import('../../src/commands/session.ts');
    const { resolveClusterConfig } = await import('../../src/config.ts');
    const { c8ctl } = await import('../../src/runtime.ts');
    
    // Use profile "one"
    useProfile('one');
    let config = resolveClusterConfig();
    assert.strictEqual(config.baseUrl, 'http://localhost:8080', 'Should use profile one baseUrl');
    assert.strictEqual(config.username, 'demo', 'Should use profile one username');
    
    // Switch to profile "two"
    useProfile('two');
    config = resolveClusterConfig();
    assert.strictEqual(config.baseUrl, 'http://localhost:8080', 'Should use profile two baseUrl');
    assert.strictEqual(config.username, 'demo', 'Should use profile two username');
    assert.strictEqual(c8ctl.activeProfile, 'two', 'Profile two should be active');
    
    // Switch to invalid profile
    useProfile('invalid');
    config = resolveClusterConfig();
    assert.strictEqual(config.baseUrl, 'http://localhost:9999', 'Should use invalid profile baseUrl');
    assert.strictEqual(config.username, 'fake-user', 'Should use invalid profile username');
    assert.strictEqual(c8ctl.activeProfile, 'invalid', 'Invalid profile should be active');
  });
});
