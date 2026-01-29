/**
 * Integration tests for profile switching
 * Tests the reflective c8 design - verifying that profile changes are reflected in operations
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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
    
    // Wait for Elasticsearch indexing
    await new Promise(resolve => setTimeout(resolve, 2000));
    
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
    const { useProfile } = await import('../../src/commands/session.ts');
    const { listProcessInstances } = await import('../../src/commands/process-instances.ts');
    const { c8ctl } = await import('../../src/runtime.ts');
    
    // Use the invalid profile
    useProfile('invalid');
    assert.strictEqual(c8ctl.activeProfile, 'invalid', 'Invalid profile should be active');
    
    // Capture stderr to check for errors
    const originalError = console.error;
    const originalExit = process.exit;
    let capturedErrors: string[] = [];
    let exitCalled = false;
    let exitCode: number | undefined;
    
    console.error = (...args: any[]) => {
      capturedErrors.push(args.join(' '));
    };
    
    process.exit = ((code?: number) => {
      exitCalled = true;
      exitCode = code;
      throw new Error('process.exit called');
    }) as any;
    
    try {
      // Attempt to list process instances - should fail
      await listProcessInstances({
        processDefinitionId: 'Process_0t60ay7',
      });
      
      assert.fail('Should have thrown an error or called process.exit');
    } catch (error: any) {
      // We expect either process.exit to be called or an error to be thrown
      const errorOutput = capturedErrors.join('\n');
      
      if (error.message === 'process.exit called') {
        // process.exit was called, which is expected
        assert.ok(exitCalled, 'process.exit should have been called');
        assert.strictEqual(exitCode, 1, 'Exit code should be 1');
        assert.ok(errorOutput.length > 0, 'Should have error output');
        assert.ok(
          errorOutput.includes('Failed to list process instances') ||
          errorOutput.includes('ECONNREFUSED') ||
          errorOutput.includes('connect'),
          `Error should mention connection failure. Got: ${errorOutput}`
        );
      } else {
        // An error was thrown, which is also acceptable
        assert.ok(
          error.message.includes('ECONNREFUSED') ||
          error.message.includes('connect') ||
          error.message.includes('Failed'),
          `Error should mention connection failure. Got: ${error.message}`
        );
      }
    } finally {
      console.error = originalError;
      process.exit = originalExit;
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
