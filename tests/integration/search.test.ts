/**
 * Integration tests for search commands
 * NOTE: These tests require a running Camunda 8 instance at http://localhost:8080
 *
 * These tests validate the project's wrapper functions in src/commands/search.ts,
 * not the underlying @camunda8/orchestration-cluster-api npm module directly.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import { deploy } from '../../src/commands/deployments.ts';
import { createProcessInstance } from '../../src/commands/process-instances.ts';
import {
  searchProcessDefinitions,
  searchProcessInstances,
  searchUserTasks,
  searchIncidents,
  searchJobs,
  searchVariables,
} from '../../src/commands/search.ts';
import { pollUntil } from '../utils/polling.ts';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { getUserDataDir } from '../../src/config.ts';

// Polling configuration for Elasticsearch consistency
const POLL_TIMEOUT_MS = 15000;
const POLL_INTERVAL_MS = 1000;

describe('Search Command Integration Tests (requires Camunda 8 at localhost:8080)', () => {
  beforeEach(() => {
    // Clear session state before each test to ensure clean tenant resolution
    const sessionPath = join(getUserDataDir(), 'session.json');
    if (existsSync(sessionPath)) {
      unlinkSync(sessionPath);
    }
  });

  test('search process definitions by processDefinitionId', async () => {
    // Deploy a process to ensure at least one exists
    await deploy(['tests/fixtures/simple.bpmn'], {});

    // Poll until the search command finds the deployed process definition
    const found = await pollUntil(async () => {
      const result = await searchProcessDefinitions({
        processDefinitionId: 'simple-process',
      });
      return !!(result?.items && result.items.length > 0);
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);

    assert.ok(found, 'Search should find the deployed process definition');
  });

  test('search process definitions with filters', async () => {
    // Deploy a process
    await deploy(['tests/fixtures/simple.bpmn'], {});

    // Poll until the process definition is indexed and extract its key
    let processDefKey: string | undefined;
    const found = await pollUntil(async () => {
      const result = await searchProcessDefinitions({
        processDefinitionId: 'simple-process',
      });
      if (result?.items && result.items.length > 0) {
        const item = result.items[0] as any;
        processDefKey = (item.processDefinitionKey || item.key)?.toString();
        return processDefKey !== undefined;
      }
      return false;
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);

    assert.ok(found, 'Should find the deployed process');
    assert.ok(processDefKey, 'Should have process definition key');

    // Search by key using the command function
    const result = await searchProcessDefinitions({ key: processDefKey });
    assert.ok(result?.items && result.items.length > 0, 'Search by key should find the process');
  });

  test('search process instances by state', async () => {
    // Deploy and create an instance using CLI wrappers
    await deploy(['tests/fixtures/simple.bpmn'], {});
    await createProcessInstance({
      processDefinitionId: 'simple-process',
    });

    // Poll until completed process instances appear in search results
    const found = await pollUntil(async () => {
      const result = await searchProcessInstances({
        processDefinitionId: 'simple-process',
        state: 'COMPLETED',
      });
      return !!(result?.items && result.items.length > 0);
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);

    assert.ok(found, 'Search should find completed process instances');
  });

  test('search process instances by processDefinitionKey', async () => {
    // Deploy a process
    await deploy(['tests/fixtures/simple.bpmn'], {});

    // Poll until process definition is indexed and extract its key
    let processDefKey: string | undefined;
    const indexed = await pollUntil(async () => {
      const result = await searchProcessDefinitions({
        processDefinitionId: 'simple-process',
      });
      if (result?.items && result.items.length > 0) {
        const item = result.items[0] as any;
        processDefKey = (item.processDefinitionKey || item.key)?.toString();
        return processDefKey !== undefined;
      }
      return false;
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);

    assert.ok(indexed, 'Should find the deployed process');
    assert.ok(processDefKey, 'Should have process definition key');

    // Create an instance using CLI wrapper
    await createProcessInstance({
      processDefinitionId: 'simple-process',
    });

    // Poll until search by processDefinitionKey finds results
    const found = await pollUntil(async () => {
      const result = await searchProcessInstances({
        processDefinitionKey: processDefKey,
      });
      return !!(result?.items && result.items.length > 0);
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);

    assert.ok(found, 'Search by processDefinitionKey should find process instances');
  });

  test('search user tasks with filters', async () => {
    // Deploy a process with a user task
    await deploy(['tests/fixtures/list-pis'], {});

    // Create an instance to generate a user task
    await createProcessInstance({
      processDefinitionId: 'Process_0t60ay7',
    });

    // Poll until the user task appears in search results
    const found = await pollUntil(async () => {
      const result = await searchUserTasks({
        state: 'CREATED',
      });
      return !!(result?.items && result.items.length > 0);
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);

    assert.ok(found, 'Search should find created user tasks');
  });

  test('search incidents with filters', async () => {
    // Deploy a process that will create an incident (service task without job type configuration)
    await deploy(['tests/fixtures/simple-will-create-incident.bpmn'], {});

    // Create an instance to generate an incident
    await createProcessInstance({
      processDefinitionId: 'Process_0yyrstd',
    });

    // Poll until the incident appears in search results
    const found = await pollUntil(async () => {
      const result = await searchIncidents({
        state: 'ACTIVE',
      });
      return !!(result?.items && result.items.length > 0);
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);

    assert.ok(found, 'Search should find active incidents');
  });

  test('search jobs with filters', async () => {
    // Deploy a process with a service task (job)
    await deploy(['tests/fixtures/simple-service-task.bpmn'], {});

    // Create an instance to generate jobs
    await createProcessInstance({
      processDefinitionId: 'Process_18glkb3',
    });

    // Poll until the job appears in search results
    const found = await pollUntil(async () => {
      const result = await searchJobs({
        type: 'n00b',
        state: 'CREATED',
      });
      return !!(result?.items && result.items.length > 0);
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);

    assert.ok(found, 'Search should find created jobs');
  });

  test('search variables with filters', async () => {
    // Deploy a process and create an instance with variables
    await deploy(['tests/fixtures/simple.bpmn'], {});

    // Create an instance with variables using the CLI wrapper
    await createProcessInstance({
      processDefinitionId: 'simple-process',
      variables: JSON.stringify({ testVar: 'testValue', count: 42, flag: true }),
    });

    // Poll until the variable appears in search results
    const found = await pollUntil(async () => {
      const result = await searchVariables({
        name: 'testVar',
      });
      return !!(result?.items && result.items.length > 0);
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);

    assert.ok(found, 'Search should find variable by name');
  });

  test('search variables with fullValue option', async () => {
    // Deploy a process and create an instance with a long variable value
    await deploy(['tests/fixtures/simple.bpmn'], {});

    const longValue = 'a'.repeat(1000); // Create a long value that might be truncated

    await createProcessInstance({
      processDefinitionId: 'simple-process',
      variables: JSON.stringify({ longVar: longValue }),
    });

    // Poll until the variable appears in search results with full value
    const found = await pollUntil(async () => {
      const result = await searchVariables({
        name: 'longVar',
        fullValue: true,
      });
      return !!(result?.items && result.items.length > 0);
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);

    assert.ok(found, 'Search with fullValue should find the variable');
  });
});
