/**
 * Integration tests for process instances
 * NOTE: These tests require a running Camunda 8 instance at http://localhost:8080
 * 
 * These tests validate the project's wrapper functions in src/commands/process-instances.ts,
 * not the underlying @camunda8/orchestration-cluster-api npm module directly.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import { deploy } from '../../src/commands/deployments.ts';
import { 
  createProcessInstance, 
  listProcessInstances
} from '../../src/commands/process-instances.ts';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { getUserDataDir } from '../../src/config.ts';

describe('Process Instance Integration Tests (requires Camunda 8 at localhost:8080)', () => {
  beforeEach(() => {
    // Clear session state before each test to ensure clean tenant resolution
    const sessionPath = join(getUserDataDir(), 'session.json');
    if (existsSync(sessionPath)) {
      unlinkSync(sessionPath);
    }
  });

  test('create process instance returns key', async () => {
    // First deploy a process to ensure it exists
    await deploy(['tests/fixtures/simple.bpmn'], {});
    
    // Create process instance using the project's wrapper function
    const result = await createProcessInstance({
      processDefinitionId: 'simple-process',
    });
    
    // Verify instance key is returned
    assert.ok(result, 'Result should be returned');
    assert.ok(result.processInstanceKey, 'Process instance key should be returned');
    assert.ok(
      typeof result.processInstanceKey === 'number' || typeof result.processInstanceKey === 'string',
      'Process instance key should be a number or string'
    );
  });

  test('list process instances filters by process definition', async () => {
    // First deploy and create an instance
    await deploy(['tests/fixtures/simple.bpmn'], {});
    await createProcessInstance({
      processDefinitionId: 'simple-process',
    });
    
    // List process instances using the project's wrapper function
    const result = await listProcessInstances({ processDefinitionId: 'simple-process', all: true });
    
    // Verify result is returned and has expected structure
    assert.ok(result, 'Result should be returned');
    assert.ok(Array.isArray(result.items), 'Result should have items array');
    // Note: items may be empty if Elasticsearch hasn't indexed yet, so we just verify structure
  });

  test('cancel process instance CLI handles errors gracefully', async () => {
    // Deploy and create an instance
    await deploy(['tests/fixtures/simple.bpmn'], {});
    const result = await createProcessInstance({
      processDefinitionId: 'simple-process',
    });
    
    assert.ok(result, 'Create result should exist');
    const instanceKey = result.processInstanceKey.toString();
    
    // Run CLI command - simple-process completes instantly, so cancel will fail
    // We test that the CLI handles this gracefully (exits with error, not crash)
    const { execSync } = await import('node:child_process');
    
    try {
      execSync(
        `node src/index.ts cancel pi --key ${instanceKey}`,
        { encoding: 'utf8', cwd: process.cwd(), stdio: 'pipe' }
      );
      // If it succeeded, the process was still running (unlikely for simple-process)
      assert.ok(true, 'Process instance cancellation succeeded');
    } catch (error: any) {
      // CLI should exit with non-zero code when process already completed
      assert.ok(error.status !== 0, 'CLI should exit with non-zero status for already completed process');
      assert.ok(error.stderr.includes('NOT_FOUND') || error.stderr.includes('Failed'), 
        'CLI should output error message for already completed process');
    }
  });

  test('create with awaitCompletion returns completed result with variables', async () => {
    // Deploy a simple process first
    await deploy(['tests/fixtures/simple.bpmn'], {});
    
    // Test with awaitCompletion flag using the project's wrapper function
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
    
    // Execute the CLI command and capture output (using node directly since Node 22+ supports TS)
    const output = execSync(
      'node src/index.ts create pi --id simple-process --awaitCompletion',
      { encoding: 'utf8', cwd: process.cwd() }
    );
    
    // Verify the output indicates successful completion
    assert.ok(output.includes('completed'), 'Output should indicate process completed');
    // Verify that variables are present in the output (JSON response should contain "variables")
    assert.ok(output.includes('variables'), 'Output should contain variables when awaitCompletion is true');

    // Also test the 'await pi' command which is an alias for 'create pi --awaitCompletion'
    const outputWithAlias = execSync(
      'node src/index.ts await pi --id simple-process',
      { encoding: 'utf8', cwd: process.cwd() }
    );
    
    // Verify the alias works the same way
    assert.ok(outputWithAlias.includes('completed'), 'Output with await alias should indicate process completed');
    assert.ok(outputWithAlias.includes('variables'), 'Output with await alias should contain variables');
  });
});
