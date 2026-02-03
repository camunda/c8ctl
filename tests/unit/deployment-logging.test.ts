/**
 * Unit tests for deployment logging enhancements
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

// Timeout for deployment commands (longer for CI environments)
const DEPLOYMENT_TIMEOUT = 10000;

describe('Deployment Logging', () => {
  let testDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    // Create isolated test directory for session/profile data
    testDir = join(tmpdir(), `c8ctl-deploy-log-test-${Date.now()}`);
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

  /**
   * Helper function to execute deployment command and capture output
   */
  function executeDeployment(path: string): string {
    try {
      execSync(`npm run cli -- deploy ${path}`, {
        cwd: process.cwd(),
        encoding: 'utf-8',
        stdio: 'pipe',
        timeout: DEPLOYMENT_TIMEOUT,
        env: process.env
      });
      return '';
    } catch (error: any) {
      return error.stdout + error.stderr;
    }
  }

  test('shows process application batch deployment note', () => {
    const output = executeDeployment('tests/fixtures/list-pis');
    // Should mention batch deployment from process application
    assert.match(output, /batch deployment from process application/, 
      'Should display process application batch deployment note');
  });

  test('does not show batch deployment note when no .process-application file', () => {
    const output = executeDeployment('tests/fixtures/_bb-building-block');
    // Should NOT mention batch deployment from process application
    assert.doesNotMatch(output, /batch deployment from process application/, 
      'Should not display process application note when file is absent');
  });

  test('batched deployment with process application deploys all resources together', () => {
    // This test verifies that when a .process-application file is present,
    // all resources in that directory are deployed in a single batch
    const output = executeDeployment('tests/fixtures/list-pis');
    
    // Verify batch deployment note is shown
    assert.match(output, /batch deployment from process application/, 
      'Should indicate batch deployment from process application');
    
    // Verify multiple resources are being deployed (2 in list-pis: BPMN + Form)
    assert.match(output, /Deploying 2 resource\(s\)/, 
      'Should deploy all 2 resources (BPMN and Form) in the directory');
    
    // The error is expected if no Camunda server is running
    // We're validating the behavior up to the API call
    if (output.includes('fetch failed') || output.includes('ECONNREFUSED')) {
      // Expected: connection error means we got to the deployment attempt
      assert.ok(true, 'Deployment attempted with all resources as expected');
    } else if (output.includes('Deployment successful')) {
      // If Camunda server is running, deployment succeeded
      assert.ok(true, 'Deployment succeeded with all resources in batch');
    } else {
      // Unexpected error
      throw new Error(`Unexpected deployment output: ${output}`);
    }
  });
});
