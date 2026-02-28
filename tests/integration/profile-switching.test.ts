/**
 * Integration tests for profile switching
 * Tests the reflective c8 design - verifying that profile changes are reflected in operations
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { pollUntil } from '../utils/polling.ts';

const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..');
const CLI = join(PROJECT_ROOT, 'src', 'index.ts');
const SPAWN_TIMEOUT_MS = 15_000;

describe('Profile Switching Integration Tests', () => {
  let testDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    testDir = join(tmpdir(), `c8ctl-profile-switch-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    originalEnv = { ...process.env };
    process.env.C8CTL_DATA_DIR = testDir;
    
    // Reset c8ctl runtime state before each test
    const { c8ctl } = await import('../../src/runtime.ts');
    c8ctl.activeProfile = undefined;
    c8ctl.activeTenant = undefined;
    c8ctl.outputMode = 'text';
    
    // Create test profiles
    const { addProfile } = await import('../../src/config.ts');
    
    // Profile "one" - valid localhost cluster
    addProfile({
      name: 'one',
      baseUrl: 'http://localhost:8080',
      username: 'demo',
      password: 'demo',
    });
    
    // Profile "two" - valid localhost cluster (same as one)
    addProfile({
      name: 'two',
      baseUrl: 'http://localhost:8080',
      username: 'demo',
      password: 'demo',
    });
    
    // Profile "invalid" - fake cluster with valid credentials format
    addProfile({
      name: 'invalid',
      baseUrl: 'http://localhost:9999', // Non-existent port
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
    const { deploy } = await import('../../src/commands/deployments.ts');
    const { useProfile } = await import('../../src/commands/session.ts');
    const { listProcessInstances } = await import('../../src/commands/process-instances.ts');
    const { createClient } = await import('../../src/client.ts');
    const { c8ctl } = await import('../../src/runtime.ts');
    
    // Step 1: Use profile "one"
    useProfile('one');
    assert.strictEqual(c8ctl.activeProfile, 'one', 'Profile one should be active');
    
    // Step 2: Deploy using profile "one"
    await deploy(['tests/fixtures/list-pis/min-usertask.bpmn'], {});
    
    // Create a process instance to ensure we have data
    const client = createClient();
    await client.createProcessInstance({
      processDefinitionId: 'Process_0t60ay7',
    });
    
    // Poll for Elasticsearch indexing
    const instanceFound = await pollUntil(
      async () => {
        try {
          const result = await client.searchProcessInstances({
            filter: { processDefinitionId: 'Process_0t60ay7' },
          }, { consistency: { waitUpToMs: 5000 } });
          return result.items && result.items.length > 0;
        } catch (error) {
          return false;
        }
      },
      10000,  // max 10 seconds
      200     // poll every 200ms
    );
    assert.ok(instanceFound, 'Process instance should be indexed');
    
    // Step 3: Switch to profile "two"
    useProfile('two');
    assert.strictEqual(c8ctl.activeProfile, 'two', 'Profile two should be active');
    
    // Step 4: List process instances using profile "two"
    // Capture stdout to verify the command works
    const originalLog = console.log;
    let capturedOutput: string[] = [];
    
    console.log = (...args: any[]) => {
      capturedOutput.push(args.join(' '));
    };
    
    try {
      await listProcessInstances({
        processDefinitionId: 'Process_0t60ay7',
      });
      
      // Verify we got output (meaning the query succeeded)
      const output = capturedOutput.join('\n');
      assert.ok(output.length > 0, 'Should have output from list command');
      
      // Since both profiles point to the same cluster, we should see the process instance
      assert.ok(
        output.includes('Process_0t60ay7') || output.includes('No process instances found'),
        'Should either show process instances or none found'
      );
      
      // Step 5: Verify profile "two" is still active
      assert.strictEqual(c8ctl.activeProfile, 'two', 'Profile two should still be active');
      
    } finally {
      console.log = originalLog;
    }
  });

  test('invalid profile causes connection error', async () => {
    // Use the CLI as a subprocess so that process.exit(1) happens in the child
    // process and does not interfere with the test runner.
    function cliWithProfile(...args: string[]) {
      return spawnSync('node', [CLI, ...args], {
        encoding: 'utf-8',
        cwd: PROJECT_ROOT,
        timeout: SPAWN_TIMEOUT_MS,
        env: { ...process.env, C8CTL_DATA_DIR: testDir },
      });
    }

    // Switch to the invalid profile in the isolated data dir
    const switchResult = cliWithProfile('use', 'profile', 'invalid');
    assert.strictEqual(
      switchResult.status, 0,
      `'use profile invalid' should succeed. stderr: ${switchResult.stderr}`,
    );

    // Attempting to list process instances with the invalid profile should fail
    const listResult = cliWithProfile('list', 'pi');
    assert.strictEqual(listResult.status, 1, 'list pi with invalid profile should exit with code 1');
    assert.ok(
      listResult.stderr.includes('Failed to list process instances') ||
      listResult.stderr.includes('ECONNREFUSED') ||
      listResult.stderr.includes('connect') ||
      listResult.stderr.includes('fetch failed'),
      `stderr should mention connection failure. Got: ${listResult.stderr}`,
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
