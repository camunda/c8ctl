/**
 * Integration tests for forms
 * NOTE: These tests require a running Camunda 8 instance at http://localhost:8080
 * 
 * These tests validate the project's wrapper functions in src/commands/forms.ts,
 * not the underlying @camunda8/orchestration-cluster-api npm module directly.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import { deploy } from '../../src/commands/deployments.ts';
import { createClient } from '../../src/client.ts';
import { createProcessInstance } from '../../src/commands/process-instances.ts';
import { getUserTaskForm, getStartForm, getForm } from '../../src/commands/forms.ts';
import { pollUntil } from '../utils/polling.ts';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { getUserDataDir } from '../../src/config.ts';

describe('Form Integration Tests', () => {
  beforeEach(() => {
    // Clear session state before each test to ensure clean tenant resolution
    const sessionPath = join(getUserDataDir(), 'session.json');
    if (existsSync(sessionPath)) {
      unlinkSync(sessionPath);
    }
  });

  test('get form for user task after deploying list-pis fixtures', async () => {
    const client = createClient();
    
    // Deploy the fixtures with form
    await deploy(['tests/fixtures/list-pis'], {});
    
    // Poll until process definition is indexed
    const definitionFound = await pollUntil(async () => {
      const defs = await client.searchProcessDefinitions(
        { filter: { processDefinitionId: 'Process_0t60ay7' as any } },
        { consistency: { waitUpToMs: 0 } }
      );
      return defs.items && defs.items.length > 0;
    }, 10000, 200);
    assert.ok(definitionFound, 'Process definition should be indexed');
    
    // Create a process instance to generate a user task using CLI wrapper
    const processInstance = await createProcessInstance({
      processDefinitionId: 'Process_0t60ay7',
    });
    
    assert.ok(processInstance, 'Process instance should be created');
    assert.ok(processInstance.processInstanceKey, 'Process instance key should exist');
    
    // Poll until user task is available
    let userTaskKey: string | undefined;
    const userTaskFound = await pollUntil(async () => {
      const userTasks = await client.searchUserTasks(
        { filter: { processInstanceKey: processInstance.processInstanceKey as any } },
        { consistency: { waitUpToMs: 0 } }
      );
      if (userTasks.items && userTasks.items.length > 0 && userTasks.items[0].formKey) {
        userTaskKey = userTasks.items[0].userTaskKey?.toString();
        return true;
      }
      return false;
    }, 10000, 200);
    assert.ok(userTaskFound, 'User task should be created and indexed');
    assert.ok(userTaskKey, 'User task key should exist');
    
    // Retrieve the form using the project's getUserTaskForm wrapper
    const form = await getUserTaskForm(userTaskKey!, {});
    
    assert.ok(form, 'Form should be retrieved');
    assert.strictEqual(form.formId, 'some-form', 'Form ID should match the deployed form');
    assert.ok(form.schema, 'Form should have schema');
    assert.ok(form.formKey, 'Form should have formKey');
  });

  test('getStartForm returns undefined for process without start form', async () => {
    const client = createClient();
    
    // Deploy the fixtures with form
    await deploy(['tests/fixtures/list-pis'], {});
    
    // Poll until process definition is indexed
    let processDefinitionKey: string | undefined;
    const definitionFound = await pollUntil(async () => {
      const definitions = await client.searchProcessDefinitions(
        { filter: { processDefinitionId: 'Process_0t60ay7' as any } },
        { consistency: { waitUpToMs: 0 } }
      );
      if (definitions.items && definitions.items.length > 0) {
        processDefinitionKey = (definitions.items[0] as any).processDefinitionKey?.toString();
        return true;
      }
      return false;
    }, 10000, 200);
    assert.ok(definitionFound, 'Process definition should exist');
    assert.ok(processDefinitionKey, 'Process definition key should exist');
    
    // This BPMN doesn't have a start form, so getStartForm should return undefined
    const result = await getStartForm(processDefinitionKey!, {});
    
    assert.strictEqual(result, undefined, 'Should return undefined for process definition without start form');
  });

  test('getUserTaskForm retrieves form matching deployed form ID', async () => {
    const client = createClient();
    
    // Deploy the fixtures with form
    await deploy(['tests/fixtures/list-pis'], {});
    
    // Poll until process definition is indexed
    const definitionFound = await pollUntil(async () => {
      const defs = await client.searchProcessDefinitions(
        { filter: { processDefinitionId: 'Process_0t60ay7' as any } },
        { consistency: { waitUpToMs: 0 } }
      );
      return defs.items && defs.items.length > 0;
    }, 10000, 200);
    assert.ok(definitionFound, 'Process definition should be indexed');
    
    // Create instance using CLI wrapper
    const processInstance = await createProcessInstance({
      processDefinitionId: 'Process_0t60ay7',
    });
    assert.ok(processInstance, 'Process instance should be created');
    
    // Poll until user task is available
    let userTaskKey: string | undefined;
    const userTaskFound = await pollUntil(async () => {
      const userTasks = await client.searchUserTasks(
        { filter: { processInstanceKey: processInstance.processInstanceKey as any } },
        { consistency: { waitUpToMs: 0 } }
      );
      if (userTasks.items && userTasks.items.length > 0) {
        userTaskKey = userTasks.items[0].userTaskKey?.toString();
        return !!userTaskKey;
      }
      return false;
    }, 10000, 200);
    assert.ok(userTaskFound, 'User task should be created');
    assert.ok(userTaskKey, 'User task key should exist');
    
    // Use the project's getUserTaskForm wrapper
    const form = await getUserTaskForm(userTaskKey!, {});
    
    // Verify the retrieved form matches the expected form ID
    assert.ok(form, 'Form should be retrieved');
    assert.strictEqual(form.formId, 'some-form', 'Retrieved form ID should match deployed form ID');
    assert.ok(form.formKey, 'Retrieved form should have formKey');
  });

  test('getForm finds user task form with user task key', async () => {
    const client = createClient();
    
    // Deploy and create instance using CLI wrapper
    await deploy(['tests/fixtures/list-pis'], {});
    
    // Poll until process definition is indexed
    const definitionFound = await pollUntil(async () => {
      const defs = await client.searchProcessDefinitions(
        { filter: { processDefinitionId: 'Process_0t60ay7' as any } },
        { consistency: { waitUpToMs: 0 } }
      );
      return defs.items && defs.items.length > 0;
    }, 10000, 200);
    assert.ok(definitionFound, 'Process definition should be indexed');
    
    const processInstance = await createProcessInstance({
      processDefinitionId: 'Process_0t60ay7',
    });
    assert.ok(processInstance, 'Process instance should be created');
    
    // Poll until user task is available
    let userTaskKey: string | undefined;
    const userTaskFound = await pollUntil(async () => {
      const userTasks = await client.searchUserTasks(
        { filter: { processInstanceKey: processInstance.processInstanceKey as any } },
        { consistency: { waitUpToMs: 0 } }
      );
      if (userTasks.items && userTasks.items.length > 0) {
        userTaskKey = userTasks.items[0].userTaskKey?.toString();
        return !!userTaskKey;
      }
      return false;
    }, 10000, 200);
    assert.ok(userTaskFound, 'User task should be created');
    assert.ok(userTaskKey, 'User task key should exist');
    
    // Use the generic getForm function which tries both user task and process definition APIs
    const result = await getForm(userTaskKey!, {});
    
    assert.ok(result, 'Form result should be returned');
    assert.strictEqual(result.type, 'user task', 'Should find form via user task API');
    assert.strictEqual(result.key, userTaskKey, 'Should return the user task key');
    assert.strictEqual(result.form.formId, 'some-form', 'Form ID should match');
  });
});
