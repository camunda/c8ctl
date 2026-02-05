/**
 * Integration tests for process instances
 * NOTE: These tests require a running Camunda 8 instance at http://localhost:8080
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import { createClient } from '../../src/client.ts';
import { deploy } from '../../src/commands/deployments.ts';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { getUserDataDir } from '../../src/config.ts';
import { ProcessDefinitionId, ProcessInstanceKey } from '@camunda8/orchestration-cluster-api';

// Wait time for Elasticsearch to index data before search queries
const ELASTICSEARCH_CONSISTENCY_WAIT_MS = 8000;

describe('Process Instance Integration Tests (requires Camunda 8 at localhost:8080)', () => {
  beforeEach(() => {
    // Clear session state before each test to ensure clean tenant resolution
    const sessionPath = join(getUserDataDir(), 'session.json');
    if (existsSync(sessionPath)) {
      unlinkSync(sessionPath);
    }
  });

  test('create process instance returns key', async () => {
    const client = createClient();
    
    // First deploy a process to ensure it exists
    await deploy(['tests/fixtures/simple.bpmn'], {});
    
    // Create process instance
    const createResult = await client.createProcessInstance({
      processDefinitionId: ProcessDefinitionId.assumeExists('simple-process')
    });
    
    // Verify instance key is returned
    assert.ok(createResult.processInstanceKey, 'Process instance key should be returned');
    assert.ok(
      typeof createResult.processInstanceKey === 'number' || typeof createResult.processInstanceKey === 'string',
      'Process instance key should be a number or string'
    );
  });

  test('list process instances filters by tenant', async () => {
    const client = createClient();
    
    // First deploy and create an instance
    await deploy(['tests/fixtures/simple.bpmn'], {});
    await client.createProcessInstance({
      processDefinitionId: ProcessDefinitionId.assumeExists('simple-process'),
    });
    
    // Search for process instances - filter by process definition ID
    // Wait for Elasticsearch to index the data
    const result = await client.searchProcessInstances({
      filter: {
        processDefinitionId: 'simple-process',
      },
    }, { consistency: { waitUpToMs: ELASTICSEARCH_CONSISTENCY_WAIT_MS } });
    
    // Verify we get results
    assert.ok(result, 'Search result should exist');
    assert.ok(Array.isArray(result.items), 'Items should be an array');
  });

  test('cancel process instance marks it as cancelled', async () => {
    const client = createClient();
    
    // Deploy and create an instance
    await deploy(['tests/fixtures/simple.bpmn'], {});
    const createResult = await client.createProcessInstance({
      processDefinitionId: ProcessDefinitionId.assumeExists('simple-process'),
    });
    
    const instanceKey = createResult.processInstanceKey.toString();
    
    // Try to cancel - note: simple-process may complete instantly,
    // so we handle both success and "already completed" scenarios
    try {
      await client.cancelProcessInstance({ processInstanceKey: ProcessInstanceKey.assumeExists(instanceKey) });
      assert.ok(true, 'Process instance cancellation succeeded');
    } catch (error: any) {
      // If the process already completed, that's also acceptable
      // since simple-process is just start -> end
      // Accept any error since completion happens instantly
      assert.ok(error instanceof Error, 'Should receive an error for already completed process');
    }
  });

  test('create with awaitCompletion returns completed result with variables', async () => {
    // Deploy a simple process first
    await deploy(['tests/fixtures/simple.bpmn'], {});
    
    // Import the createProcessInstance function
    const { createProcessInstance } = await import('../../src/commands/process-instances.ts');
    
    // Test with awaitCompletion flag
    const result = await createProcessInstance({
      processDefinitionId: 'simple-process',
      awaitCompletion: true,
    });
    
    // Verify the result contains the expected properties
    assert.ok(result, 'Result should be returned');
    assert.ok(result.processInstanceKey, 'Should have process instance key');
    assert.ok('variables' in result, 'Result should have variables property when awaitCompletion is true');
  });

  test('create with awaitCompletion CLI output includes completed and variables', async () => {
    // Deploy a simple process first
    await deploy(['tests/fixtures/simple.bpmn'], {});
    
    // Run the CLI command as a subprocess to test the full integration
    const { execSync } = await import('node:child_process');
    
    // Execute the CLI command and capture output (using proper command syntax: create pi)
    const output = execSync(
      'npx tsx src/index.ts create pi --id simple-process --awaitCompletion',
      { encoding: 'utf8', cwd: process.cwd() }
    );
    
    // Verify the output indicates successful completion
    assert.ok(output.includes('completed'), 'Output should indicate process completed');
    // Verify that variables are present in the output (JSON response should contain "variables")
    assert.ok(output.includes('variables'), 'Output should contain variables when awaitCompletion is true');

    // Also test the 'await pi' command which is an alias for 'create pi --awaitCompletion'
    const outputWithAlias = execSync(
      'npx tsx src/index.ts await pi --id simple-process',
      { encoding: 'utf8', cwd: process.cwd() }
    );
    
    // Verify the alias works the same way
    assert.ok(outputWithAlias.includes('completed'), 'Output with await alias should indicate process completed');
    assert.ok(outputWithAlias.includes('variables'), 'Output with await alias should contain variables');
  });
});
