/**
 * Unit tests for glob-resolver utility
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { resolveBpmnFiles, extractProcessIdFromContent } from '../../src/utils/glob-resolver.ts';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TEST_BPMN_CONTENT = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL">
  <bpmn:process id="test-process" name="Test Process">
    <bpmn:startEvent id="start" />
  </bpmn:process>
</bpmn:definitions>`;

const TEST_BPMN_CONTENT_2 = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL">
  <bpmn:process id="another-process" name="Another Process">
    <bpmn:startEvent id="start" />
  </bpmn:process>
</bpmn:definitions>`;

describe('glob-resolver utility', () => {
  let testDir: string;

  beforeEach(() => {
    // Create a temporary test directory
    testDir = join(tmpdir(), `c8ctl-glob-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    // Clean up test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('extractProcessIdFromContent', () => {
    test('extracts process ID from BPMN content', () => {
      const processId = extractProcessIdFromContent(TEST_BPMN_CONTENT);
      assert.strictEqual(processId, 'test-process');
    });

    test('returns null for invalid BPMN content', () => {
      const processId = extractProcessIdFromContent('invalid content');
      assert.strictEqual(processId, null);
    });

    test('extracts first process ID when multiple exist', () => {
      const multiProcess = TEST_BPMN_CONTENT.replace('</bpmn:definitions>', 
        '<bpmn:process id="second-process" /></bpmn:definitions>');
      const processId = extractProcessIdFromContent(multiProcess);
      assert.strictEqual(processId, 'test-process');
    });
  });

  describe('resolveBpmnFiles', () => {
    test('resolves single BPMN file by path', () => {
      const filePath = join(testDir, 'test.bpmn');
      writeFileSync(filePath, TEST_BPMN_CONTENT);

      const files = resolveBpmnFiles([filePath]);
      assert.strictEqual(files.length, 1);
      assert.strictEqual(files[0].path, filePath);
    });

    test('returns empty array for non-existent file', () => {
      const files = resolveBpmnFiles([join(testDir, 'nonexistent.bpmn')]);
      assert.strictEqual(files.length, 0);
    });

    test('ignores non-BPMN files', () => {
      const txtPath = join(testDir, 'test.txt');
      writeFileSync(txtPath, 'not a bpmn');

      const files = resolveBpmnFiles([txtPath]);
      assert.strictEqual(files.length, 0);
    });

    test('resolves all BPMN files in directory (non-recursive)', () => {
      writeFileSync(join(testDir, 'test1.bpmn'), TEST_BPMN_CONTENT);
      writeFileSync(join(testDir, 'test2.bpmn'), TEST_BPMN_CONTENT_2);
      writeFileSync(join(testDir, 'other.txt'), 'not bpmn');

      const files = resolveBpmnFiles([testDir]);
      assert.strictEqual(files.length, 2);
    });

    test('resolves BPMN files with * wildcard (non-recursive)', () => {
      writeFileSync(join(testDir, 'test1.bpmn'), TEST_BPMN_CONTENT);
      writeFileSync(join(testDir, 'test2.bpmn'), TEST_BPMN_CONTENT_2);

      const subDir = join(testDir, 'subdir');
      mkdirSync(subDir);
      writeFileSync(join(subDir, 'sub.bpmn'), TEST_BPMN_CONTENT);

      const files = resolveBpmnFiles([join(testDir, '*')]);
      assert.strictEqual(files.length, 2, 'Should only find files in current directory');
    });

    test('resolves BPMN files with ** wildcard (recursive)', () => {
      writeFileSync(join(testDir, 'test1.bpmn'), TEST_BPMN_CONTENT);
      
      const subDir = join(testDir, 'subdir');
      mkdirSync(subDir);
      writeFileSync(join(subDir, 'sub.bpmn'), TEST_BPMN_CONTENT);
      
      const deepDir = join(subDir, 'deep');
      mkdirSync(deepDir);
      writeFileSync(join(deepDir, 'deep.bpmn'), TEST_BPMN_CONTENT_2);

      const files = resolveBpmnFiles([join(testDir, '**')]);
      assert.strictEqual(files.length, 3, 'Should find all files recursively');
    });

    test('resolves specific file patterns with *', () => {
      writeFileSync(join(testDir, 'test1.bpmn'), TEST_BPMN_CONTENT);
      writeFileSync(join(testDir, 'test2.bpmn'), TEST_BPMN_CONTENT_2);
      writeFileSync(join(testDir, 'other.bpmn'), TEST_BPMN_CONTENT);

      const files = resolveBpmnFiles([join(testDir, 'test*.bpmn')]);
      assert.strictEqual(files.length, 2, 'Should only match test*.bpmn files');
    });

    test('deduplicates files from multiple patterns', () => {
      const filePath = join(testDir, 'test.bpmn');
      writeFileSync(filePath, TEST_BPMN_CONTENT);

      // Provide the same file twice via different patterns
      const files = resolveBpmnFiles([filePath, testDir]);
      assert.strictEqual(files.length, 1, 'Should deduplicate the same file');
    });

    test('handles multiple patterns at once', () => {
      writeFileSync(join(testDir, 'file1.bpmn'), TEST_BPMN_CONTENT);
      
      const subDir = join(testDir, 'subdir');
      mkdirSync(subDir);
      writeFileSync(join(subDir, 'file2.bpmn'), TEST_BPMN_CONTENT_2);

      const files = resolveBpmnFiles([
        join(testDir, 'file1.bpmn'),
        join(subDir, '*')
      ]);
      assert.strictEqual(files.length, 2);
    });

    test('returns empty array for patterns with no matches', () => {
      const files = resolveBpmnFiles([join(testDir, 'nonexistent/*')]);
      assert.strictEqual(files.length, 0);
    });
  });
});
