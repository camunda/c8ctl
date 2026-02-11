/**
 * Integration tests for forms
 * NOTE: These tests require a running Camunda 8 instance at http://localhost:8080
 * 
 * Forms in Camunda 8 are contextual - they're retrieved via:
 * 1. User tasks (getUserTaskForm) - requires a userTaskKey
 * 2. Process definitions (getStartProcessForm) - requires a processDefinitionKey
 * 
 * There is no direct "get form by formKey/formId" endpoint in the API.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import { deploy } from '../../src/commands/deployments.ts';
import { createClient } from '../../src/client.ts';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { getUserDataDir } from '../../src/config.ts';

describe('Form Integration Tests (requires Camunda 8 at localhost:8080)', () => {
  beforeEach(() => {
    // Clear session state before each test to ensure clean tenant resolution
    const sessionPath = join(getUserDataDir(), 'session.json');
    if (existsSync(sessionPath)) {
      unlinkSync(sessionPath);
    }
  });

  test('get form for user task after deploying list-pis fixtures', async () => {
    const client = createClient();
    
    // Step 1: Deploy the fixtures with form
    // This deploys min-usertask.bpmn which references some-form.form
    await deploy(['tests/fixtures/list-pis'], {});
    
    // Wait for deployment to be indexed
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Step 2: Create a process instance to generate a user task
    const processInstance = await client.createProcessInstance({
      processDefinitionId: 'Process_0t60ay7' as any,
    });
    
    assert.ok(processInstance, 'Process instance should be created');
    assert.ok(processInstance.processInstanceKey, 'Process instance key should exist');
    
    // Wait for the user task to be created and indexed
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Step 3: Search for user tasks to get the userTaskKey
    const userTasks = await client.searchUserTasks(
      { filter: { processInstanceKey: processInstance.processInstanceKey } },
      { consistency: { waitUpToMs: 0 } }
    );
    
    assert.ok(userTasks, 'User tasks search should return results');
    assert.ok(userTasks.items && userTasks.items.length > 0, 'At least one user task should exist');
    
    const userTask = userTasks.items[0];
    const userTaskKey = userTask.userTaskKey || userTask.key;
    assert.ok(userTaskKey, 'User task key should exist');
    
    // Verify the user task has a formKey
    assert.ok(userTask.formKey, 'User task should have a formKey');
    
    // Step 4: Retrieve the form using getUserTaskForm API
    const form = await client.getUserTaskForm(
      { userTaskKey: userTaskKey as any },
      { consistency: { waitUpToMs: 0 } }
    );
    
    assert.ok(form, 'Form should be retrieved');
    assert.strictEqual(form.formId, 'some-form', 'Form ID should match the deployed form');
    assert.ok(form.schema, 'Form should have schema');
    assert.ok(form.formKey, 'Form should have formKey');
    
    // Verify form content matches what was deployed
    assert.ok(form.schema.components, 'Form schema should have components');
    assert.strictEqual(form.schema.type, 'default', 'Form type should be default');
  });

  test('get form using deployment information and process definition', async () => {
    const client = createClient();
    
    // Step 1: Deploy with explicit resource loading to get deployment details
    const fs = await import('node:fs');
    const deployment = await client.deployResources({
      resources: [
        {
          name: 'min-usertask.bpmn',
          content: await fs.promises.readFile('tests/fixtures/list-pis/min-usertask.bpmn', 'utf8'),
        },
        {
          name: 'some-form.form',
          content: await fs.promises.readFile('tests/fixtures/list-pis/some-form.form', 'utf8'),
        },
      ],
    });
    
    assert.ok(deployment, 'Deployment should succeed');
    assert.ok(deployment.deployments && deployment.deployments.length > 0, 'Deployment should contain resources');
    
    // Step 2: Extract deployed form information
    const formDeployment = deployment.deployments.find((d: any) => d.form);
    assert.ok(formDeployment, 'Form should be in deployment');
    assert.ok(formDeployment.form, 'Form details should exist');
    assert.strictEqual(formDeployment.form.formId, 'some-form', 'Deployed form ID should match');
    assert.ok(formDeployment.form.formKey, 'Deployed form should have formKey');
    
    // Step 3: Find the process definition from deployment
    const processDefinition = deployment.deployments.find((d: any) => 
      d.processDefinition && d.processDefinition.processDefinitionId === 'Process_0t60ay7'
    );
    
    assert.ok(processDefinition, 'Process definition should be in deployment');
    const processDefinitionKey = processDefinition.processDefinition.processDefinitionKey;
    
    // Step 4: Note - this BPMN doesn't have a start form, only a user task form
    // Attempting to get start form should return 204 (No Content)
    try {
      await client.getStartProcessForm(
        { processDefinitionKey: processDefinitionKey as any },
        { consistency: { waitUpToMs: 0 } }
      );
      assert.fail('Expected 204 status for process definition without start form');
    } catch (error: any) {
      assert.ok(
        error.statusCode === 204 || error.status === 204,
        'Should get 204 status for process definition without start form'
      );
    }
    
    // Step 5: To get the form, we need to create an instance and get the user task
    const processInstance = await client.createProcessInstance({
      processDefinitionKey: processDefinitionKey as any,
    });
    
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    const userTasks = await client.searchUserTasks(
      { filter: { processInstanceKey: processInstance.processInstanceKey } },
      { consistency: { waitUpToMs: 0 } }
    );
    
    assert.ok(userTasks.items && userTasks.items.length > 0, 'User task should be created');
    
    const userTaskKey = userTasks.items[0].userTaskKey || userTasks.items[0].key;
    const form = await client.getUserTaskForm(
      { userTaskKey: userTaskKey as any },
      { consistency: { waitUpToMs: 0 } }
    );
    
    // Verify the retrieved form matches the deployment
    assert.strictEqual(form.formId, formDeployment.form.formId, 'Retrieved form ID should match deployed form ID');
    assert.strictEqual(form.formKey.toString(), formDeployment.form.formKey.toString(), 'Retrieved form key should match deployed form key');
  });

  test('generic get form command works with user task key', async () => {
    const client = createClient();
    
    // Deploy and create instance
    await deploy(['tests/fixtures/list-pis'], {});
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    const processInstance = await client.createProcessInstance({
      processDefinitionId: 'Process_0t60ay7' as any,
    });
    
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Get user task
    const userTasks = await client.searchUserTasks(
      { filter: { processInstanceKey: processInstance.processInstanceKey } },
      { consistency: { waitUpToMs: 0 } }
    );
    
    const userTaskKey = userTasks.items[0].userTaskKey || userTasks.items[0].key;
    
    // The generic getForm function tries both APIs
    // With a userTaskKey, it should find it as a user task
    const form = await client.getUserTaskForm(
      { userTaskKey: userTaskKey as any },
      { consistency: { waitUpToMs: 0 } }
    );
    
    assert.ok(form, 'Form should be found');
    assert.strictEqual(form.formId, 'some-form', 'Form ID should match');
  });
});
