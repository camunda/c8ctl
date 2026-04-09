/**
 * Integration tests for forms
 * NOTE: These tests require a running Camunda 8 instance at http://localhost:8080
 *
 * All interactions go through the CLI as a subprocess to avoid process.exit(1) in
 * production code killing the test runner worker.
 */

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pollUntil } from '../utils/polling.ts';
import { asyncSpawn, type SpawnResult } from '../utils/spawn.ts';

const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..');
const CLI = join(PROJECT_ROOT, 'src', 'index.ts');
const POLL_TIMEOUT_MS = 10000;
const POLL_INTERVAL_MS = 200;

let dataDir = '';

function cli(...args: string[]) {
  return asyncSpawn('node', ['--experimental-strip-types', CLI, ...args], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, C8CTL_DATA_DIR: dataDir } as NodeJS.ProcessEnv,
  });
}

function parseJson<T>(stdout: string): T {
  try {
    return JSON.parse(stdout) as T;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    assert.fail(`Expected valid JSON output (${msg}), got:\n${stdout}`);
  }
}

/** Extract the created resource key from the success message in CLI stderr (JSON mode). */
function parseCreatedKey(result: SpawnResult): string | undefined {
  for (const line of result.stderr.split('\n').filter(Boolean)) {
    try {
      const data = JSON.parse(line);
      if (data.status === 'success' && data.key !== undefined) {
        return String(data.key);
      }
    } catch { /* skip non-JSON lines */ }
  }
  return undefined;
}

type UserTaskRow = { Key: string | number; Name: string; State: string; };

