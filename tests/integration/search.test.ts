/**
 * Integration tests for search commands
 * NOTE: These tests require a running Camunda 8 instance at http://localhost:8080
 *
 * These tests validate the search CLI commands, which exercise the project's wrapper
 * functions in src/commands/search.ts. All CLI calls use async subprocesses to
 * avoid Node 24 IPC deserialization errors that occur with direct TypeScript imports.
 */

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pollUntil } from '../utils/polling.ts';
import { asyncSpawn, type SpawnResult } from '../utils/spawn.ts';
import { todayRange, MS_PER_DAY } from '../utils/date-helpers.ts';

// Polling configuration for Elasticsearch consistency
const POLL_TIMEOUT_MS = 30000;
const POLL_INTERVAL_MS = 1000;

const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..');
const CLI = join(PROJECT_ROOT, 'src', 'index.ts');
let dataDir = '';

type ProcessDefinitionRow = { Key: string | number; 'Process ID': string; Name: string; Version: number; 'Tenant ID': string; };
type ProcessInstanceRow = { Key: string | number; 'Process ID': string; State: string; Version: number; 'Start Date': string; 'Tenant ID': string; };
type UserTaskRow = { Key: string | number; Name: string; State: string; Assignee: string; Created: string; 'Process Instance': string | number; 'Tenant ID': string; };
type IncidentRow = { Key: string | number; Type: string; Message: string; State: string; Created: string; 'Process Instance': string | number; 'Tenant ID': string; };
type JobRow = { Key: string | number; Type: string; State: string; Retries: number; Created: string; 'Process Instance': string | number; 'Tenant ID': string; };
type VariableRow = { Name: string; Value: string; 'Process Instance': string | number; 'Scope Key': string | number; 'Tenant ID': string; };

function cli(...args: string[]) {
  return asyncSpawn('node', ['--experimental-strip-types', CLI, ...args], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, C8CTL_DATA_DIR: dataDir } as NodeJS.ProcessEnv,
  });
}

function parseJsonOutput<T>(stdout: string): T {
  try {
    return JSON.parse(stdout) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert.fail(`Expected valid JSON output (${message}), got:\n${stdout}`);
  }
}

