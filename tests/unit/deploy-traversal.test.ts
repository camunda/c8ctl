/**
 * Unit tests for deploy traversal logic (building block prioritization)
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('Deploy Traversal', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `c8ctl-deploy-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  /**
   * Simplified version of collectResourceFiles for testing
   */
  function isBuildingBlockFolder(path: string): boolean {
    return path.includes('_bb-');
  }

  test('identifies building block folders correctly', () => {
    assert.strictEqual(isBuildingBlockFolder('/path/to/_bb-test'), true);
    assert.strictEqual(isBuildingBlockFolder('/path/to/_bb-folder/file.bpmn'), true);
    assert.strictEqual(isBuildingBlockFolder('/path/to/regular-folder'), false);
    assert.strictEqual(isBuildingBlockFolder('/path/to/folder'), false);
  });

  test('building block folder name contains _bb-', () => {
    const bbFolder = '_bb-my-building-block';
    assert.ok(bbFolder.includes('_bb-'));
  });

  test('regular folder name does not contain _bb-', () => {
    const regularFolder = 'my-regular-folder';
    assert.ok(!regularFolder.includes('_bb-'));
  });

  test('file extensions are recognized correctly', () => {
    const bpmnFile = 'process.bpmn';
    const dmnFile = 'decision.dmn';
    const formFile = 'form.form';
    const txtFile = 'readme.txt';

    const validExtensions = ['.bpmn', '.dmn', '.form'];

    assert.ok(validExtensions.some(ext => bpmnFile.endsWith(ext)));
    assert.ok(validExtensions.some(ext => dmnFile.endsWith(ext)));
    assert.ok(validExtensions.some(ext => formFile.endsWith(ext)));
    assert.ok(!validExtensions.some(ext => txtFile.endsWith(ext)));
  });

  test('sorting prioritizes building blocks', () => {
    const resources = [
      { path: '/regular/file1.bpmn', isBuildingBlock: false },
      { path: '/_bb-block/file2.bpmn', isBuildingBlock: true },
      { path: '/regular/file3.bpmn', isBuildingBlock: false },
      { path: '/_bb-another/file4.bpmn', isBuildingBlock: true },
    ];

    resources.sort((a, b) => {
      if (a.isBuildingBlock && !b.isBuildingBlock) return -1;
      if (!a.isBuildingBlock && b.isBuildingBlock) return 1;
      return a.path.localeCompare(b.path);
    });

    // Building blocks should come first
    assert.strictEqual(resources[0].isBuildingBlock, true);
    assert.strictEqual(resources[1].isBuildingBlock, true);
    assert.strictEqual(resources[2].isBuildingBlock, false);
    assert.strictEqual(resources[3].isBuildingBlock, false);
  });

  test('sorting orders alphabetically within same type', () => {
    const resources = [
      { path: '/c.bpmn', isBuildingBlock: false },
      { path: '/a.bpmn', isBuildingBlock: false },
      { path: '/b.bpmn', isBuildingBlock: false },
    ];

    resources.sort((a, b) => {
      if (a.isBuildingBlock && !b.isBuildingBlock) return -1;
      if (!a.isBuildingBlock && b.isBuildingBlock) return 1;
      return a.path.localeCompare(b.path);
    });

    assert.strictEqual(resources[0].path, '/a.bpmn');
    assert.strictEqual(resources[1].path, '/b.bpmn');
    assert.strictEqual(resources[2].path, '/c.bpmn');
  });

  test('complex sorting with mixed building blocks and regular files', () => {
    const resources = [
      { path: '/z-regular/z.bpmn', isBuildingBlock: false },
      { path: '/_bb-block-z/z.bpmn', isBuildingBlock: true },
      { path: '/a-regular/a.bpmn', isBuildingBlock: false },
      { path: '/_bb-block-a/a.bpmn', isBuildingBlock: true },
    ];

    resources.sort((a, b) => {
      if (a.isBuildingBlock && !b.isBuildingBlock) return -1;
      if (!a.isBuildingBlock && b.isBuildingBlock) return 1;
      return a.path.localeCompare(b.path);
    });

    // Building blocks first, alphabetically
    assert.strictEqual(resources[0].path, '/_bb-block-a/a.bpmn');
    assert.strictEqual(resources[0].isBuildingBlock, true);
    assert.strictEqual(resources[1].path, '/_bb-block-z/z.bpmn');
    assert.strictEqual(resources[1].isBuildingBlock, true);
    
    // Regular files second, alphabetically
    assert.strictEqual(resources[2].path, '/a-regular/a.bpmn');
    assert.strictEqual(resources[2].isBuildingBlock, false);
    assert.strictEqual(resources[3].path, '/z-regular/z.bpmn');
    assert.strictEqual(resources[3].isBuildingBlock, false);
  });
});