describe('Form Integration Tests', () => {
  before(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'c8ctl-forms-test-'));
  });

  beforeEach(async () => {
    // Clear session state before each test, then set JSON output mode
    rmSync(join(dataDir, 'session.json'), { force: true });
    await cli('output', 'json');
  });

  after(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  test('get form for user task after deploying list-pis fixtures', async () => {
    await cli('deploy', 'tests/fixtures/list-pis');

    // Poll until process definition is indexed
    const definitionFound = await pollUntil(async () => {
      const result = await cli('search', 'pd', '--id=Process_0t60ay7');
      const items = parseJson<any[]>(result.stdout);
      return items.length > 0;
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);
    assert.ok(definitionFound, 'Process definition should be indexed');

    // Create a process instance
    const createResult = await cli('create', 'pi', '--id=Process_0t60ay7');
    assert.strictEqual(createResult.status, 0, `Create PI should exit 0. stderr: ${createResult.stderr}`);
    const piKey = parseCreatedKey(createResult);
    assert.ok(piKey, 'Process instance key should exist');

    // Poll until user task is available
    let userTaskKey: string | undefined;
    const userTaskFound = await pollUntil(async () => {
      const result = await cli('search', 'ut', `--processInstanceKey=${piKey}`);
      const items = parseJson<UserTaskRow[]>(result.stdout);
      if (items.length > 0) {
        userTaskKey = String(items[0].Key);
        return true;
      }
      return false;
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);
    assert.ok(userTaskFound, 'User task should be created and indexed');
    assert.ok(userTaskKey, 'User task key should exist');

    // Retrieve the form via CLI
    const formResult = await cli('get', 'form', userTaskKey!, '--ut');
    assert.strictEqual(formResult.status, 0, `get form should exit 0. stderr: ${formResult.stderr}`);
    console.log(formResult.stdout) // @DEBUG
    const form = parseJson<Record<string, unknown>>(formResult.stdout);

    assert.ok(form, 'Form should be retrieved');
    assert.strictEqual(form.formId, 'some-form', 'Form ID should match the deployed form');
    assert.ok(form.schema, 'Form should have schema');
    assert.ok(form.formKey, 'Form should have formKey');
  });

  test('getStartForm returns no form for process without start form', async () => {
    await cli('deploy', 'tests/fixtures/list-pis');

    // Poll until process definition is indexed and get its key
    let processDefinitionKey: string | undefined;
    const definitionFound = await pollUntil(async () => {
      const result = await cli('search', 'pd', '--id=Process_0t60ay7');
      const items = parseJson<{ Key: string | number }[]>(result.stdout);
      if (items.length > 0) {
        processDefinitionKey = String(items[0].Key);
        return true;
      }
      return false;
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);
    assert.ok(definitionFound, 'Process definition should exist');
    assert.ok(processDefinitionKey, 'Process definition key should exist');

    // This BPMN doesn't have a start form, so the CLI should indicate no form
    const formResult = await cli('get', 'form', processDefinitionKey!, '--pd');
    // The CLI logs "no associated start form" to stderr and exits 0
    assert.strictEqual(formResult.status, 0, 'get form --pd should exit with status 0 for a process with no start form');
    const output = formResult.stdout + formResult.stderr;
    assert.ok(
      output.includes('no associated start form') || formResult.stdout.trim() === '',
      'Should indicate no start form for this process definition',
    );
  });

  test('getUserTaskForm retrieves form matching deployed form ID', async () => {
    await cli('deploy', 'tests/fixtures/list-pis');

    // Poll until process definition is indexed
    const definitionFound = await pollUntil(async () => {
      const result = await cli('search', 'pd', '--id=Process_0t60ay7');
      const items = parseJson<any[]>(result.stdout);
      return items.length > 0;
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);
    assert.ok(definitionFound, 'Process definition should be indexed');

    // Create instance
    const createResult = await cli('create', 'pi', '--id=Process_0t60ay7');
    assert.strictEqual(createResult.status, 0, `Create PI should exit 0. stderr: ${createResult.stderr}`);
    const piKey = parseCreatedKey(createResult);
    assert.ok(piKey, 'Process instance key should exist');

    // Poll until user task is available
    let userTaskKey: string | undefined;
    const userTaskFound = await pollUntil(async () => {
      const result = await cli('search', 'ut', `--processInstanceKey=${piKey}`);
      const items = parseJson<UserTaskRow[]>(result.stdout);
      if (items.length > 0) {
        userTaskKey = String(items[0].Key);
        return true;
      }
      return false;
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);
    assert.ok(userTaskFound, 'User task should be created');
    assert.ok(userTaskKey, 'User task key should exist');

    // Retrieve form via CLI with --ut flag
    const formResult = await cli('get', 'form', userTaskKey!, '--ut');
    assert.strictEqual(formResult.status, 0, `get form --ut should exit 0. stderr: ${formResult.stderr}`);
    const form = parseJson<Record<string, unknown>>(formResult.stdout);

    assert.ok(form, 'Form should be retrieved');
    assert.strictEqual(form.formId, 'some-form', 'Retrieved form ID should match deployed form ID');
    assert.ok(form.formKey, 'Retrieved form should have formKey');
  });

  test('getForm finds user task form with user task key', async () => {
    await cli('deploy', 'tests/fixtures/list-pis');

    // Poll until process definition is indexed
    const definitionFound = await pollUntil(async () => {
      const result = await cli('search', 'pd', '--id=Process_0t60ay7');
      const items = parseJson<any[]>(result.stdout);
      return items.length > 0;
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);
    assert.ok(definitionFound, 'Process definition should be indexed');

    const createResult = await cli('create', 'pi', '--id=Process_0t60ay7');
    assert.strictEqual(createResult.status, 0, `Create PI should exit 0. stderr: ${createResult.stderr}`);
    const piKey = parseCreatedKey(createResult);
    assert.ok(piKey, 'Process instance key should exist');

    // Poll until user task is available
    let userTaskKey: string | undefined;
    const userTaskFound = await pollUntil(async () => {
      const result = await cli('search', 'ut', `--processInstanceKey=${piKey}`);
      const items = parseJson<UserTaskRow[]>(result.stdout);
      if (items.length > 0) {
        userTaskKey = String(items[0].Key);
        return true;
      }
      return false;
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);
    assert.ok(userTaskFound, 'User task should be created');
    assert.ok(userTaskKey, 'User task key should exist');

    // Use generic getForm via CLI (no --ut or --pd flag — tries both APIs)
    const formResult = await cli('get', 'form', userTaskKey!);
    assert.strictEqual(formResult.status, 0, `get form should exit 0. stderr: ${formResult.stderr}`);

    // stderr should indicate form was found via user task API
    assert.ok(
      formResult.stderr.includes('user task'),
      `Should indicate form found via user task. stderr: ${formResult.stderr}`,
    );

    const form = parseJson<Record<string, unknown>>(formResult.stdout);
    assert.ok(form, 'Form result should be returned');
    assert.strictEqual(form.formId, 'some-form', 'Form ID should match');
  });
});
