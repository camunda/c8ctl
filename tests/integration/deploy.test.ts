/**
 * Integration tests for deployment
 * NOTE: These tests require a running Camunda 8 instance at http://localhost:8080
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';

describe('Deployment Integration Tests (requires Camunda 8 at localhost:8080)', () => {
  test.skip('deploy simple BPMN creates deployment', async () => {
    // This test would require a running Camunda instance
    // Skipped by default
    
    // Example implementation:
    // const { deploy } = await import('../../src/commands/deployments.ts');
    // await deploy(['tests/fixtures/simple.bpmn'], { profile: undefined });
    // Assert deployment was successful
    
    assert.ok(true, 'Test skipped - requires running Camunda instance');
  });

  test.skip('deploy prioritizes building block folders', async () => {
    // Test that _bb- folders are deployed first
    assert.ok(true, 'Test skipped - requires running Camunda instance');
  });
});