function parseItems<T>(stdout: string): T[] {
  if (!stdout.trim()) return [];
  return parseJsonOutput<T[]>(stdout);
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

describe('Search Command Integration Tests (requires Camunda 8 at localhost:8080)', () => {
  before(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'c8ctl-search-test-'));
  });

  beforeEach(async () => {
    // Clear session state before each test, then restore JSON output mode
    rmSync(join(dataDir, 'session.json'), { force: true });
    await cli('output', 'json');
  });

  after(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  test('search process definitions by processDefinitionId', async () => {
    await cli('deploy', 'tests/fixtures/simple.bpmn');

    const found = await pollUntil(async () => {
      const result = await cli('search', 'pd', '--id=simple-process');
      const items = parseItems<ProcessDefinitionRow>(result.stdout);
      return items.length > 0;
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);

    assert.ok(found, 'Search should find the deployed process definition');
  });

  test('search process definitions with filters', async () => {
    await cli('deploy', 'tests/fixtures/simple.bpmn');

    let processDefKey: string | undefined;
    const found = await pollUntil(async () => {
      const result = await cli('search', 'pd', '--id=simple-process');
      const items = parseItems<ProcessDefinitionRow>(result.stdout);
      if (items.length > 0) {
        processDefKey = String(items[0].Key);
        return true;
      }
      return false;
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);

    assert.ok(found, 'Should find the deployed process');
    assert.ok(processDefKey, 'Should have process definition key');

    // Search by key
    const keyResult = await cli('search', 'pd', `--key=${processDefKey}`);
    const keyItems = parseItems<ProcessDefinitionRow>(keyResult.stdout);
    assert.ok(keyItems.length > 0, 'Search by key should find the process');
  });

  test('search process instances by state', async () => {
    await cli('deploy', 'tests/fixtures/simple.bpmn');
    await cli('create', 'pi', '--id=simple-process');

    const found = await pollUntil(async () => {
      const result = await cli('search', 'pi', '--id=simple-process', '--state=COMPLETED');
      const items = parseItems<ProcessInstanceRow>(result.stdout);
      return items.length > 0;
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);

    assert.ok(found, 'Search should find completed process instances');
  });

  test('search process instances by processDefinitionKey', async () => {
    await cli('deploy', 'tests/fixtures/simple.bpmn');
    await cli('create', 'pi', '--id=simple-process');

    // Get processDefinitionKey from pd search, and wait for a process instance to be indexed
    let processDefKey: string | undefined;
    const instanceIndexed = await pollUntil(async () => {
      const pdResult = await cli('search', 'pd', '--id=simple-process');
      const pdItems = parseItems<ProcessDefinitionRow>(pdResult.stdout);
      const piResult = await cli('search', 'pi', '--id=simple-process');
      const piItems = parseItems<ProcessInstanceRow>(piResult.stdout);
      if (pdItems.length > 0 && piItems.length > 0) {
        processDefKey = String(pdItems[0].Key);
        return true;
      }
      return false;
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);

    assert.ok(instanceIndexed, 'Created process instance should be indexed');
    assert.ok(processDefKey, 'Should have process definition key');

    // Poll until search by processDefinitionKey finds results
    const found = await pollUntil(async () => {
      const result = await cli('search', 'pi', `--processDefinitionKey=${processDefKey}`);
      const items = parseItems<ProcessInstanceRow>(result.stdout);
      return items.length > 0;
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);

    assert.ok(found, 'Search by processDefinitionKey should find process instances');
  });

  test('search process instances by version', async () => {
    await cli('deploy', 'tests/fixtures/simple.bpmn');
    await cli('create', 'pi', '--id=simple-process');

    const found = await pollUntil(async () => {
      const result = await cli('search', 'pi', '--id=simple-process', '--version=1');
      const items = parseItems<ProcessInstanceRow>(result.stdout);
      return items.length > 0;
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);

    assert.ok(found, 'Search should find process instances matching version 1');
  });

  test('search process instances by version filters correctly', async () => {
    await cli('deploy', 'tests/fixtures/simple.bpmn');
    await cli('create', 'pi', '--id=simple-process');

    // Wait until results are indexed
    const indexed = await pollUntil(async () => {
      const result = await cli('search', 'pi', '--id=simple-process', '--version=1');
      const items = parseItems<ProcessInstanceRow>(result.stdout);
      return items.length > 0;
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);
    assert.ok(indexed, 'Version 1 instances should be indexed');

    // Search with a very high version that shouldn't match
    const noResult = await cli('search', 'pi', '--id=simple-process', '--version=9999');
    const noItems = parseItems<ProcessInstanceRow>(noResult.stdout);
    assert.strictEqual(noItems.length, 0, 'Search with non-existing version should return no results');
  });

  test('search process definitions by version', async () => {
    await cli('deploy', 'tests/fixtures/simple.bpmn');

    const found = await pollUntil(async () => {
      const result = await cli('search', 'pd', '--id=simple-process', '--version=1');
      const items = parseItems<ProcessDefinitionRow>(result.stdout);
      return items.length > 0;
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);

    assert.ok(found, 'Search should find process definition matching version 1');
  });

  test('search user tasks with filters', async () => {
    await cli('deploy', 'tests/fixtures/list-pis');
    await cli('create', 'pi', '--id=Process_0t60ay7');

    const found = await pollUntil(async () => {
      const result = await cli('search', 'ut', '--state=CREATED');
      const items = parseItems<UserTaskRow>(result.stdout);
      return items.length > 0;
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);

    assert.ok(found, 'Search should find created user tasks');
  });

  test('search incidents with filters', async () => {
    await cli('deploy', 'tests/fixtures/simple-will-create-incident.bpmn');
    await cli('create', 'pi', '--id=Process_0yyrstd');

    let jobKey: string | undefined;
    const jobFound = await pollUntil(async () => {
      const result = await cli('search', 'jobs', '--type=unhandled-job-type', '--state=CREATED');
      const items = parseItems<JobRow>(result.stdout);
      if (items.length > 0) {
        const createdJob = items.find(j => String(j.State).toUpperCase() === 'CREATED');
        if (createdJob) {
          jobKey = String(createdJob.Key);
          return true;
        }
      }
      return false;
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);
    assert.ok(jobFound && jobKey, 'Job should appear before failing it');

    await cli('fail', 'job', jobKey!, '--retries=0', '--errorMessage=Intentional failure for incident test');

    const found = await pollUntil(async () => {
      const result = await cli('search', 'inc', '--state=ACTIVE');
      const items = parseItems<IncidentRow>(result.stdout);
      return items.length > 0;
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);

    assert.ok(found, 'Search should find active incidents');
  });

  test('search jobs with filters', async () => {
    await cli('deploy', 'tests/fixtures/simple-service-task.bpmn');
    await cli('create', 'pi', '--id=Process_18glkb3');

    const found = await pollUntil(async () => {
      const result = await cli('search', 'jobs', '--type=n00b', '--state=CREATED');
      const items = parseItems<JobRow>(result.stdout);
      return items.length > 0;
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);

    assert.ok(found, 'Search should find created jobs');
  });

  test('search variables with filters', async () => {
    await cli('deploy', 'tests/fixtures/simple.bpmn');
    await cli('create', 'pi', '--id=simple-process', `--variables=${JSON.stringify({ testVar: 'testValue', count: 42, flag: true })}`);

    const found = await pollUntil(async () => {
      const result = await cli('search', 'vars', '--name=testVar');
      const items = parseItems<VariableRow>(result.stdout);
      return items.length > 0;
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);

    assert.ok(found, 'Search should find variable by name');
  });

  test('search variables with fullValue option', async () => {
    await cli('deploy', 'tests/fixtures/simple.bpmn');
    const longValue = 'a'.repeat(1000);
    await cli('create', 'pi', '--id=simple-process', `--variables=${JSON.stringify({ longVar: longValue })}`);

    const found = await pollUntil(async () => {
      const result = await cli('search', 'vars', '--name=longVar', '--fullValue');
      const items = parseItems<VariableRow>(result.stdout);
      return items.length > 0;
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);

    assert.ok(found, 'Search with fullValue should find the variable');
  });

  // ── Wildcard Search Tests ──────────────────────────────────────────

  test('wildcard * on process definition name matches multiple results', async () => {
    await cli('deploy', 'tests/fixtures/sample-project/main.bpmn');
    await cli('deploy', 'tests/fixtures/sample-project/sub-folder/sub.bpmn');

    const found = await pollUntil(async () => {
      const result = await cli('search', 'pd', '--name=*Process');
      const items = parseItems<ProcessDefinitionRow>(result.stdout);
      return items.length >= 2;
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);

    assert.ok(found, 'Wildcard --name="*Process" should match named process definitions');
  });

  test('wildcard ? on process definition ID matches single character', async () => {
    await cli('deploy', 'tests/fixtures/sample-project/main.bpmn');
    await cli('deploy', 'tests/fixtures/sample-project/sub-folder/sub.bpmn');

    const found = await pollUntil(async () => {
      const result = await cli('search', 'pd', '--id=ma??-process');
      const items = parseItems<ProcessDefinitionRow>(result.stdout);
      if (items.length === 0) return false;
      return items.every(pd => String(pd['Process ID']) === 'main-process');
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);

    assert.ok(found, 'Wildcard --id="ma??-process" should match only main-process');
  });

  test('wildcard * on process definition ID matches multiple processes', async () => {
    await cli('deploy', 'tests/fixtures/sample-project/main.bpmn');
    await cli('deploy', 'tests/fixtures/sample-project/sub-folder/sub.bpmn');

    // "*-process" should match both main-process and sub-process (and possibly simple-process)
    const found = await pollUntil(async () => {
      const result = await cli('search', 'pd', '--id=*-process');
      const items = parseItems<ProcessDefinitionRow>(result.stdout);
      return items.length >= 2;
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);

    assert.ok(found, 'Wildcard --id="*-process" should match multiple process definitions');
  });

  test('wildcard * on variable name matches deployed variables', async () => {
    await cli('deploy', 'tests/fixtures/simple.bpmn');
    await cli('create', 'pi', '--id=simple-process', `--variables=${JSON.stringify({ wildcardTestAlpha: 'a', wildcardTestBeta: 'b' })}`);

    const found = await pollUntil(async () => {
      const result = await cli('search', 'vars', '--name=wildcardTest*');
      const items = parseItems<VariableRow>(result.stdout);
      return items.length >= 2;
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);

    assert.ok(found, 'Wildcard --name="wildcardTest*" should match multiple variables');
  });

  test('wildcard * on job type matches jobs', async () => {
    await cli('deploy', 'tests/fixtures/simple-service-task.bpmn');
    await cli('create', 'pi', '--id=Process_18glkb3');

    const found = await pollUntil(async () => {
      const result = await cli('search', 'jobs', '--type=n*');
      const items = parseItems<JobRow>(result.stdout);
      return items.length > 0;
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);

    assert.ok(found, 'Wildcard --type="n*" should match job type "n00b"');
  });

  test('wildcard ? on job type requires exact character count', async () => {
    await cli('deploy', 'tests/fixtures/simple-service-task.bpmn');
    await cli('create', 'pi', '--id=Process_18glkb3');

    // Wait for the job to be indexed first
    const indexed = await pollUntil(async () => {
      const result = await cli('search', 'jobs', '--type=n00b');
      const items = parseItems<JobRow>(result.stdout);
      return items.length > 0;
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);
    assert.ok(indexed, 'Job should be indexed');

    // "n?b" should NOT match "n00b" (too few ? chars)
    const result = await cli('search', 'jobs', '--type=n?b');
    const items = parseItems<JobRow>(result.stdout);
    assert.ok(items.length === 0, 'Wildcard "n?b" should not match "n00b" (needs 2 chars)');

    // "n??b" SHOULD match "n00b"
    const result2 = await cli('search', 'jobs', '--type=n??b');
    const items2 = parseItems<JobRow>(result2.stdout);
    assert.ok(items2.length > 0, 'Wildcard "n??b" should match "n00b"');
  });

  // ── Case-Insensitive Search Tests ──────────────────────────────────

  test('case-insensitive search on process definition name', async () => {
    await cli('deploy', 'tests/fixtures/sample-project/main.bpmn');

    const indexed = await pollUntil(async () => {
      const result = await cli('search', 'pd', '--id=main-process');
      const items = parseItems<ProcessDefinitionRow>(result.stdout);
      return items.length > 0;
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);
    assert.ok(indexed, 'Process should be indexed');

    // --iname='main process' should match "Main Process" (different case)
    const result = await cli('search', 'pd', '--iname=main process');
    const items = parseItems<ProcessDefinitionRow>(result.stdout);
    assert.ok(items.length > 0, '--iname="main process" should match "Main Process"');
    assert.strictEqual(String(items[0]['Process ID']), 'main-process');
  });

  test('case-insensitive search on process definition name with ALL CAPS', async () => {
    await cli('deploy', 'tests/fixtures/sample-project/main.bpmn');

    const indexed = await pollUntil(async () => {
      const result = await cli('search', 'pd', '--id=main-process');
      const items = parseItems<ProcessDefinitionRow>(result.stdout);
      return items.length > 0;
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);
    assert.ok(indexed, 'Process should be indexed');

    // --iname='MAIN PROCESS' should match "Main Process"
    const result = await cli('search', 'pd', '--iname=MAIN PROCESS');
    const items = parseItems<ProcessDefinitionRow>(result.stdout);
    assert.ok(items.length > 0, '--iname="MAIN PROCESS" should match "Main Process"');
  });

  test('case-insensitive wildcard search on process definition name', async () => {
    await cli('deploy', 'tests/fixtures/sample-project/main.bpmn');
    await cli('deploy', 'tests/fixtures/sample-project/sub-folder/sub.bpmn');

    // Wait for both to be indexed
    const indexed = await pollUntil(async () => {
      const r1 = await cli('search', 'pd', '--id=main-process');
      const r2 = await cli('search', 'pd', '--id=sub-process');
      const i1 = parseItems<ProcessDefinitionRow>(r1.stdout);
      const i2 = parseItems<ProcessDefinitionRow>(r2.stdout);
      return i1.length > 0 && i2.length > 0;
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);
    assert.ok(indexed, 'Both processes should be indexed');

    // --iname='*PROCESS' should match "Main Process" and "Sub Process" (case-insensitive)
    const result = await cli('search', 'pd', '--iname=*PROCESS');
    const items = parseItems<ProcessDefinitionRow>(result.stdout);
    assert.ok(items.length >= 2, '--iname="*PROCESS" should match multiple named process definitions');
  });

  test('case-insensitive search on process definition ID', async () => {
    await cli('deploy', 'tests/fixtures/sample-project/main.bpmn');

    const indexed = await pollUntil(async () => {
      const result = await cli('search', 'pd', '--id=main-process');
      const items = parseItems<ProcessDefinitionRow>(result.stdout);
      return items.length > 0;
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);
    assert.ok(indexed, 'Process should be indexed');

    // --iid='MAIN-PROCESS' should match "main-process"
    const result = await cli('search', 'pd', '--iid=MAIN-PROCESS');
    const items = parseItems<ProcessDefinitionRow>(result.stdout);
    assert.ok(items.length > 0, '--iid="MAIN-PROCESS" should match "main-process"');
  });

  test('case-insensitive search on variable name', async () => {
    await cli('deploy', 'tests/fixtures/simple.bpmn');
    await cli('create', 'pi', '--id=simple-process', `--variables=${JSON.stringify({ CamelCaseVar: 'hello' })}`);

    const indexed = await pollUntil(async () => {
      const result = await cli('search', 'vars', '--name=CamelCaseVar');
      const items = parseItems<VariableRow>(result.stdout);
      return items.length > 0;
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);
    assert.ok(indexed, 'Variable should be indexed');

    // --iname='camelcasevar' should match "CamelCaseVar"
    const result = await cli('search', 'vars', '--iname=camelcasevar');
    const items = parseItems<VariableRow>(result.stdout);
    assert.ok(items.length > 0, '--iname="camelcasevar" should match "CamelCaseVar"');
  });

  test('case-insensitive search on variable value', async () => {
    await cli('deploy', 'tests/fixtures/simple.bpmn');
    await cli('create', 'pi', '--id=simple-process', `--variables=${JSON.stringify({ statusVar: 'PendingReview' })}`);

    const indexed = await pollUntil(async () => {
      const result = await cli('search', 'vars', '--name=statusVar');
      const items = parseItems<VariableRow>(result.stdout);
      return items.length > 0;
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);
    assert.ok(indexed, 'Variable should be indexed');

    // --ivalue='pendingreview' should match "PendingReview"
    const result = await cli('search', 'vars', '--ivalue=pendingreview');
    const items = parseItems<VariableRow>(result.stdout);
    assert.ok(items.length > 0, '--ivalue="pendingreview" should match "PendingReview"');
  });

  test('case-insensitive search on job type', async () => {
    await cli('deploy', 'tests/fixtures/simple-service-task.bpmn');
    await cli('create', 'pi', '--id=Process_18glkb3');

    const indexed = await pollUntil(async () => {
      const result = await cli('search', 'jobs', '--type=n00b');
      const items = parseItems<JobRow>(result.stdout);
      return items.length > 0;
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);
    assert.ok(indexed, 'Job should be indexed');

    // --itype='N00B' should match "n00b"
    const result = await cli('search', 'jobs', '--itype=N00B');
    const items = parseItems<JobRow>(result.stdout);
    assert.ok(items.length > 0, '--itype="N00B" should match job type "n00b"');
  });

  test('case-insensitive search does not match non-matching pattern', async () => {
    await cli('deploy', 'tests/fixtures/sample-project/main.bpmn');

    const indexed = await pollUntil(async () => {
      const result = await cli('search', 'pd', '--id=main-process');
      const items = parseItems<ProcessDefinitionRow>(result.stdout);
      return items.length > 0;
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);
    assert.ok(indexed, 'Process should be indexed');

    // --iname='nonexistent' should return no results
    const result = await cli('search', 'pd', '--iname=nonexistent-process-name');
    const items = parseItems<ProcessDefinitionRow>(result.stdout);
    assert.ok(items.length === 0, '--iname="nonexistent-process-name" should return no results');
  });

  // ── Date Range Filter Tests (--between) ──────────────────────────────

  test('searchProcessInstances with --between spanning today finds recently created instance', async () => {
    await cli('deploy', 'tests/fixtures/simple.bpmn');
    await cli('create', 'pi', '--id=simple-process');

    const found = await pollUntil(async () => {
      const result = await cli('search', 'pi', '--id=simple-process', '--state=COMPLETED', `--between=${todayRange()}`);
      const items = parseItems<ProcessInstanceRow>(result.stdout);
      return items.length > 0;
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);

    assert.ok(found, '--between spanning today should find recently completed process instances');
  });

  test('searchProcessInstances with --between and explicit --dateField=startDate finds instance', async () => {
    await cli('deploy', 'tests/fixtures/simple.bpmn');
    await cli('create', 'pi', '--id=simple-process');

    const found = await pollUntil(async () => {
      const result = await cli('search', 'pi', '--id=simple-process', `--between=${todayRange()}`, '--dateField=startDate');
      const items = parseItems<ProcessInstanceRow>(result.stdout);
      return items.length > 0;
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);

    assert.ok(found, '--between with --dateField=startDate should find recently started process instances');
  });

  test('searchProcessInstances with open-ended --between=..<to> finds recently created instance', async () => {
    await cli('deploy', 'tests/fixtures/simple.bpmn');
    await cli('create', 'pi', '--id=simple-process');

    const tomorrow = new Date(Date.now() + MS_PER_DAY).toISOString().slice(0, 10);
    const found = await pollUntil(async () => {
      const result = await cli('search', 'pi', '--id=simple-process', '--state=COMPLETED', `--between=..${tomorrow}`);
      const items = parseItems<ProcessInstanceRow>(result.stdout);
      return items.length > 0;
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);

    assert.ok(found, 'open-ended upper-bound --between should find recently completed process instances');
  });

  test('searchProcessInstances with open-ended --between=<from>.. finds recently created instance', async () => {
    await cli('deploy', 'tests/fixtures/simple.bpmn');
    await cli('create', 'pi', '--id=simple-process');

    const yesterday = new Date(Date.now() - MS_PER_DAY).toISOString().slice(0, 10);
    const found = await pollUntil(async () => {
      const result = await cli('search', 'pi', '--id=simple-process', '--state=COMPLETED', `--between=${yesterday}..`);
      const items = parseItems<ProcessInstanceRow>(result.stdout);
      return items.length > 0;
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);

    assert.ok(found, 'open-ended lower-bound --between should find recently completed process instances');
  });

  test('searchUserTasks with --between spanning today finds recently created task', async () => {
    await cli('deploy', 'tests/fixtures/list-pis');
    await cli('create', 'pi', '--id=Process_0t60ay7');

    const found = await pollUntil(async () => {
      const result = await cli('search', 'ut', '--state=CREATED', `--between=${todayRange()}`);
      const items = parseItems<UserTaskRow>(result.stdout);
      return items.length > 0;
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);

    assert.ok(found, '--between spanning today should find recently created user tasks');
  });

  test('searchIncidents with --between spanning today finds recently created incident', async () => {
    await cli('deploy', 'tests/fixtures/simple-will-create-incident.bpmn');
    const createResult = await cli('create', 'pi', '--id=Process_0yyrstd');
    assert.strictEqual(createResult.status, 0, `Create PI should exit 0. stderr: ${createResult.stderr}`);
    const piKey = parseCreatedKey(createResult);
    assert.ok(piKey, 'Should have process instance key');

    // Wait for the job and fail it to produce an incident; filter by processInstanceKey to avoid
    // picking up jobs from previous tests that may still appear as CREATED in the search index
    let jobKey: string | undefined;
    const jobFound = await pollUntil(async () => {
      const result = await cli('search', 'jobs', '--type=unhandled-job-type', '--state=CREATED', `--processInstanceKey=${piKey}`);
      const items = parseItems<JobRow>(result.stdout);
      if (items.length > 0) {
        const job = items.find(j => String(j.State).toUpperCase() === 'CREATED');
        if (job) {
          jobKey = String(job.Key);
          return true;
        }
      }
      return false;
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);
    assert.ok(jobFound && jobKey, 'Job should exist before failing');

    await cli('fail', 'job', jobKey!, '--retries=0', '--errorMessage=Intentional failure for between test');

    const found = await pollUntil(async () => {
      const result = await cli('search', 'inc', '--state=ACTIVE', `--between=${todayRange()}`);
      const items = parseItems<IncidentRow>(result.stdout);
      return items.length > 0;
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);

    assert.ok(found, '--between spanning today should find recently created incidents');
  });

  // Jobs --between tests require Camunda 8.9+ because `creationTime`/`lastUpdateTime` job search
  // filter fields are only available in 8.9+ (see assets/c8/rest-api/jobs.yaml).
  // Skip them when running against 8.8, using the CAMUNDA_VERSION env var set by the GH Actions matrix.
  const camundaVersion = process.env.CAMUNDA_VERSION;
  const isCamunda89Plus = camundaVersion !== '8.8';
  const jobsBetweenSkip = isCamunda89Plus
    ? false
    : `creationTime job filter requires Camunda 8.9+ (CAMUNDA_VERSION=${camundaVersion ?? 'unset'})`;

  test('list user-tasks --between via CLI does not error', async () => {
    await cli('deploy', 'tests/fixtures/list-pis');
    await cli('create', 'pi', '--id=Process_0t60ay7');

    // Wait for the task to be indexed
    await pollUntil(async () => {
      const result = await cli('search', 'ut', '--state=CREATED');
      const items = parseItems<UserTaskRow>(result.stdout);
      return items.length > 0;
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);

    const result = await cli('list', 'ut', `--between=${todayRange()}`, '--all');

    assert.strictEqual(result.status, 0, `CLI should exit 0. stderr: ${result.stderr}`);
    assert.ok(typeof result.stdout === 'string', 'CLI should produce string output');
  });

  test('list incidents --between via CLI does not error', async () => {
    await cli('deploy', 'tests/fixtures/simple-will-create-incident.bpmn');
    const createResult = await cli('create', 'pi', '--id=Process_0yyrstd');
    assert.strictEqual(createResult.status, 0, `Create PI should exit 0. stderr: ${createResult.stderr}`);
    const piKey = parseCreatedKey(createResult);
    assert.ok(piKey, 'Should have process instance key');

    // Wait for a job and fail it to produce an incident; filter by processInstanceKey to avoid
    // picking up jobs from previous tests that may still appear as CREATED in the search index
    let jobKey: string | undefined;
    await pollUntil(async () => {
      const result = await cli('search', 'jobs', '--type=unhandled-job-type', '--state=CREATED', `--processInstanceKey=${piKey}`);
      const items = parseItems<JobRow>(result.stdout);
      if (items.length > 0) {
        const job = items.find(j => String(j.State).toUpperCase() === 'CREATED');
        if (job) { jobKey = String(job.Key); return true; }
      }
      return false;
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);
    await cli('fail', 'job', jobKey!, '--retries=0', '--errorMessage=Intentional failure for list between test');

    // Wait for the incident to be indexed
    await pollUntil(async () => {
      const result = await cli('search', 'inc', '--state=ACTIVE');
      const items = parseItems<IncidentRow>(result.stdout);
      return items.length > 0;
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);

    const result = await cli('list', 'inc', `--between=${todayRange()}`);

    assert.strictEqual(result.status, 0, `CLI should exit 0. stderr: ${result.stderr}`);
    assert.ok(typeof result.stdout === 'string', 'CLI should produce string output');
  });

  test('searchJobs with --between spanning today finds recently created job',
    { skip: jobsBetweenSkip },
    async () => {
      await cli('deploy', 'tests/fixtures/simple-service-task.bpmn');
      await cli('create', 'pi', '--id=Process_18glkb3');

      const found = await pollUntil(async () => {
        const result = await cli('search', 'jobs', '--type=n00b', '--state=CREATED', `--between=${todayRange()}`);
        const items = parseItems<JobRow>(result.stdout);
        return items.length > 0;
      }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);

      assert.ok(found, '--between spanning today should find recently created jobs');
    });

  test('searchJobs with --between and explicit --dateField=creationTime finds recently created job',
    { skip: jobsBetweenSkip },
    async () => {
      await cli('deploy', 'tests/fixtures/simple-service-task.bpmn');
      await cli('create', 'pi', '--id=Process_18glkb3');

      const found = await pollUntil(async () => {
        const result = await cli('search', 'jobs', '--type=n00b', `--between=${todayRange()}`, '--dateField=creationTime');
        const items = parseItems<JobRow>(result.stdout);
        return items.length > 0;
      }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);

      assert.ok(found, '--between with --dateField=creationTime should find recently created jobs');
    });

  test('list jobs --between via CLI does not error',
    { skip: jobsBetweenSkip },
    async () => {
      await cli('deploy', 'tests/fixtures/simple-service-task.bpmn');
      await cli('create', 'pi', '--id=Process_18glkb3');

      // Wait for the job to be indexed
      await pollUntil(async () => {
        const result = await cli('search', 'jobs', '--type=n00b', '--state=CREATED');
        const items = parseItems<JobRow>(result.stdout);
        return items.length > 0;
      }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);

      const result = await cli('list', 'jobs', `--between=${todayRange()}`);

      assert.strictEqual(result.status, 0, `CLI should exit 0. stderr: ${result.stderr}`);
      assert.ok(typeof result.stdout === 'string', 'CLI should produce string output');
    });
});
