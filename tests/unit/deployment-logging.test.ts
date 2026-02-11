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
    delete process.env.CAMUNDA_TOKEN_AUDIENCE;
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
      const output = execSync(`npm run cli -- deploy ${path}`, {
        cwd: process.cwd(),
        encoding: 'utf-8',
        stdio: 'pipe',
        timeout: DEPLOYMENT_TIMEOUT,
        env: process.env
      });
      return output;
    } catch (error: any) {
      return error.stdout + error.stderr;
    }
  }

  test('process application resources are deployed together', () => {
    const output = executeDeployment('tests/fixtures/list-pis');
    // Should NOT mention batch deployment from process application anymore
    assert.doesNotMatch(output, /batch deployment from process application/, 
      'Should not display process application batch deployment note');
    
    // Should deploy all 2 resources (BPMN + Form) in the directory
    assert.match(output, /Deploying 2 resource\(s\)/, 
      'Should deploy all 2 resources (BPMN and Form) in the directory');
  });

  test('deployment without process application works normally', () => {
    const output = executeDeployment('tests/fixtures/_bb-building-block');
    // Should NOT mention batch deployment from process application
    assert.doesNotMatch(output, /batch deployment from process application/, 
      'Should not display process application note when file is absent');
  });

  test('all resources from process application directory are deployed', () => {
    // This test verifies that when a .process-application file is present,
    // all resources in that directory are deployed together
    const output = executeDeployment('tests/fixtures/list-pis');
    
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
      assert.ok(true, 'Deployment succeeded with all resources');
    } else {
      // Unexpected error
      throw new Error(`Unexpected deployment output: ${output}`);
    }
  });

  test('mixed resources are properly grouped in deployment', () => {
    // This test verifies that building blocks, process applications, and standalone
    // resources are all properly grouped when deployed together
    const output = executeDeployment('tests/fixtures/sample-mixed-resources');
    
    // Verify all 6 resources are being deployed (2 BB + 2 PA + 2 standalone)
    assert.match(output, /Deploying 6 resource\(s\)/, 
      'Should deploy all 6 resources from mixed structure');
    
    // The error is expected if no Camunda server is running
    if (output.includes('fetch failed') || output.includes('ECONNREFUSED')) {
      assert.ok(true, 'Deployment attempted with all resources from mixed structure');
    } else if (output.includes('Deployment successful')) {
      assert.ok(true, 'Deployment succeeded with mixed resources');
    } else {
      throw new Error(`Unexpected deployment output: ${output}`);
    }
  });
});
