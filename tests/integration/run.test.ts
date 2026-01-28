/**
 * Integration tests for run command
 * NOTE: These tests require a running Camunda 8 instance at http://localhost:8080
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';

describe('Run Command Integration Tests (requires Camunda 8 at localhost:8080)', () => {
  test.skip('run deploys and creates process instance', async () => {
    // This test would require a running Camunda instance
    // Skipped by default
    
    // Example implementation:
    // const { run } = await import('../../src/commands/run.ts');
    // await run('tests/fixtures/simple.bpmn', { profile: undefined });
    // Assert deployment and instance creation were successful
    
    assert.ok(true, 'Test skipped - requires running Camunda instance');
  });

  test.skip('run extracts correct process ID from BPMN', async () => {
    // Test process ID extraction and usage
    assert.ok(true, 'Test skipped - requires running Camunda instance');
  });

  test.skip('run passes variables to process instance', async () => {
    // Test variable passing
    assert.ok(true, 'Test skipped - requires running Camunda instance');
  });
});
