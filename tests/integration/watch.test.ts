/**
 * Integration tests for watch command
 * NOTE: These tests require a running Camunda 8 instance at http://localhost:8080
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, copyFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pollUntil } from '../utils/polling.ts';

const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..');
const CLI = join(PROJECT_ROOT, 'src', 'index.ts');
const VALID_BPMN = join(PROJECT_ROOT, 'tests', 'fixtures', 'simple.bpmn');
const POLL_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;

/**
 * Generate an invalid BPMN that Camunda will reject during deployment.
 * Uses a sequence flow referencing a non-existent target, making it structurally invalid.
 */
function invalidBpmn(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  id="Definitions_invalid" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="invalid-process" isExecutable="true">
    <bpmn:startEvent id="Start">
      <bpmn:outgoing>Flow_missing</bpmn:outgoing>
    </bpmn:startEvent>
  </bpmn:process>
</bpmn:definitions>`;
}

/**
 * Generate a valid BPMN that Camunda will accept during deployment.
 * Mirrors simple.bpmn but with a distinct process ID to avoid fixture conflicts.
 */
function validBpmn(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  id="Definitions_corrected" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="corrected-process" isExecutable="true">
    <bpmn:startEvent id="Start">
      <bpmn:outgoing>Flow_1</bpmn:outgoing>
    </bpmn:startEvent>
    <bpmn:endEvent id="End">
      <bpmn:incoming>Flow_1</bpmn:incoming>
    </bpmn:endEvent>
    <bpmn:sequenceFlow id="Flow_1" sourceRef="Start" targetRef="End" />
  </bpmn:process>
</bpmn:definitions>`;
}

/** Spawn a watch process and collect its combined stdout+stderr output. */
function startWatch(watchDir: string, dataDir: string, extraArgs: string[] = []) {
  const child = spawn(
    'node',
    ['--experimental-strip-types', CLI, 'watch', ...extraArgs, watchDir],
    {
      cwd: PROJECT_ROOT,
      env: { ...process.env, C8CTL_DATA_DIR: dataDir } as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let output = '';
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });

  return {
    child,
    getOutput: () => output,
    kill: () => {
      child.kill('SIGTERM');
      // Give a moment for cleanup
      return new Promise<void>(resolve => setTimeout(resolve, 500));
    },
  };
}

describe('Watch Command Integration Tests (requires Camunda 8 at localhost:8080)', () => {
  let dataDir: string;
  let watchDir: string;

  before(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'c8ctl-watch-test-'));
    watchDir = mkdtempSync(join(tmpdir(), 'c8ctl-watch-dir-'));
  });

  after(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(watchDir, { recursive: true, force: true });
  });

  test('watch deploys a valid BPMN file on change', async () => {
    const testWatchDir = mkdtempSync(join(tmpdir(), 'c8ctl-watch-valid-'));
    const watch = startWatch(testWatchDir, dataDir);

    try {
      // Wait for the watcher to initialize
      await pollUntil(
        async () => watch.getOutput().includes('Watching for changes'),
        5000,
        POLL_INTERVAL_MS,
      );

      // Copy a valid BPMN file into the watched directory to trigger deploy
      copyFileSync(VALID_BPMN, join(testWatchDir, 'simple.bpmn'));

      // Wait for the deployment success message
      const deployed = await pollUntil(
        async () => watch.getOutput().includes('Deployment successful'),
        POLL_TIMEOUT_MS,
        POLL_INTERVAL_MS,
      );

      assert.ok(deployed, `Expected successful deployment in watch output.\nActual output:\n${watch.getOutput()}`);
    } finally {
      await watch.kill();
      rmSync(testWatchDir, { recursive: true, force: true });
    }
  });

  test('watch --force continues watching after invalid BPMN deployment error', async () => {
    const testWatchDir = mkdtempSync(join(tmpdir(), 'c8ctl-watch-force-'));
    const bpmnFile = join(testWatchDir, 'process.bpmn');
    const watch = startWatch(testWatchDir, dataDir, ['--force']);

    try {
      // Wait for the watcher to initialize (should show force mode message)
      await pollUntil(
        async () => watch.getOutput().includes('Force mode'),
        5000,
        POLL_INTERVAL_MS,
      );

      // Step 1: write an invalid BPMN to trigger a deployment error
      writeFileSync(bpmnFile, invalidBpmn());

      // Step 2: watch mode continues — wait for the deployment error message
      const errorSeen = await pollUntil(
        async () => watch.getOutput().includes('Deployment failed'),
        POLL_TIMEOUT_MS,
        POLL_INTERVAL_MS,
      );

      assert.ok(errorSeen, `Expected deployment error in watch output.\nActual output:\n${watch.getOutput()}`);

      // Step 3: correct the same file in place with valid BPMN content
      // Wait for the cooldown to elapse before triggering the next deploy
      const cooldownStart = Date.now();
      const cooldownElapsed = await pollUntil(
        async () => Date.now() - cooldownStart >= 2500,
        POLL_TIMEOUT_MS,
        POLL_INTERVAL_MS,
      );
      assert.ok(
        cooldownElapsed,
        `Expected cooldown to elapse before correcting BPMN file.\nActual output:\n${watch.getOutput()}`,
      );
      writeFileSync(bpmnFile, validBpmn());

      // Step 4: watch detects the correction and deploys again — successfully
      const deployed = await pollUntil(
        async () => watch.getOutput().includes('Deployment successful'),
        POLL_TIMEOUT_MS,
        POLL_INTERVAL_MS,
      );

      assert.ok(deployed, `Expected successful deployment after correcting the file.\nActual output:\n${watch.getOutput()}`);
    } finally {
      await watch.kill();
      rmSync(testWatchDir, { recursive: true, force: true });
    }
  });
});
