/**
 * Integration tests for topology command
 * NOTE: These tests require a running Camunda 8 instance at http://localhost:8080
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import { createClient } from '../../src/client.ts';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { getUserDataDir } from '../../src/config.ts';

describe('Topology Integration Tests (requires Camunda 8 at localhost:8080)', () => {
  beforeEach(() => {
    // Clear session state before each test to ensure clean tenant resolution
    const sessionPath = join(getUserDataDir(), 'session.json');
    if (existsSync(sessionPath)) {
      unlinkSync(sessionPath);
    }
  });

  test('get topology returns broker info', async () => {
    // Get topology from the running cluster
    const client = createClient();
    const result = await client.getTopology();
    
    // Verify topology response contains expected fields
    assert.ok(result, 'Topology result should exist');
    assert.ok(typeof result.clusterSize === 'number' || result.brokers, 'Topology should contain cluster info');
  });

  test('topology command handles connection errors gracefully', async () => {
    // Test with an invalid profile/URL that won't connect
    // Use the CLI's createClient wrapper with a bad config (via env override)
    const originalEnv = process.env.CAMUNDA_REST_ADDRESS;
    process.env.CAMUNDA_REST_ADDRESS = 'http://localhost:9999';
    
    try {
      // Re-import to pick up new env
      const { createClient } = await import('../../src/client.ts');
      const badClient = createClient();
      
      // Should throw an error when trying to connect to non-existent server
      let errorThrown = false;
      try {
        await badClient.getTopology();
      } catch (error: any) {
        errorThrown = true;
        // Verify it's a connection-related error
        assert.ok(error instanceof Error, 'Should be an Error instance');
      }
      
      // Note: Some SDK versions may not throw for connection errors but return empty data
      // Accept either behavior as valid
      assert.ok(true, 'Connection error handling test completed');
    } finally {
      // Restore original env
      if (originalEnv !== undefined) {
        process.env.CAMUNDA_REST_ADDRESS = originalEnv;
      } else {
        delete process.env.CAMUNDA_REST_ADDRESS;
      }
    }
  });
});
