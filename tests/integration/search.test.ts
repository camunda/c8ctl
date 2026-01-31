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
    const client = createClient();
    
    // Deploy a process with a user task
    await deploy(['tests/fixtures/list-pis'], {});
    
    // Get the process definition to find the process ID
    const pdResult = await client.searchProcessDefinitions({
      filter: {},
    }, { consistency: { waitUpToMs: ELASTICSEARCH_CONSISTENCY_WAIT_MS } });
    
    assert.ok(pdResult.items && pdResult.items.length > 0, 'Should find deployed processes');
    
    // Find the process with ID Process_0t60ay7 (from min-usertask.bpmn)
    const userTaskProcess = pdResult.items.find(pd => pd.processDefinitionId === 'Process_0t60ay7');
    assert.ok(userTaskProcess, 'Should find the user task process');
    
    // Create an instance to generate a user task
    await client.createProcessInstance({
      processDefinitionId: ProcessDefinitionId.assumeExists('Process_0t60ay7'),
    });
    
    // Wait for Elasticsearch consistency
    await new Promise(resolve => setTimeout(resolve, ELASTICSEARCH_CONSISTENCY_WAIT_MS));
    
    // Search for user tasks
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
    const client = createClient();
    
    // Deploy a process that will create an incident (service task without job type configuration)
    await deploy(['tests/fixtures/simple-will-create-incident.bpmn'], {});
    
    // Get the process definition
    const pdResult = await client.searchProcessDefinitions({
      filter: {
        processDefinitionId: 'Process_0yyrstd',
      },
    }, { consistency: { waitUpToMs: ELASTICSEARCH_CONSISTENCY_WAIT_MS } });
    
    assert.ok(pdResult.items && pdResult.items.length > 0, 'Should find the deployed process');
    
    // Create an instance to generate an incident
    await client.createProcessInstance({
      processDefinitionId: ProcessDefinitionId.assumeExists('Process_0yyrstd'),
    });
    
    // Wait for Elasticsearch consistency
    await new Promise(resolve => setTimeout(resolve, ELASTICSEARCH_CONSISTENCY_WAIT_MS));
    
    // Search for incidents
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
    const client = createClient();
    
    // Deploy a process with a service task (job)
    await deploy(['tests/fixtures/simple-service-task.bpmn'], {});
    
    // Get the process definition
    const pdResult = await client.searchProcessDefinitions({
      filter: {
        processDefinitionId: 'Process_18glkb3',
      },
    }, { consistency: { waitUpToMs: ELASTICSEARCH_CONSISTENCY_WAIT_MS } });
    
    assert.ok(pdResult.items && pdResult.items.length > 0, 'Should find the deployed process');
    
    // Create an instance to generate jobs
    await client.createProcessInstance({
      processDefinitionId: ProcessDefinitionId.assumeExists('Process_18glkb3'),
    });
    
    // Wait for Elasticsearch consistency
    await new Promise(resolve => setTimeout(resolve, ELASTICSEARCH_CONSISTENCY_WAIT_MS));
    
    // Search for jobs with type 'n00b' (from the service task)
    await assert.doesNotReject(
      async () => {
        await searchJobs({
          type: 'n00b',
          state: 'ACTIVATABLE',
        });
      },
      'Search jobs should not throw an error'
    );
  });
});
