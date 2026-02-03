/**
 * Unit tests for deployment logging enhancements
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

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

  test('shows building block indicator in deployment output', () => {
    try {
      execSync('npm run cli -- deploy tests/fixtures/_bb-building-block', {
        cwd: process.cwd(),
        encoding: 'utf-8',
        stdio: 'pipe',
        timeout: 5000,
        env: process.env
      });
    } catch (error: any) {
      const output = error.stdout + error.stderr;
      // Should show the building block emoji indicator
      assert.match(output, /🧱/, 'Should display building block indicator');
      // Should show the file name
      assert.match(output, /bb-process\.bpmn/, 'Should display file name');
    }
  });

  test('shows process application batch deployment note', () => {
    try {
      execSync('npm run cli -- deploy tests/fixtures/list-pis', {
        cwd: process.cwd(),
        encoding: 'utf-8',
        stdio: 'pipe',
        timeout: 5000,
        env: process.env
      });
    } catch (error: any) {
      const output = error.stdout + error.stderr;
      // Should mention batch deployment from process application
      assert.match(output, /batch deployment from process application/, 
        'Should display process application batch deployment note');
    }
  });

  test('shows relative file paths in deployment output', () => {
    try {
      execSync('npm run cli -- deploy tests/fixtures/list-pis', {
        cwd: process.cwd(),
        encoding: 'utf-8',
        stdio: 'pipe',
        timeout: 5000,
        env: process.env
      });
    } catch (error: any) {
      const output = error.stdout + error.stderr;
      // Should show file names with relative paths
      assert.match(output, /min-usertask\.bpmn/, 'Should display BPMN file name');
      assert.match(output, /some-form\.form/, 'Should display Form file name');
    }
  });

  test('prioritizes building blocks in output', () => {
    // Create a test directory with both building blocks and regular files
    const testDeployDir = join(testDir, 'test-deploy');
    mkdirSync(testDeployDir, { recursive: true });
    
    const bbDir = join(testDeployDir, '_bb-test');
    const regDir = join(testDeployDir, 'regular');
    mkdirSync(bbDir, { recursive: true });
    mkdirSync(regDir, { recursive: true });
    
    // Create test BPMN files
    writeFileSync(join(bbDir, 'bb-proc.bpmn'), 
      '<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"><bpmn:process id="bb-proc" /></bpmn:definitions>');
    writeFileSync(join(regDir, 'reg-proc.bpmn'), 
      '<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"><bpmn:process id="reg-proc" /></bpmn:definitions>');
    
    try {
      execSync(`npm run cli -- deploy ${testDeployDir}`, {
        cwd: process.cwd(),
        encoding: 'utf-8',
        stdio: 'pipe',
        timeout: 5000,
        env: process.env
      });
    } catch (error: any) {
      const output = error.stdout + error.stderr;
      
      // Building block file should appear before regular file
      const bbIndex = output.indexOf('bb-proc.bpmn');
      const regIndex = output.indexOf('reg-proc.bpmn');
      
      assert.ok(bbIndex > -1, 'Should show building block file');
      assert.ok(regIndex > -1, 'Should show regular file');
      assert.ok(bbIndex < regIndex, 'Building block should appear before regular file');
      
      // Building block should have emoji
      assert.match(output, /🧱.*bb-proc\.bpmn/, 'Building block should have emoji indicator');
    }
  });

  test('regular files have proper indentation', () => {
    try {
      execSync('npm run cli -- deploy tests/fixtures/simple.bpmn', {
        cwd: process.cwd(),
        encoding: 'utf-8',
        stdio: 'pipe',
        timeout: 5000,
        env: process.env
      });
    } catch (error: any) {
      const output = error.stdout + error.stderr;
      // Regular files should be indented (not have building block emoji)
      assert.match(output, /\s{2}simple\.bpmn/, 'Regular file should be indented with 2 spaces');
    }
  });
});
