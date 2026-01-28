/**
 * Integration tests for process instances
 * NOTE: These tests require a running Camunda 8 instance at http://localhost:8080
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';

describe('Process Instance Integration Tests (requires Camunda 8 at localhost:8080)', () => {
  test.skip('create process instance returns key', async () => {
    // This test would require a running Camunda instance
    // Skipped by default
    
    // Example implementation:
    // 1. Deploy a test process
    // 2. Create instance
    // 3. Assert instance key is returned
    // 4. List instances and verify it's there
    // 5. Get instance by key
    // 6. Cancel instance
    
    assert.ok(true, 'Test skipped - requires running Camunda instance');
  });

  test.skip('list process instances filters by tenant', async () => {
    // Test tenant filtering
    assert.ok(true, 'Test skipped - requires running Camunda instance');
  });

  test.skip('cancel process instance marks it as cancelled', async () => {
    // Test cancellation
    assert.ok(true, 'Test skipped - requires running Camunda instance');
  });
});
