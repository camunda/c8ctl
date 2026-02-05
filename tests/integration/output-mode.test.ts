/**
 * Integration tests for output mode switching
 * Tests the reflective c8 design - verifying that output mode changes are reflected in logger
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pollUntil } from '../utils/polling.ts';
import { ProcessDefinitionId } from '@camunda8/orchestration-cluster-api';

describe('Output Mode Integration Tests', () => {
  let testDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    testDir = join(tmpdir(), `c8ctl-output-mode-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    originalEnv = { ...process.env };
    process.env.XDG_DATA_HOME = testDir;
    
    // Reset c8ctl runtime state before each test
    const { c8ctl } = await import('../../src/runtime.ts');
    c8ctl.activeProfile = undefined;
    c8ctl.activeTenant = undefined;
    c8ctl.outputMode = 'text';
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    process.env = originalEnv;
  });

  test('output mode changes are reflected in list process instances', async () => {
    const { deploy } = await import('../../src/commands/deployments.ts');
    const { setOutputMode } = await import('../../src/config.ts');
    const { listProcessInstances } = await import('../../src/commands/process-instances.ts');
    const { createClient } = await import('../../src/client.ts');
    const { c8ctl } = await import('../../src/runtime.ts');
    
    // Deploy the test process
    await deploy(['tests/fixtures/list-pis/min-usertask.bpmn'], {});
    
    // Create a process instance to ensure we have data
    const client = createClient();
    const instance = await client.createProcessInstance({
      processDefinitionId: ProcessDefinitionId.assumeExists('Process_0t60ay7'),
    });
    
    // Poll for process instance with API-level consistency
    // Note: Elasticsearch indexing can take several seconds, especially in CI environments
    const instanceFound = await pollUntil(
      async () => {
        try {
          const result = await client.searchProcessInstances({
            filter: { processDefinitionId: 'Process_0t60ay7' },
          }, { consistency: { waitUpToMs: 5000 } });
          
          return result.items && result.items.length > 0;
        } catch (error) {
          return false;
        }
      },
      10000,  // max 10 seconds
      200     // poll every 200ms
    );
    
    assert.ok(instanceFound, 'Process instance should be indexed within 10 seconds');
    
    // Capture stdout
    const originalLog = console.log;
    let capturedOutput: string[] = [];
    
    console.log = (...args: any[]) => {
      capturedOutput.push(args.join(' '));
    };
    
    try {
      // Test 1: Set to JSON mode and list
      capturedOutput = [];
      setOutputMode('json');
      
      // Verify runtime was updated
      assert.strictEqual(c8ctl.outputMode, 'json', 'c8ctl.outputMode should be json');
      
      await listProcessInstances({
        processDefinitionId: 'Process_0t60ay7',
      });
      
      // Verify output is JSON
      const jsonOutput = capturedOutput.join('\n');
      assert.ok(jsonOutput.length > 0, 'Should have output');
      
      // Check if output contains JSON-like structures
      const hasJsonFormat = jsonOutput.includes('{') && jsonOutput.includes('}');
      assert.ok(hasJsonFormat, `Output should be JSON format. Got: ${jsonOutput}`);
      
      // Try to parse at least one line as JSON
      const outputLines = capturedOutput.filter(line => line.trim().length > 0);
      let foundValidJson = false;
      for (const line of outputLines) {
        try {
          JSON.parse(line);
          foundValidJson = true;
          break;
        } catch (e) {
          // Not JSON, continue
        }
      }
      assert.ok(foundValidJson, `Should have at least one valid JSON line. Got: ${jsonOutput}`);
      
      // Test 2: Set to text mode and list
      capturedOutput = [];
      setOutputMode('text');
      
      // Verify runtime was updated
      assert.strictEqual(c8ctl.outputMode, 'text', 'c8ctl.outputMode should be text');
      
      await listProcessInstances({
        processDefinitionId: 'Process_0t60ay7',
      });
      
      // Verify output is text (table format)
      const textOutput = capturedOutput.join('\n');
      assert.ok(textOutput.length > 0, 'Should have output');
      
      // Text output should have table separators like '|' or '-'
      const hasTableFormat = textOutput.includes('|') || textOutput.includes('---');
      assert.ok(hasTableFormat, `Output should be text table format. Got: ${textOutput}`);
      
      // Should NOT be pure JSON
      const isPureJson = !hasTableFormat && textOutput.includes('{') && textOutput.includes('[');
      assert.ok(!isPureJson, `Output should NOT be pure JSON in text mode. Got: ${textOutput}`);
      
    } finally {
      console.log = originalLog;
    }
  });
});
