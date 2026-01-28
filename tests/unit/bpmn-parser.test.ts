/**
 * Unit tests for BPMN parser (process ID extraction)
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Extract process ID from BPMN file (same logic as run command)
 */
function extractProcessId(bpmnContent: string): string | null {
  const match = bpmnContent.match(/process[^>]+id="([^"]+)"/);
  return match ? match[1] : null;
}

describe('BPMN Parser', () => {
  test('extractProcessId extracts ID from simple BPMN', () => {
    const bpmnPath = join(__dirname, '../fixtures/simple.bpmn');
    const content = readFileSync(bpmnPath, 'utf-8');
    const processId = extractProcessId(content);
    
    assert.strictEqual(processId, 'simple-process');
  });

  test('extractProcessId extracts ID from building block BPMN', () => {
    const bpmnPath = join(__dirname, '../fixtures/_bb-building-block/bb-process.bpmn');
    const content = readFileSync(bpmnPath, 'utf-8');
    const processId = extractProcessId(content);
    
    assert.strictEqual(processId, 'building-block-process');
  });

  test('extractProcessId extracts ID from main process', () => {
    const bpmnPath = join(__dirname, '../fixtures/sample-project/main.bpmn');
    const content = readFileSync(bpmnPath, 'utf-8');
    const processId = extractProcessId(content);
    
    assert.strictEqual(processId, 'main-process');
  });

  test('extractProcessId extracts ID from sub process', () => {
    const bpmnPath = join(__dirname, '../fixtures/sample-project/sub-folder/sub.bpmn');
    const content = readFileSync(bpmnPath, 'utf-8');
    const processId = extractProcessId(content);
    
    assert.strictEqual(processId, 'sub-process');
  });

  test('extractProcessId returns null for invalid BPMN', () => {
    const invalidBpmn = '<bpmn:definitions></bpmn:definitions>';
    const processId = extractProcessId(invalidBpmn);
    
    assert.strictEqual(processId, null);
  });

  test('extractProcessId handles process with attributes before id', () => {
    const bpmn = '<bpmn:process name="Test" isExecutable="true" id="test-id">';
    const processId = extractProcessId(bpmn);
    
    assert.strictEqual(processId, 'test-id');
  });

  test('extractProcessId handles process with attributes after id', () => {
    const bpmn = '<bpmn:process id="test-id" name="Test" isExecutable="true">';
    const processId = extractProcessId(bpmn);
    
    assert.strictEqual(processId, 'test-id');
  });

  test('extractProcessId extracts first process ID if multiple', () => {
    const bpmn = `
      <bpmn:process id="first-process">
      <bpmn:process id="second-process">
    `;
    const processId = extractProcessId(bpmn);
    
    assert.strictEqual(processId, 'first-process');
  });
});
