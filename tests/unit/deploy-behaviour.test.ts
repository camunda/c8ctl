/**
 * CLI behavioural tests for deploy command.
 *
 * These tests exercise the full dispatch path by spawning the CLI
 * as a subprocess with --dry-run. They verify that CLI flags flow
 * correctly through index.ts dispatch → validation → handler → JSON output.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { asyncSpawn, type SpawnResult } from '../utils/spawn.ts';

const CLI = 'src/index.ts';

async function c8(...args: string[]): Promise<SpawnResult> {
  return asyncSpawn('node', ['--experimental-strip-types', CLI, ...args], {
    env: {
      ...process.env,
      CAMUNDA_BASE_URL: 'http://test-cluster/v2',
      HOME: '/tmp/c8ctl-test-nonexistent-home',
    },
  });
}

function parseJson(result: SpawnResult): Record<string, unknown> {
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`Failed to parse JSON from stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
}

const MINIMAL_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
                  xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
                  id="Definitions_1" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="test-process" isExecutable="true">
    <bpmn:startEvent id="start"/>
  </bpmn:process>
  <bpmndi:BPMNDiagram id="BPMNDiagram_1">
    <bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="test-process">
      <bpmndi:BPMNShape id="start_di" bpmnElement="start">
        <dc:Bounds x="173" y="102" width="36" height="36"/>
      </bpmndi:BPMNShape>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>`;

let tempDir: string;

describe('CLI behavioural: deploy', () => {

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'c8ctl-deploy-behaviour-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('--dry-run emits POST to /deployments with resource list', async () => {
    const bpmnFile = join(tempDir, 'test.bpmn');
    writeFileSync(bpmnFile, MINIMAL_BPMN);

    const result = await c8(
      'deploy', bpmnFile,
      '--dry-run',
    );

    assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    const out = parseJson(result);

    assert.strictEqual(out.dryRun, true);
    assert.strictEqual(out.method, 'POST');
    assert.ok((out.url as string).endsWith('/deployments'));

    const body = out.body as Record<string, unknown>;
    const resources = body.resources as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(resources), 'body.resources should be an array');
    assert.ok(resources.length > 0, 'should include at least one resource');
    assert.ok(resources[0].name, 'resource should have a name');
  });

  test('--dry-run rejects directory with no deployable files', async () => {
    // Create an empty subdirectory
    const emptyDir = join(tempDir, 'empty');
    rmSync(emptyDir, { recursive: true, force: true });
    const { mkdirSync } = await import('node:fs');
    mkdirSync(emptyDir, { recursive: true });

    const result = await c8(
      'deploy', emptyDir,
      '--dry-run',
    );

    assert.strictEqual(result.status, 1);
    assert.ok(
      result.stderr.includes('No BPMN/DMN/Form files found') ||
      result.stderr.includes('No deployable'),
      `stderr: ${result.stderr}`,
    );
  });
});
