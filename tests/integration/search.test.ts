/**
 * Integration tests for search commands
 * NOTE: These tests require a running Camunda 8 instance at http://localhost:8080
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import { createClient } from '../../src/client.ts';
import { deploy } from '../../src/commands/deployments.ts';
import { 
  searchProcessDefinitions,
  searchProcessInstances,
  searchUserTasks,
  searchIncidents,
  searchJobs,
} from '../../src/commands/search.ts';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { ProcessDefinitionId } from '@camunda8/orchestration-cluster-api';

// Wait time for Elasticsearch to index data before search queries
const ELASTICSEARCH_CONSISTENCY_WAIT_MS = 8000;

describe('Search Command Integration Tests (requires Camunda 8 at localhost:8080)', () => {
  beforeEach(() => {
    // Clear session state before each test to ensure clean tenant resolution
    const sessionPath = join(homedir(), 'Library', 'Application Support', 'c8ctl', 'session.json');
    if (existsSync(sessionPath)) {
      unlinkSync(sessionPath);
    }
  });

  test('search process definitions by processDefinitionId', async () => {
    const client = createClient();
    
    // Deploy a process to ensure at least one exists
    await deploy(['tests/fixtures/simple.bpmn'], {});
    
    // Wait for Elasticsearch consistency
    await new Promise(resolve => setTimeout(resolve, ELASTICSEARCH_CONSISTENCY_WAIT_MS));
    
    // Search using the command function
    // Note: This tests the function works without error; actual output is logged
    await assert.doesNotReject(
      async () => {
        await searchProcessDefinitions({
          processDefinitionId: 'simple-process',
        });
      },
      'Search process definitions should not throw an error'
    );
  });

  test('search process definitions with filters', async () => {
    // Deploy a process
    await deploy(['tests/fixtures/simple.bpmn'], {});
    
    const client = createClient();
    
    // Search to get the key
    const result = await client.searchProcessDefinitions({
      filter: {
        processDefinitionId: 'simple-process',
      },
    }, { consistency: { waitUpToMs: ELASTICSEARCH_CONSISTENCY_WAIT_MS } });
    
    assert.ok(result.items && result.items.length > 0, 'Should find the deployed process');
    
    const processDefKey = result.items[0].processDefinitionKey?.toString();
    
    // Test search command with key filter
    await assert.doesNotReject(
      async () => {
        await searchProcessDefinitions({
          key: processDefKey,
        });
      },
      'Search process definitions by key should not throw an error'
    );
  });

  test('search process instances by state', async () => {
    // Deploy and create an instance
    await deploy(['tests/fixtures/simple.bpmn'], {});
    
    const client = createClient();
    await client.createProcessInstance({
      processDefinitionId: ProcessDefinitionId.assumeExists('simple-process'),
    });
    
    // Wait for Elasticsearch consistency
    await new Promise(resolve => setTimeout(resolve, ELASTICSEARCH_CONSISTENCY_WAIT_MS));
    
    // Search for process instances with state filter
    await assert.doesNotReject(
      async () => {
        await searchProcessInstances({
          processDefinitionId: 'simple-process',
          state: 'COMPLETED',
        });
      },
      'Search process instances should not throw an error'
    );
  });

  test('search process instances by processDefinitionKey', async () => {
    const client = createClient();
    
    // Deploy a process
    await deploy(['tests/fixtures/simple.bpmn'], {});
    
    // Get the process definition key
    const pdResult = await client.searchProcessDefinitions({
      filter: {
        processDefinitionId: 'simple-process',
      },
    }, { consistency: { waitUpToMs: ELASTICSEARCH_CONSISTENCY_WAIT_MS } });
    
    assert.ok(pdResult.items && pdResult.items.length > 0, 'Should find the deployed process');
    const processDefKey = pdResult.items[0].processDefinitionKey?.toString();
    
    // Create an instance
    await client.createProcessInstance({
      processDefinitionId: ProcessDefinitionId.assumeExists('simple-process'),
    });
    
    // Wait for Elasticsearch consistency
    await new Promise(resolve => setTimeout(resolve, ELASTICSEARCH_CONSISTENCY_WAIT_MS));
    
    // Search by process definition key
    await assert.doesNotReject(
      async () => {
        await searchProcessInstances({
          processDefinitionKey: processDefKey,
        });
      },
      'Search process instances by key should not throw an error'
    );
  });

  test('search user tasks with filters', async () => {
    // Note: This test just validates the command doesn't crash
    // Actual user task creation requires a process with user tasks
    await assert.doesNotReject(
      async () => {
        await searchUserTasks({
          state: 'CREATED',
        });
      },
      'Search user tasks should not throw an error'
    );
  });

  test('search incidents with filters', async () => {
    // Note: This test just validates the command doesn't crash
    // Actual incident creation requires a process that generates incidents
    await assert.doesNotReject(
      async () => {
        await searchIncidents({
          state: 'ACTIVE',
        });
      },
      'Search incidents should not throw an error'
    );
  });

  test('search jobs with filters', async () => {
    // Note: This test just validates the command doesn't crash
    // Actual job creation requires a process with service tasks
    await assert.doesNotReject(
      async () => {
        await searchJobs({
          state: 'ACTIVATABLE',
        });
      },
      'Search jobs should not throw an error'
    );
  });
});
