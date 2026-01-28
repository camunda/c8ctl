/**
 * Unit tests for deployment command validation
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { execSync } from 'node:child_process';

describe('Deployment Validation', () => {
  test('detects duplicate process IDs', () => {
    // Attempt to deploy directory with duplicate process IDs should fail
    try {
      execSync('node src/index.ts deploy tests/fixtures/duplicate-ids', {
        cwd: process.cwd(),
        encoding: 'utf-8',
        stdio: 'pipe'
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
      execSync('node src/index.ts deploy tests/fixtures/simple.bpmn', {
        cwd: process.cwd(),
        encoding: 'utf-8',
        stdio: 'pipe',
        timeout: 5000
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
      execSync('node src/index.ts deploy tests/fixtures/sample-project', {
        cwd: process.cwd(),
        encoding: 'utf-8',
        stdio: 'pipe',
        timeout: 5000
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
