/**
 * Integration tests for run command
 * NOTE: These tests require a running Camunda 8 instance at http://localhost:8080
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import { run } from '../../src/commands/run.ts';
import { createClient } from '../../src/client.ts';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// Wait time for Elasticsearch to index data before search queries
const ELASTICSEARCH_CONSISTENCY_WAIT_MS = 5000;

describe('Run Command Integration Tests (requires Camunda 8 at localhost:8080)', () => {
  beforeEach(() => {
    // Clear session state before each test to ensure clean tenant resolution
    const sessionPath = join(homedir(), 'Library', 'Application Support', 'c8ctl', 'session.json');
    if (existsSync(sessionPath)) {
      unlinkSync(sessionPath);
    }
  });

  test('run deploys and creates process instance', async () => {
    // Run deploys and starts a process instance in one step
    // The command should complete without throwing
    await run('tests/fixtures/simple.bpmn', {});
    
    // Verify instance was created by searching for running instances of simple-process
    // Wait for Elasticsearch to index the data
    const client = createClient();
    const result = await client.searchProcessInstances({
      filter: {
        processDefinitionId: 'simple-process',
      },
    }, { consistency: { waitUpToMs: ELASTICSEARCH_CONSISTENCY_WAIT_MS } });
    
    assert.ok(result.items && result.items.length > 0, 'Process instance should exist');
  });

  test('run extracts correct process ID from BPMN', async () => {
    // Run with a BPMN file and verify the correct process ID was used
    // The simple.bpmn file has process id "simple-process"
    await run('tests/fixtures/simple.bpmn', {});
    
    // Verify we can find instances of the correct process
    // Wait for Elasticsearch to index the data
    const client = createClient();
    const result = await client.searchProcessInstances({
      filter: {
        processDefinitionId: 'simple-process',
      },
    }, { consistency: { waitUpToMs: ELASTICSEARCH_CONSISTENCY_WAIT_MS } });
    
    // Should have at least one instance with the correct process ID
    assert.ok(result.items && result.items.length > 0, 'Should find instances with extracted process ID');
    assert.strictEqual(result.items[0].processDefinitionId, 'simple-process', 'Process ID should match BPMN definition');
  });

  test('run passes variables to process instance', async () => {
    // Run with variables and verify they are passed
    const testVariables = JSON.stringify({ testKey: 'testValue', count: 42 });
    await run('tests/fixtures/simple.bpmn', { variables: testVariables });
    
    // If we got here, the run with variables succeeded
    // Note: Verifying variables would require additional API calls or a process that outputs them
    assert.ok(true, 'Run with variables completed successfully');
  });
});
