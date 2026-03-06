/**
 * Integration tests for process definitions
 * NOTE: These tests require a running Camunda 8 instance at http://localhost:8080
 */

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pollUntil } from '../utils/polling.ts';

// Wait time for Elasticsearch to index data before search queries
const ELASTICSEARCH_CONSISTENCY_WAIT_MS = 8000;
const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..');
const CLI = join(PROJECT_ROOT, 'src', 'index.ts');
const POLL_TIMEOUT_MS = ELASTICSEARCH_CONSISTENCY_WAIT_MS + 10_000;
const POLL_INTERVAL_MS = 2_000;

let dataDir = '';

type ProcessDefinition = {
  processDefinitionKey?: string | number;
  key?: string | number; // legacy API field name
  Key?: string | number; // CLI table column in JSON mode
  processDefinitionId?: string;
  'Process ID'?: string; // CLI table column in JSON mode
  version?: number;
  Version?: number; // CLI table column in JSON mode
};

function cli(...args: string[]) {
  return spawnSync('node', ['--experimental-strip-types', CLI, ...args], {
    encoding: 'utf-8',
    cwd: PROJECT_ROOT,
    env: { ...process.env, C8CTL_DATA_DIR: dataDir },
    stdio: 'pipe',
  });
}

function parseJsonOutput<T>(output: string): T {
  try {
    return JSON.parse(output) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert.fail(`Expected valid JSON output (${message}), got:\n${output}`);
  }
}

function getFirstDefinedField<K extends keyof ProcessDefinition>(
  item: ProcessDefinition,
  fields: K[],
): ProcessDefinition[K] | undefined {
  for (const field of fields) {
    const value = item[field];
    if (value !== undefined) return value;
  }
  return undefined;
}

function getProcessDefinitionKey(item: ProcessDefinition): string | number | undefined {
  return getFirstDefinedField(item, ['processDefinitionKey', 'key', 'Key']);
}

function getProcessDefinitionId(item: ProcessDefinition): string | undefined {
  const processId = getFirstDefinedField(item, ['processDefinitionId', 'Process ID']);
  return typeof processId === 'string' ? processId : undefined;
}

function getProcessDefinitionVersion(item: ProcessDefinition): number | undefined {
  const version = getFirstDefinedField(item, ['version', 'Version']);
  return typeof version === 'number' ? version : undefined;
}

async function deployAndGetProcessDefinitionKey() {
  const deployResult = cli('deploy', 'tests/fixtures/simple.bpmn');
  assert.strictEqual(deployResult.status, 0, `Deploy should exit 0. stderr: ${deployResult.stderr}`);

  const outputResult = cli('output', 'json');
  assert.strictEqual(outputResult.status, 0, `Setting output mode should exit 0. stderr: ${outputResult.stderr}`);

  let latestItems: ProcessDefinition[] = [];
  await pollUntil(async () => {
    const searchResult = cli('search', 'pd', '--id=simple-process');
    if (searchResult.status !== 0) return false;
    try {
      latestItems = parseJsonOutput<ProcessDefinition[]>(searchResult.stdout);
      return latestItems.length > 0;
    } catch {
      return false;
    }
  }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);

  assert.ok(latestItems.length > 0, 'Should have at least one process definition');
  const processDefinitionKey = getProcessDefinitionKey(latestItems[0]);
  assert.ok(processDefinitionKey, 'Process definition should have a key');
  return String(processDefinitionKey);
}

describe('Process Definition Integration Tests (requires Camunda 8 at localhost:8080)', () => {
  before(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'c8ctl-pd-test-'));
  });

  beforeEach(() => {
    rmSync(join(dataDir, 'session.json'), { force: true });
  });

  after(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  test('list process definitions returns deployed processes', async () => {
    const processDefinitionKey = await deployAndGetProcessDefinitionKey();

    const searchResult = cli('search', 'pd', '--id=simple-process');
    assert.strictEqual(searchResult.status, 0, `Search should exit 0. stderr: ${searchResult.stderr}`);
    const items = parseJsonOutput<ProcessDefinition[]>(searchResult.stdout);
    const firstItem = items.find(item => String(getProcessDefinitionKey(item)) === processDefinitionKey);
    assert.ok(firstItem, `Expected to find process definition ${processDefinitionKey}`);

    assert.ok(getProcessDefinitionKey(firstItem), 'Process definition should have a key');
    assert.ok(getProcessDefinitionId(firstItem), 'Process definition should have an ID');
    assert.ok(getProcessDefinitionVersion(firstItem) !== undefined, 'Process definition should have a version');
  });

  test('get process definition by key returns definition details', async () => {
    const processDefinitionKey = await deployAndGetProcessDefinitionKey();

    const getResult = cli('get', 'pd', processDefinitionKey);
    assert.strictEqual(getResult.status, 0, `Get should exit 0. stderr: ${getResult.stderr}`);
    const definition = parseJsonOutput<ProcessDefinition>(getResult.stdout);

    assert.ok(definition, 'Process definition should be returned');
    assert.strictEqual(String(definition.processDefinitionKey), processDefinitionKey, 'Keys should match');
    assert.strictEqual(definition.processDefinitionId, 'simple-process', 'IDs should match');
  });

  test('get process definition XML returns BPMN content', async () => {
    const processDefinitionKey = await deployAndGetProcessDefinitionKey();
    // XML retrieval uses logger.info(), which writes to stderr in JSON mode.
    const outputResult = cli('output', 'text');
    assert.strictEqual(outputResult.status, 0, `Setting output mode should exit 0. stderr: ${outputResult.stderr}`);

    const getXmlResult = cli('get', 'pd', processDefinitionKey, '--xml');
    assert.strictEqual(getXmlResult.status, 0, `Get XML should exit 0. stderr: ${getXmlResult.stderr}`);

    assert.ok(getXmlResult.stdout, 'XML should be returned');
    assert.ok(typeof getXmlResult.stdout === 'string', 'XML should be a string');
    assert.ok(getXmlResult.stdout.includes('bpmn:'), 'XML should contain BPMN namespace');
    assert.ok(getXmlResult.stdout.includes('simple-process'), 'XML should contain the process ID');
  });
});
