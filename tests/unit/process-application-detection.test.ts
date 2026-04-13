/**
 * Unit tests for process application auto-detection (issue #227)
 *
 * Verifies that c8ctl can walk up the directory tree to find a
 * .process-application marker file and resolve the application root,
 * mirroring Desktop Modeler's behavior.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findProcessApplicationRoot } from '../../src/commands/deployments.ts';

describe('Process Application Detection', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `c8ctl-pa-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  test('detects .process-application in the current directory', () => {
    writeFileSync(join(testDir, '.process-application'), '');
    const result = findProcessApplicationRoot(testDir);
    assert.strictEqual(result, testDir);
  });

  test('detects .process-application in a parent directory', () => {
    const subDir = join(testDir, 'src', 'processes');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(testDir, '.process-application'), '');

    const result = findProcessApplicationRoot(subDir);
    assert.strictEqual(result, testDir);
  });

  test('detects .process-application several levels up', () => {
    const deepDir = join(testDir, 'a', 'b', 'c', 'd');
    mkdirSync(deepDir, { recursive: true });
    writeFileSync(join(testDir, '.process-application'), '');

    const result = findProcessApplicationRoot(deepDir);
    assert.strictEqual(result, testDir);
  });

  test('returns null when no .process-application exists', () => {
    const subDir = join(testDir, 'some-folder');
    mkdirSync(subDir, { recursive: true });

    const result = findProcessApplicationRoot(subDir);
    assert.strictEqual(result, null);
  });

  test('finds the nearest .process-application (closest ancestor wins)', () => {
    // Outer PA root
    writeFileSync(join(testDir, '.process-application'), '');

    // Inner PA root (nested process application)
    const innerPA = join(testDir, 'inner-app');
    mkdirSync(join(innerPA, 'sub'), { recursive: true });
    writeFileSync(join(innerPA, '.process-application'), '');

    // Starting from inner-app/sub should find inner-app, not testDir
    const result = findProcessApplicationRoot(join(innerPA, 'sub'));
    assert.strictEqual(result, innerPA);
  });

  test('works with absolute paths', () => {
    writeFileSync(join(testDir, '.process-application'), '');
    const subDir = join(testDir, 'workflows');
    mkdirSync(subDir, { recursive: true });

    const result = findProcessApplicationRoot(subDir);
    assert.strictEqual(result, testDir);
  });

  test('mono-repo: each subdirectory finds its own PA root', () => {
    // Mono-repo with two process applications
    const appA = join(testDir, 'app-a');
    const appB = join(testDir, 'app-b');
    mkdirSync(join(appA, 'src'), { recursive: true });
    mkdirSync(join(appB, 'src'), { recursive: true });

    writeFileSync(join(appA, '.process-application'), '');
    writeFileSync(join(appB, '.process-application'), '');

    assert.strictEqual(findProcessApplicationRoot(join(appA, 'src')), appA);
    assert.strictEqual(findProcessApplicationRoot(join(appB, 'src')), appB);
  });

  test('directory without .process-application at repo root returns null', () => {
    // Simulates running from a directory that is NOT a process application
    const regularDir = join(testDir, 'not-a-pa');
    mkdirSync(regularDir, { recursive: true });
    writeFileSync(join(regularDir, 'process.bpmn'), '<bpmn/>');

    const result = findProcessApplicationRoot(regularDir);
    assert.strictEqual(result, null);
  });
});
