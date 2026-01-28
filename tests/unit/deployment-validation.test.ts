/**
 * Unit tests for deployment command validation
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

describe('Deployment Validation', () => {
  let testDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    // Create isolated test directory for session/profile data
    testDir = join(tmpdir(), `c8ctl-deploy-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    originalEnv = { ...process.env };
    process.env.XDG_DATA_HOME = testDir;
    // Clear all Camunda env vars to ensure test isolation
    delete process.env.CAMUNDA_BASE_URL;
    delete process.env.CAMUNDA_CLIENT_ID;
    delete process.env.CAMUNDA_CLIENT_SECRET;
    delete process.env.CAMUNDA_AUDIENCE;
    delete process.env.CAMUNDA_OAUTH_URL;
    delete process.env.CAMUNDA_USERNAME;
    delete process.env.CAMUNDA_PASSWORD;
    delete process.env.CAMUNDA_DEFAULT_TENANT_ID;
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    process.env = originalEnv;
  });

  test('detects duplicate process IDs', () => {
    // Attempt to deploy directory with duplicate process IDs should fail
    try {
      execSync('npm run cli -- deploy tests/fixtures/duplicate-ids', {
        cwd: process.cwd(),
        encoding: 'utf-8',
        stdio: 'pipe',
        env: process.env
      });
      assert.fail('Should have thrown an error for duplicate process IDs');
    } catch (error: any) {
      const output = error.stdout + error.stderr;
      assert.match(output, /Cannot deploy.*Multiple files with the same process\/decision ID/, 
        'Should display error about duplicate IDs');
      assert.match(output, /duplicate-process-id/, 
        'Should mention the duplicate process ID');
      assert.match(output, /process-a\.bpmn/, 
        'Should mention first file with duplicate ID');
      assert.match(output, /process-b\.bpmn/, 
        'Should mention second file with duplicate ID');
    }
  });

  test('allows deployment when no duplicate IDs', () => {
    // This test requires a running Camunda instance
    // Just verify the command doesn't fail on validation (may fail on connection)
    try {
      execSync('npm run cli -- deploy tests/fixtures/simple.bpmn', {
        cwd: process.cwd(),
        encoding: 'utf-8',
        stdio: 'pipe',
        timeout: 5000,
        env: process.env
      });
      // If Camunda is running, this should succeed
      assert.ok(true);
    } catch (error: any) {
      // If it fails, it should be a connection error, not a validation error
      const output = error.stdout + error.stderr;
      assert.doesNotMatch(output, /Cannot deploy.*Multiple files/, 
        'Should not show duplicate ID error for single file');
    }
  });

  test('allows deployment of different process IDs', () => {
    // Deploy fixtures that have different process IDs
    try {
      execSync('npm run cli -- deploy tests/fixtures/sample-project', {
        cwd: process.cwd(),
        encoding: 'utf-8',
        stdio: 'pipe',
        timeout: 5000,
        env: process.env
      });
      // If Camunda is running, this should succeed
      assert.ok(true);
    } catch (error: any) {
      // If it fails, it should be a connection error, not a validation error
      const output = error.stdout + error.stderr;
      assert.doesNotMatch(output, /Cannot deploy.*Multiple files/, 
        'Should not show duplicate ID error when IDs are different');
    }
  });
});
