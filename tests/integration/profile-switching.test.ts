/**
 * Integration tests for profile switching
 * Tests the reflective c8 design - verifying that profile changes are reflected in operations
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pollUntil } from '../utils/polling.ts';

describe('Profile Switching Integration Tests', () => {
  let testDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'c8ctl-profile-switch-test-'));
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
    const { execSync } = await import('node:child_process');

    const useOutput = execSync('node src/index.ts use profile invalid', {
      encoding: 'utf8',
      cwd: process.cwd(),
      env: { ...process.env, C8CTL_DATA_DIR: testDir },
      stdio: 'pipe',
    });
    assert.ok(useOutput.includes('Now using profile: invalid'), 'CLI should activate invalid profile');

    try {
      execSync('node src/index.ts list pi --id Process_0t60ay7', {
        encoding: 'utf8',
        cwd: process.cwd(),
        env: { ...process.env, C8CTL_DATA_DIR: testDir },
        stdio: 'pipe',
      });
      assert.fail('CLI command should fail for invalid profile');
    } catch (error: any) {
      assert.notStrictEqual(error.status, 0, 'CLI should exit with non-zero status');
      const stderr = error.stderr ?? '';
      assert.ok(
        stderr.includes('Failed to list process instances') ||
        stderr.includes('ECONNREFUSED') ||
        stderr.includes('connect') ||
        stderr.includes('fetch failed'),
        `Error should mention connection failure. Got: ${stderr}`
      );
    }
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
