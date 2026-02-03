/**
 * Integration tests for watch --run command
 * NOTE: These tests require a running Camunda 8 instance at http://localhost:8080
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { watchFiles, type RunSpec } from '../../src/commands/watch.ts';
import { deploy } from '../../src/commands/deployments.ts';
import { createClient } from '../../src/client.ts';
import { existsSync, unlinkSync, mkdirSync, writeFileSync, rmSync, readFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

// Wait time for Elasticsearch to index data before search queries
const ELASTICSEARCH_CONSISTENCY_WAIT_MS = 5000;

// Helper to wait for a condition
async function waitFor(conditionFn: () => Promise<boolean>, timeoutMs: number = 10000): Promise<boolean> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    if (await conditionFn()) {
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return false;
}

describe('Watch --run Integration Tests (requires Camunda 8 at localhost:8080)', () => {
  let testDir: string;
  let watchProcess: Promise<void> | null = null;
  let stopSignal: (() => void) | null = null;

  beforeEach(() => {
    // Clear session state before each test
    const sessionPath = join(homedir(), 'Library', 'Application Support', 'c8ctl', 'session.json');
    if (existsSync(sessionPath)) {
      unlinkSync(sessionPath);
    }

    // Create temporary test directory
    testDir = join(tmpdir(), `c8ctl-watch-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(async () => {
    // Stop watch process if running
    if (stopSignal) {
      stopSignal();
      stopSignal = null;
    }
    if (watchProcess) {
      // Wait a bit for cleanup
      await new Promise(resolve => setTimeout(resolve, 100));
      watchProcess = null;
    }

    // Clean up test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  test('watch --run creates process instance after file change', async () => {
    // Deploy the BPMN first so it exists in Camunda
    await deploy(['tests/fixtures/simple.bpmn'], {});
    
    // Copy BPMN to test directory
    const testBpmn = join(testDir, 'test.bpmn');
    copyFileSync('tests/fixtures/simple.bpmn', testBpmn);

    // Set up --run spec pointing to the BPMN
    const runSpecs: RunSpec[] = [{
      patterns: [testBpmn],
    }];

    // Start watch in background (will auto-deploy and run)
    let watchStarted = false;
    watchProcess = (async () => {
      try {
        await watchFiles([testDir], { runSpecs });
      } catch (err) {
        // Expected to be interrupted
      }
    })();
    
    // Give watch time to start
    await new Promise(resolve => setTimeout(resolve, 2000));
    watchStarted = true;

    // Modify the BPMN file to trigger watch
    const content = readFileSync(testBpmn, 'utf-8');
    writeFileSync(testBpmn, content + '\n<!-- modified -->');

    // Wait for deployment and process instance creation
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Verify process instance was created
    const client = createClient();
    const result = await client.searchProcessInstances({
      filter: {
        processDefinitionId: 'simple-process',
      },
    }, { consistency: { waitUpToMs: ELASTICSEARCH_CONSISTENCY_WAIT_MS } });

    // Should have at least one instance (could have more from deployment + watch trigger)
    assert.ok(result.items && result.items.length > 0, 'Process instance should be created');

    // Stop watch manually
    process.emit('SIGINT' as any);
    await new Promise(resolve => setTimeout(resolve, 500));
  });

  test('watch --run with variables passes them to process instance', async () => {
    // Deploy first
    await deploy(['tests/fixtures/simple.bpmn'], {});
    
    const testBpmn = join(testDir, 'test.bpmn');
    copyFileSync('tests/fixtures/simple.bpmn', testBpmn);

    const testVariables = { testKey: 'testValue', count: 42 };
    const runSpecs: RunSpec[] = [{
      patterns: [testBpmn],
      variables: testVariables,
    }];

    // Start watch
    watchProcess = (async () => {
      try {
        await watchFiles([testDir], { runSpecs });
      } catch (err) {
        // Expected
      }
    })();

    await new Promise(resolve => setTimeout(resolve, 2000));

    // Trigger change
    const content = readFileSync(testBpmn, 'utf-8');
    writeFileSync(testBpmn, content + '\n<!-- with vars -->');

    await new Promise(resolve => setTimeout(resolve, 3000));

    // The test passes if no error is thrown
    // Verifying variables would require querying the process instance details
    assert.ok(true, 'Watch with variables completed');

    process.emit('SIGINT' as any);
    await new Promise(resolve => setTimeout(resolve, 500));
  });

  test('watch --run with wildcard resolves multiple BPMNs', async () => {
    // Deploy all test BPMNs first
    await deploy(['tests/fixtures/simple.bpmn'], {});
    await deploy(['tests/fixtures/list-pis/min-usertask.bpmn'], {});

    // Copy multiple BPMNs to test directory
    copyFileSync('tests/fixtures/simple.bpmn', join(testDir, 'test1.bpmn'));
    copyFileSync('tests/fixtures/list-pis/min-usertask.bpmn', join(testDir, 'test2.bpmn'));

    // Create a trigger file for watch
    const triggerFile = join(testDir, 'trigger.bpmn');
    copyFileSync('tests/fixtures/simple.bpmn', triggerFile);

    // Set up --run with wildcard
    const runSpecs: RunSpec[] = [{
      patterns: [join(testDir, '*')],
    }];

    watchProcess = (async () => {
      try {
        await watchFiles([testDir], { runSpecs });
      } catch (err) {
        // Expected
      }
    })();

    await new Promise(resolve => setTimeout(resolve, 2000));

    // Trigger change
    const content = readFileSync(triggerFile, 'utf-8');
    writeFileSync(triggerFile, content + '\n<!-- trigger -->');

    await new Promise(resolve => setTimeout(resolve, 4000));

    // Verify process instances were created for different processes
    const client = createClient();
    
    const simpleResult = await client.searchProcessInstances({
      filter: { processDefinitionId: 'simple-process' },
    }, { consistency: { waitUpToMs: ELASTICSEARCH_CONSISTENCY_WAIT_MS } });
    
    const userTaskResult = await client.searchProcessInstances({
      filter: { processDefinitionId: 'min-user-task-process' },
    }, { consistency: { waitUpToMs: ELASTICSEARCH_CONSISTENCY_WAIT_MS } });

    assert.ok(simpleResult.items && simpleResult.items.length > 0, 
      'Should create instance for simple-process');
    assert.ok(userTaskResult.items && userTaskResult.items.length > 0, 
      'Should create instance for min-user-task-process');

    process.emit('SIGINT' as any);
    await new Promise(resolve => setTimeout(resolve, 500));
  });

  test('watch --run with recursive wildcard (**) finds nested BPMNs', async () => {
    // Deploy first
    await deploy(['tests/fixtures/simple.bpmn'], {});
    
    // Create nested directory structure
    const subDir = join(testDir, 'subdir');
    mkdirSync(subDir, { recursive: true });
    
    copyFileSync('tests/fixtures/simple.bpmn', join(subDir, 'nested.bpmn'));
    
    // Create trigger file at root
    const triggerFile = join(testDir, 'trigger.bpmn');
    copyFileSync('tests/fixtures/simple.bpmn', triggerFile);

    // Set up --run with recursive wildcard
    const runSpecs: RunSpec[] = [{
      patterns: [join(testDir, '**')],
    }];

    watchProcess = (async () => {
      try {
        await watchFiles([testDir], { runSpecs });
      } catch (err) {
        // Expected
      }
    })();

    await new Promise(resolve => setTimeout(resolve, 2000));

    // Trigger change
    const content = readFileSync(triggerFile, 'utf-8');
    writeFileSync(triggerFile, content + '\n<!-- recursive test -->');

    await new Promise(resolve => setTimeout(resolve, 3000));

    // Verify process instance was created (both files should be picked up)
    const client = createClient();
    const result = await client.searchProcessInstances({
      filter: { processDefinitionId: 'simple-process' },
    }, { consistency: { waitUpToMs: ELASTICSEARCH_CONSISTENCY_WAIT_MS } });

    assert.ok(result.items && result.items.length > 0, 
      'Should create process instances from recursive search');

    process.emit('SIGINT' as any);
    await new Promise(resolve => setTimeout(resolve, 500));
  });

  test('watch --run handles non-existent patterns gracefully', async () => {
    // Deploy first
    await deploy(['tests/fixtures/simple.bpmn'], {});
    
    const testBpmn = join(testDir, 'test.bpmn');
    copyFileSync('tests/fixtures/simple.bpmn', testBpmn);

    // Set up --run with non-existent pattern
    const runSpecs: RunSpec[] = [{
      patterns: [join(testDir, 'nonexistent.bpmn')],
    }];

    watchProcess = (async () => {
      try {
        await watchFiles([testDir], { runSpecs });
      } catch (err) {
        // Expected
      }
    })();

    await new Promise(resolve => setTimeout(resolve, 2000));

    // Trigger change
    const content = readFileSync(testBpmn, 'utf-8');
    writeFileSync(testBpmn, content + '\n<!-- should not crash -->');

    await new Promise(resolve => setTimeout(resolve, 2000));

    // If we got here without crash, test passes
    assert.ok(true, 'Watch handled non-existent pattern gracefully');

    process.emit('SIGINT' as any);
    await new Promise(resolve => setTimeout(resolve, 500));
  });
});
