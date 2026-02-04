/**
 * Integration tests for process definitions
 * NOTE: These tests require a running Camunda 8 instance at http://localhost:8080
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import { createClient } from '../../src/client.ts';
import { deploy } from '../../src/commands/deployments.ts';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { getUserDataDir } from '../../src/config.ts';

// Wait time for Elasticsearch to index data before search queries
const ELASTICSEARCH_CONSISTENCY_WAIT_MS = 8000;

describe('Process Definition Integration Tests (requires Camunda 8 at localhost:8080)', () => {
  beforeEach(() => {
    // Clear session state before each test to ensure clean tenant resolution
    const sessionPath = join(getUserDataDir(), 'session.json');
    if (existsSync(sessionPath)) {
      unlinkSync(sessionPath);
    }
  });

  test('list process definitions returns deployed processes', async () => {
    const client = createClient();
    
    // First deploy a process to ensure at least one exists
    await deploy(['tests/fixtures/simple.bpmn'], {});
    
    // Search for process definitions
    const result = await client.searchProcessDefinitions({
      filter: {
        processDefinitionId: 'simple-process',
      },
    }, { consistency: { waitUpToMs: ELASTICSEARCH_CONSISTENCY_WAIT_MS } });
    
    // Verify we get results
    assert.ok(result, 'Search result should exist');
    assert.ok(Array.isArray(result.items), 'Items should be an array');
    assert.ok(result.items.length > 0, 'Should have at least one process definition');
    
    // Verify the structure of returned items
    const firstItem = result.items[0];
    assert.ok(firstItem.processDefinitionKey, 'Process definition should have a key');
    assert.ok(firstItem.processDefinitionId, 'Process definition should have an ID');
    assert.ok(firstItem.version !== undefined, 'Process definition should have a version');
  });

  test('get process definition by key returns definition details', async () => {
    const client = createClient();
    
    // Deploy a process first
    await deploy(['tests/fixtures/simple.bpmn'], {});
    
    // Search to get the process definition key
    const searchResult = await client.searchProcessDefinitions({
      filter: {
        processDefinitionId: 'simple-process',
      },
    }, { consistency: { waitUpToMs: ELASTICSEARCH_CONSISTENCY_WAIT_MS } });
    
    assert.ok(searchResult.items && searchResult.items.length > 0, 'Should find the deployed process');
    
    const processDefinitionKey = searchResult.items[0].processDefinitionKey;
    
    // Get the process definition by key
    const definition = await client.getProcessDefinition(
      { processDefinitionKey: processDefinitionKey as any },
      { consistency: { waitUpToMs: 0 } }
    );
    
    // Verify the definition details
    assert.ok(definition, 'Process definition should be returned');
    assert.strictEqual(definition.processDefinitionKey, processDefinitionKey, 'Keys should match');
    assert.strictEqual(definition.processDefinitionId, 'simple-process', 'IDs should match');
  });

  test('get process definition XML returns BPMN content', async () => {
    const client = createClient();
    
    // Deploy a process first
    await deploy(['tests/fixtures/simple.bpmn'], {});
    
    // Search to get the process definition key
    const searchResult = await client.searchProcessDefinitions({
      filter: {
        processDefinitionId: 'simple-process',
      },
    }, { consistency: { waitUpToMs: ELASTICSEARCH_CONSISTENCY_WAIT_MS } });
    
    assert.ok(searchResult.items && searchResult.items.length > 0, 'Should find the deployed process');
    
    const processDefinitionKey = searchResult.items[0].processDefinitionKey;
    
    // Get the process definition XML
    const xml = await client.getProcessDefinitionXml(
      { processDefinitionKey: processDefinitionKey as any },
      { consistency: { waitUpToMs: 0 } }
    );
    
    // Verify XML content is returned
    assert.ok(xml, 'XML should be returned');
    assert.ok(typeof xml === 'string', 'XML should be a string');
    assert.ok(xml.includes('bpmn:'), 'XML should contain BPMN namespace');
    assert.ok(xml.includes('simple-process'), 'XML should contain the process ID');
  });
});
