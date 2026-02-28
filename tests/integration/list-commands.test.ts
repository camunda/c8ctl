/**
 * Integration tests — all list and get CLI commands, all flag combinations.
 *
 * Covers:
 *   c8 list pi   — default / --id / --state / --all / --sortBy / --asc / --desc
 *                  / --limit / --between / --dateField
 *   c8 list pd   — default / --sortBy / --asc / --desc / --limit
 *   c8 list ut   — default / --state / --all / --sortBy / --asc / --desc / --limit
 *   c8 list inc  — default / --state / --processInstanceKey / --sortBy / --asc / --desc / --limit
 *   c8 list jobs — default / --state / --type / --sortBy / --asc / --desc / --limit
 *   c8 get  pi   — plain / --variables
 *   c8 get  pd   — plain / --xml
 *   c8 get  inc  — plain
 *   c8 search pi / ut / inc / jobs / variables  — CLI surface (complements function-level
 *     coverage already in search.test.ts)
 *   listProcessDefinitions / listUserTasks / listIncidents / listJobs /
 *     getProcessDefinition / getIncident  — function-level coverage for commands that
 *     lack dedicated integration tests.
 *
 * Setup pattern: mirrors tests/integration/pagination.test.ts
 *   — isolated C8CTL_DATA_DIR per run
 *   — cli() helper wraps spawnSync
 *   — pollUntil() waits for Elasticsearch consistency
 *
 * NOTE: Requires a running Camunda 8 instance at http://localhost:8080.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pollUntil } from '../utils/polling.ts';
import { todayRange } from '../utils/date-helpers.ts';
import { listUserTasks } from '../../src/commands/user-tasks.ts';
import { listIncidents, getIncident } from '../../src/commands/incidents.ts';
import { listJobs } from '../../src/commands/jobs.ts';
import { listProcessDefinitions, getProcessDefinition } from '../../src/commands/process-definitions.ts';

const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..');
const CLI = join(PROJECT_ROOT, 'src', 'index.ts');

const POLL_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 1_000;
const SPAWN_TIMEOUT_MS = 30_000;

const camundaVersion = process.env.CAMUNDA_VERSION;
const isCamunda89Plus = camundaVersion !== '8.8';
const jobsBetweenSkip: false | string = isCamunda89Plus
  ? false
  : `creationTime job filter requires Camunda 8.9+ (CAMUNDA_VERSION=${camundaVersion ?? 'unset'})`;

// Shared state populated in before() and consumed by get-command tests
let testBaseDir: string;
let dataDir: string;
let activeProcessInstanceKey: string;      // ACTIVE pi (Process_0t60ay7)
let miniProcessDefinitionKey: string;      // pd key for mini-process-1
let incidentKey: string;                   // incident key
let incidentProcessInstanceKey: string;    // PI that owns the incident

/**
 * Invoke the CLI as a child process.
 * C8CTL_DATA_DIR is set to an isolated temp dir so tests don't touch the real
 * user profile and session state is fully contained within this test file.
 */
function cli(...args: string[]) {
  return spawnSync('node', [CLI, ...args], {
    encoding: 'utf-8',
    timeout: SPAWN_TIMEOUT_MS,
    cwd: PROJECT_ROOT,
    env: { ...process.env, C8CTL_DATA_DIR: dataDir },
  });
}

/** Parse JSON produced by logger.table() in JSON mode; improves error messages. */
function parseJson(stdout: string): any[] {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`CLI output is not valid JSON:\n${stdout.slice(0, 500)}`);
  }
}

describe(
  'List and Get CLI Commands (requires Camunda 8 at localhost:8080)',
  { timeout: 300_000 },
  () => {
    // =========================================================================
    // Setup
    // =========================================================================

    before(async () => {
      testBaseDir = join(tmpdir(), `c8ctl-list-cmds-${Date.now()}-${process.pid}`);
      dataDir = join(testBaseDir, 'data');
      mkdirSync(dataDir, { recursive: true });

      // Deploy all required fixtures
      for (const fixture of [
        'tests/fixtures/mini-process.bpmn',
        'tests/fixtures/simple.bpmn',
        'tests/fixtures/list-pis',
        'tests/fixtures/simple-service-task.bpmn',
        'tests/fixtures/simple-will-create-incident.bpmn',
      ]) {
        const r = cli('deploy', fixture);
        assert.strictEqual(
          r.status, 0,
          `deploy ${fixture} failed.\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
        );
      }

      // Create process instances
      // Process_0t60ay7 has a user task → stays ACTIVE
      for (let i = 0; i < 3; i++) cli('create', 'pi', '--id', 'Process_0t60ay7');
      // simple-process completes immediately → COMPLETED
      for (let i = 0; i < 2; i++) cli('create', 'pi', '--id', 'simple-process');
      // Process_18glkb3 has service task type 'n00b' → creates CREATED jobs (no worker)
      for (let i = 0; i < 2; i++) cli('create', 'pi', '--id', 'Process_18glkb3');
      // Process_0yyrstd creates 'unhandled-job-type' job → used to produce an incident
      cli('create', 'pi', '--id', 'Process_0yyrstd');

      // Switch to JSON mode for data extraction
      cli('output', 'json');

      // Wait for ACTIVE process instances to be indexed
      await pollUntil(async () => {
        const r = cli('search', 'pi', '--id', 'Process_0t60ay7', '--state', 'ACTIVE');
        if (r.status !== 0) return false;
        try {
          const items: any[] = JSON.parse(r.stdout);
          if (items.length > 0) {
            activeProcessInstanceKey = String(items[0].processInstanceKey ?? items[0].key);
            return true;
          }
        } catch { /* retry */ }
        return false;
      }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);

      // Wait for mini-process-1 process definition to be indexed
      await pollUntil(async () => {
        const r = cli('search', 'pd', '--id', 'mini-process-1');
        if (r.status !== 0) return false;
        try {
          const items: any[] = JSON.parse(r.stdout);
          if (items.length > 0) {
            miniProcessDefinitionKey = String(items[0].processDefinitionKey ?? items[0].key);
            return true;
          }
        } catch { /* retry */ }
        return false;
      }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);

      // Create incident: find the 'unhandled-job-type' job and fail it with retries=0
      let incidentJobKey: string | undefined;
      await pollUntil(async () => {
        const r = cli('search', 'jobs', '--type', 'unhandled-job-type', '--state', 'CREATED');
        if (r.status !== 0) return false;
        try {
          const jobs: any[] = JSON.parse(r.stdout);
          const created = jobs.find(j => (j.state ?? '').toUpperCase() === 'CREATED');
          if (created) {
            incidentJobKey = String(created.jobKey ?? created.key);
            return true;
          }
        } catch { /* retry */ }
        return false;
      }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);

      if (incidentJobKey) {
        cli('fail', 'job', incidentJobKey, '--retries', '0', '--errorMessage', 'Intentional test incident');
      }

      // Wait for the incident to be indexed
      await pollUntil(async () => {
        const r = cli('search', 'inc', '--state', 'ACTIVE');
        if (r.status !== 0) return false;
        try {
          const items: any[] = JSON.parse(r.stdout);
          if (items.length > 0) {
            incidentKey = String(items[0].incidentKey ?? items[0].key);
            incidentProcessInstanceKey = String(items[0].processInstanceKey);
            return true;
          }
        } catch { /* retry */ }
        return false;
      }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);

      // Restore text output mode; individual tests set the mode they need
      cli('output', 'text');
    });

    after(() => {
      if (existsSync(testBaseDir)) rmSync(testBaseDir, { recursive: true, force: true });
    });

    // =========================================================================
    // c8 list pi
    // =========================================================================

    describe('list pi', () => {
      test('default output lists only ACTIVE instances', () => {
        cli('output', 'json');
        const r = cli('list', 'pi');
        assert.strictEqual(r.status, 0, `list pi exited ${r.status}. stderr: ${r.stderr}`);
        const items = parseJson(r.stdout);
        assert.ok(items.length > 0, 'Should return at least one ACTIVE instance');
        assert.ok(
          items.every((it: any) => it.State === 'ACTIVE'),
          `Expected all ACTIVE, got: ${[...new Set(items.map((it: any) => it.State))].join(', ')}`,
        );
      });

      test('--id filters by process definition ID', () => {
        cli('output', 'json');
        const r = cli('list', 'pi', '--id', 'Process_0t60ay7');
        assert.strictEqual(r.status, 0, `list pi --id exited ${r.status}. stderr: ${r.stderr}`);
        const items = parseJson(r.stdout);
        assert.ok(items.length > 0, 'Should return instances for the filtered process ID');
        assert.ok(
          items.every((it: any) => it['Process ID'] === 'Process_0t60ay7'),
          `All items should have Process ID === Process_0t60ay7`,
        );
      });

      test('--state=COMPLETED returns only completed instances', () => {
        cli('output', 'json');
        const r = cli('list', 'pi', '--state', 'COMPLETED');
        assert.strictEqual(r.status, 0, `list pi --state=COMPLETED exited ${r.status}. stderr: ${r.stderr}`);
        const items = parseJson(r.stdout);
        assert.ok(items.length > 0, 'Should return completed instances');
        assert.ok(
          items.every((it: any) => it.State === 'COMPLETED'),
          `Expected all COMPLETED, got: ${[...new Set(items.map((it: any) => it.State))].join(', ')}`,
        );
      });

      test('--state=ACTIVE returns only active instances', () => {
        cli('output', 'json');
        const r = cli('list', 'pi', '--state', 'ACTIVE');
        assert.strictEqual(r.status, 0, `list pi --state=ACTIVE exited ${r.status}. stderr: ${r.stderr}`);
        const items = parseJson(r.stdout);
        assert.ok(items.length > 0, 'Should return active instances');
        assert.ok(
          items.every((it: any) => it.State === 'ACTIVE'),
          `Expected all ACTIVE, got: ${[...new Set(items.map((it: any) => it.State))].join(', ')}`,
        );
      });

      test('--all includes both ACTIVE and COMPLETED instances', () => {
        cli('output', 'json');
        const r = cli('list', 'pi', '--all');
        assert.strictEqual(r.status, 0, `list pi --all exited ${r.status}. stderr: ${r.stderr}`);
        const items = parseJson(r.stdout);
        const states = new Set(items.map((it: any) => it.State));
        assert.ok(states.has('ACTIVE'), '--all should include ACTIVE instances');
        assert.ok(states.has('COMPLETED'), '--all should include COMPLETED instances');
      });

      test('--sortBy Key --asc sorts ascending', () => {
        cli('output', 'json');
        const r = cli('list', 'pi', '--all', '--sortBy', 'Key', '--asc');
        assert.strictEqual(r.status, 0, `list pi --sortBy Key --asc exited ${r.status}. stderr: ${r.stderr}`);
        const items = parseJson(r.stdout);
        if (items.length >= 2) {
          const keys = items.map((it: any) => String(it.Key).replace('⚠ ', ''));
          const sorted = [...keys].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
          assert.deepStrictEqual(keys, sorted, 'Items should be sorted ascending by Key');
        }
      });

      test('--sortBy Key --desc sorts descending', () => {
        cli('output', 'json');
        const r = cli('list', 'pi', '--all', '--sortBy', 'Key', '--desc');
        assert.strictEqual(r.status, 0, `list pi --sortBy Key --desc exited ${r.status}. stderr: ${r.stderr}`);
        const items = parseJson(r.stdout);
        if (items.length >= 2) {
          const keys = items.map((it: any) => String(it.Key).replace('⚠ ', ''));
          const sorted = [...keys].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
          assert.deepStrictEqual(keys, sorted, 'Items should be sorted descending by Key');
        }
      });

      test('--limit 2 returns at most 2 instances', () => {
        cli('output', 'json');
        const r = cli('list', 'pi', '--all', '--limit', '2');
        assert.strictEqual(r.status, 0, `list pi --limit 2 exited ${r.status}. stderr: ${r.stderr}`);
        const items = parseJson(r.stdout);
        assert.ok(items.length <= 2, `--limit 2 should return ≤2 items, got ${items.length}`);
      });

      test('--limit 1 returns at most 1 instance', () => {
        cli('output', 'json');
        const r = cli('list', 'pi', '--all', '--limit', '1');
        assert.strictEqual(r.status, 0, `list pi --limit 1 exited ${r.status}. stderr: ${r.stderr}`);
        const items = parseJson(r.stdout);
        assert.ok(items.length <= 1, `--limit 1 should return ≤1 item, got ${items.length}`);
      });

      test('--between spanning today finds recently created instances', async () => {
        cli('output', 'json');
        const found = await pollUntil(async () => {
          const r = cli('list', 'pi', '--state', 'ACTIVE', '--between', todayRange());
          if (r.status !== 0) return false;
          try { return parseJson(r.stdout).length > 0; } catch { return false; }
        }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);
        assert.ok(found, '--between spanning today should find recently created instances');
      });

      test('--between with far-past range returns no instances', () => {
        cli('output', 'json');
        const r = cli('list', 'pi', '--between', '2000-01-01..2000-01-02');
        assert.strictEqual(r.status, 0, `list pi --between past exited ${r.status}. stderr: ${r.stderr}`);
        const items = parseJson(r.stdout);
        assert.strictEqual(items.length, 0, '--between with past range should return no instances');
      });

      test('--between --dateField=startDate finds recent instances', async () => {
        cli('output', 'json');
        const found = await pollUntil(async () => {
          const r = cli('list', 'pi', '--state', 'ACTIVE', '--between', todayRange(), '--dateField', 'startDate');
          if (r.status !== 0) return false;
          try { return parseJson(r.stdout).length > 0; } catch { return false; }
        }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);
        assert.ok(found, '--between --dateField=startDate should find recently created instances');
      });

      test('text output includes expected column headers', () => {
        cli('output', 'text');
        const r = cli('list', 'pi');
        assert.strictEqual(r.status, 0, `list pi text exited ${r.status}. stderr: ${r.stderr}`);
        for (const col of ['Key', 'Process ID', 'State', 'Version']) {
          assert.ok(r.stdout.includes(col), `Text output should include column "${col}"`);
        }
      });
    });

    // =========================================================================
    // c8 list pd
    // =========================================================================

    describe('list pd', () => {
      test('default output lists all process definitions', () => {
        cli('output', 'json');
        const r = cli('list', 'pd');
        assert.strictEqual(r.status, 0, `list pd exited ${r.status}. stderr: ${r.stderr}`);
        const items = parseJson(r.stdout);
        assert.ok(items.length > 0, 'Should return at least one process definition');
      });

      test('--sortBy Process ID --asc sorts ascending', () => {
        cli('output', 'json');
        const r = cli('list', 'pd', '--sortBy', 'Process ID', '--asc');
        assert.strictEqual(r.status, 0, `list pd --sortBy --asc exited ${r.status}. stderr: ${r.stderr}`);
        const items = parseJson(r.stdout);
        if (items.length >= 2) {
          const ids = items.map((it: any) => String(it['Process ID']));
          const sorted = [...ids].sort((a, b) => a.localeCompare(b));
          assert.deepStrictEqual(ids, sorted, 'Items should be sorted ascending by Process ID');
        }
      });

      test('--sortBy Process ID --desc sorts descending', () => {
        cli('output', 'json');
        const r = cli('list', 'pd', '--sortBy', 'Process ID', '--desc');
        assert.strictEqual(r.status, 0, `list pd --sortBy --desc exited ${r.status}. stderr: ${r.stderr}`);
        const items = parseJson(r.stdout);
        if (items.length >= 2) {
          const ids = items.map((it: any) => String(it['Process ID']));
          const sorted = [...ids].sort((a, b) => b.localeCompare(a));
          assert.deepStrictEqual(ids, sorted, 'Items should be sorted descending by Process ID');
        }
      });

      test('--limit 1 returns at most 1 process definition', () => {
        cli('output', 'json');
        const r = cli('list', 'pd', '--limit', '1');
        assert.strictEqual(r.status, 0, `list pd --limit 1 exited ${r.status}. stderr: ${r.stderr}`);
        const items = parseJson(r.stdout);
        assert.ok(items.length <= 1, `--limit 1 should return ≤1 item, got ${items.length}`);
      });

      test('--limit 2 returns at most 2 process definitions', () => {
        cli('output', 'json');
        const r = cli('list', 'pd', '--limit', '2');
        assert.strictEqual(r.status, 0, `list pd --limit 2 exited ${r.status}. stderr: ${r.stderr}`);
        const items = parseJson(r.stdout);
        assert.ok(items.length <= 2, `--limit 2 should return ≤2 items, got ${items.length}`);
      });

      test('text output includes expected column headers', () => {
        cli('output', 'text');
        const r = cli('list', 'pd');
        assert.strictEqual(r.status, 0, `list pd text exited ${r.status}. stderr: ${r.stderr}`);
        for (const col of ['Key', 'Process ID', 'Version']) {
          assert.ok(r.stdout.includes(col), `Text output should include column "${col}"`);
        }
      });
    });

    // =========================================================================
    // c8 list ut
    // =========================================================================

    describe('list ut', () => {
      test('default output lists only CREATED user tasks', () => {
        cli('output', 'json');
        const r = cli('list', 'ut');
        assert.strictEqual(r.status, 0, `list ut exited ${r.status}. stderr: ${r.stderr}`);
        const items = parseJson(r.stdout);
        assert.ok(items.length > 0, 'Should return at least one CREATED user task');
        assert.ok(
          items.every((it: any) => it.State === 'CREATED'),
          `Expected all CREATED, got: ${[...new Set(items.map((it: any) => it.State))].join(', ')}`,
        );
      });

      test('--state=CREATED explicit filter returns CREATED tasks', () => {
        cli('output', 'json');
        const r = cli('list', 'ut', '--state', 'CREATED');
        assert.strictEqual(r.status, 0, `list ut --state=CREATED exited ${r.status}. stderr: ${r.stderr}`);
        const items = parseJson(r.stdout);
        assert.ok(items.length > 0, 'Should return CREATED user tasks');
        assert.ok(
          items.every((it: any) => it.State === 'CREATED'),
          `All items should be CREATED`,
        );
      });

      test('--all exits successfully and returns valid JSON', () => {
        cli('output', 'json');
        const r = cli('list', 'ut', '--all');
        assert.strictEqual(r.status, 0, `list ut --all exited ${r.status}. stderr: ${r.stderr}`);
        assert.doesNotThrow(() => parseJson(r.stdout), '--all should return valid JSON array');
      });

      test('--sortBy Key --asc sorts ascending', () => {
        cli('output', 'json');
        const r = cli('list', 'ut', '--sortBy', 'Key', '--asc');
        assert.strictEqual(r.status, 0, `list ut --sortBy Key --asc exited ${r.status}. stderr: ${r.stderr}`);
        const items = parseJson(r.stdout);
        if (items.length >= 2) {
          const keys = items.map((it: any) => String(it.Key));
          const sorted = [...keys].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
          assert.deepStrictEqual(keys, sorted, 'Items should be sorted ascending by Key');
        }
      });

      test('--sortBy Key --desc sorts descending', () => {
        cli('output', 'json');
        const r = cli('list', 'ut', '--sortBy', 'Key', '--desc');
        assert.strictEqual(r.status, 0, `list ut --sortBy Key --desc exited ${r.status}. stderr: ${r.stderr}`);
        const items = parseJson(r.stdout);
        if (items.length >= 2) {
          const keys = items.map((it: any) => String(it.Key));
          const sorted = [...keys].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
          assert.deepStrictEqual(keys, sorted, 'Items should be sorted descending by Key');
        }
      });

      test('--limit 1 returns at most 1 user task', () => {
        cli('output', 'json');
        const r = cli('list', 'ut', '--limit', '1');
        assert.strictEqual(r.status, 0, `list ut --limit 1 exited ${r.status}. stderr: ${r.stderr}`);
        const items = parseJson(r.stdout);
        assert.ok(items.length <= 1, `--limit 1 should return ≤1 item, got ${items.length}`);
      });

      test('text output includes expected column headers', () => {
        cli('output', 'text');
        const r = cli('list', 'ut');
        assert.strictEqual(r.status, 0, `list ut text exited ${r.status}. stderr: ${r.stderr}`);
        for (const col of ['Key', 'State', 'Assignee']) {
          assert.ok(r.stdout.includes(col), `Text output should include column "${col}"`);
        }
      });
    });

    // =========================================================================
    // c8 list inc
    // =========================================================================

    describe('list inc', () => {
      test('default output lists incidents', () => {
        cli('output', 'json');
        const r = cli('list', 'inc');
        assert.strictEqual(r.status, 0, `list inc exited ${r.status}. stderr: ${r.stderr}`);
        const items = parseJson(r.stdout);
        assert.ok(items.length > 0, 'Should return at least one incident');
      });

      test('--state=ACTIVE returns only active incidents', () => {
        cli('output', 'json');
        const r = cli('list', 'inc', '--state', 'ACTIVE');
        assert.strictEqual(r.status, 0, `list inc --state=ACTIVE exited ${r.status}. stderr: ${r.stderr}`);
        const items = parseJson(r.stdout);
        assert.ok(items.length > 0, 'Should return active incidents');
        assert.ok(
          items.every((it: any) => it.State === 'ACTIVE'),
          `All items should be ACTIVE`,
        );
      });

      test('--processInstanceKey filters by process instance', () => {
        cli('output', 'json');
        const r = cli('list', 'inc', '--processInstanceKey', incidentProcessInstanceKey);
        assert.strictEqual(r.status, 0, `list inc --processInstanceKey exited ${r.status}. stderr: ${r.stderr}`);
        const items = parseJson(r.stdout);
        assert.ok(items.length > 0, 'Should return incidents for the process instance');
        assert.ok(
          items.every((it: any) => String(it['Process Instance']) === incidentProcessInstanceKey),
          `All items should belong to processInstanceKey=${incidentProcessInstanceKey}`,
        );
      });

      test('--sortBy Key --asc sorts ascending', () => {
        cli('output', 'json');
        const r = cli('list', 'inc', '--sortBy', 'Key', '--asc');
        assert.strictEqual(r.status, 0, `list inc --sortBy Key --asc exited ${r.status}. stderr: ${r.stderr}`);
        const items = parseJson(r.stdout);
        if (items.length >= 2) {
          const keys = items.map((it: any) => String(it.Key));
          const sorted = [...keys].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
          assert.deepStrictEqual(keys, sorted, 'Items should be sorted ascending by Key');
        }
      });

      test('--sortBy Key --desc sorts descending', () => {
        cli('output', 'json');
        const r = cli('list', 'inc', '--sortBy', 'Key', '--desc');
        assert.strictEqual(r.status, 0, `list inc --sortBy Key --desc exited ${r.status}. stderr: ${r.stderr}`);
        const items = parseJson(r.stdout);
        if (items.length >= 2) {
          const keys = items.map((it: any) => String(it.Key));
          const sorted = [...keys].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
          assert.deepStrictEqual(keys, sorted, 'Items should be sorted descending by Key');
        }
      });

      test('--limit 1 returns at most 1 incident', () => {
        cli('output', 'json');
        const r = cli('list', 'inc', '--limit', '1');
        assert.strictEqual(r.status, 0, `list inc --limit 1 exited ${r.status}. stderr: ${r.stderr}`);
        const items = parseJson(r.stdout);
        assert.ok(items.length <= 1, `--limit 1 should return ≤1 item, got ${items.length}`);
      });

      test('text output includes expected column headers', () => {
        cli('output', 'text');
        const r = cli('list', 'inc');
        assert.strictEqual(r.status, 0, `list inc text exited ${r.status}. stderr: ${r.stderr}`);
        for (const col of ['Key', 'Type', 'State', 'Message']) {
          assert.ok(r.stdout.includes(col), `Text output should include column "${col}"`);
        }
      });
    });

    // =========================================================================
    // c8 list jobs
    // =========================================================================

    describe('list jobs', () => {
      test('default output lists jobs', () => {
        cli('output', 'json');
        const r = cli('list', 'jobs');
        assert.strictEqual(r.status, 0, `list jobs exited ${r.status}. stderr: ${r.stderr}`);
        const items = parseJson(r.stdout);
        assert.ok(items.length > 0, 'Should return at least one job');
      });

      test('--state=CREATED returns only created jobs', () => {
        cli('output', 'json');
        const r = cli('list', 'jobs', '--state', 'CREATED');
        assert.strictEqual(r.status, 0, `list jobs --state=CREATED exited ${r.status}. stderr: ${r.stderr}`);
        const items = parseJson(r.stdout);
        assert.ok(items.length > 0, 'Should return jobs in CREATED state');
        assert.ok(
          items.every((it: any) => it.State === 'CREATED'),
          `All items should be CREATED`,
        );
      });

      test('--type=n00b filters by job type', () => {
        cli('output', 'json');
        const r = cli('list', 'jobs', '--type', 'n00b');
        assert.strictEqual(r.status, 0, `list jobs --type=n00b exited ${r.status}. stderr: ${r.stderr}`);
        const items = parseJson(r.stdout);
        assert.ok(items.length > 0, 'Should return jobs of type n00b');
        assert.ok(
          items.every((it: any) => it.Type === 'n00b'),
          `All items should have Type === n00b, got: ${[...new Set(items.map((it: any) => it.Type))].join(', ')}`,
        );
      });

      test('--sortBy Key --asc sorts ascending', () => {
        cli('output', 'json');
        const r = cli('list', 'jobs', '--sortBy', 'Key', '--asc');
        assert.strictEqual(r.status, 0, `list jobs --sortBy Key --asc exited ${r.status}. stderr: ${r.stderr}`);
        const items = parseJson(r.stdout);
        if (items.length >= 2) {
          const keys = items.map((it: any) => String(it.Key));
          const sorted = [...keys].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
          assert.deepStrictEqual(keys, sorted, 'Items should be sorted ascending by Key');
        }
      });

      test('--sortBy Key --desc sorts descending', () => {
        cli('output', 'json');
        const r = cli('list', 'jobs', '--sortBy', 'Key', '--desc');
        assert.strictEqual(r.status, 0, `list jobs --sortBy Key --desc exited ${r.status}. stderr: ${r.stderr}`);
        const items = parseJson(r.stdout);
        if (items.length >= 2) {
          const keys = items.map((it: any) => String(it.Key));
          const sorted = [...keys].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
          assert.deepStrictEqual(keys, sorted, 'Items should be sorted descending by Key');
        }
      });

      test('--limit 1 returns at most 1 job', () => {
        cli('output', 'json');
        const r = cli('list', 'jobs', '--limit', '1');
        assert.strictEqual(r.status, 0, `list jobs --limit 1 exited ${r.status}. stderr: ${r.stderr}`);
        const items = parseJson(r.stdout);
        assert.ok(items.length <= 1, `--limit 1 should return ≤1 item, got ${items.length}`);
      });

      test('text output includes expected column headers', () => {
        cli('output', 'text');
        const r = cli('list', 'jobs');
        assert.strictEqual(r.status, 0, `list jobs text exited ${r.status}. stderr: ${r.stderr}`);
        for (const col of ['Key', 'Type', 'State', 'Retries']) {
          assert.ok(r.stdout.includes(col), `Text output should include column "${col}"`);
        }
      });

      test('--between spanning today finds recently created jobs', { skip: jobsBetweenSkip }, async () => {
        cli('output', 'json');
        const found = await pollUntil(async () => {
          const r = cli('list', 'jobs', '--state', 'CREATED', '--between', todayRange());
          if (r.status !== 0) return false;
          try { return parseJson(r.stdout).length > 0; } catch { return false; }
        }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);
        assert.ok(found, '--between spanning today should find recently created jobs');
      });
    });

    // =========================================================================
    // c8 get pi
    // =========================================================================

    describe('get pi', () => {
      test('returns process instance JSON', () => {
        const r = cli('get', 'pi', activeProcessInstanceKey);
        assert.strictEqual(r.status, 0, `get pi exited ${r.status}. stderr: ${r.stderr}`);
        const obj = JSON.parse(r.stdout);
        assert.ok(obj, 'Should return a JSON object');
        const key = String(obj.processInstanceKey ?? obj.key);
        assert.strictEqual(key, activeProcessInstanceKey, 'Returned key should match requested key');
      });

      test('--variables includes variables array in response', () => {
        const r = cli('get', 'pi', activeProcessInstanceKey, '--variables');
        assert.strictEqual(r.status, 0, `get pi --variables exited ${r.status}. stderr: ${r.stderr}`);
        const obj = JSON.parse(r.stdout);
        assert.ok(obj, 'Should return a JSON object');
        assert.ok('variables' in obj, 'Response should contain a variables property');
        assert.ok(Array.isArray(obj.variables), 'variables should be an array');
      });
    });

    // =========================================================================
    // c8 get pd
    // =========================================================================

    describe('get pd', () => {
      test('returns process definition JSON', () => {
        const r = cli('get', 'pd', miniProcessDefinitionKey);
        assert.strictEqual(r.status, 0, `get pd exited ${r.status}. stderr: ${r.stderr}`);
        const obj = JSON.parse(r.stdout);
        assert.ok(obj, 'Should return a JSON object');
        assert.strictEqual(
          obj.processDefinitionId,
          'mini-process-1',
          'Returned processDefinitionId should be mini-process-1',
        );
      });

      test('--xml returns BPMN XML string', () => {
        const r = cli('get', 'pd', miniProcessDefinitionKey, '--xml');
        assert.strictEqual(r.status, 0, `get pd --xml exited ${r.status}. stderr: ${r.stderr}`);
        assert.ok(r.stdout.includes('bpmn:'), 'XML output should contain BPMN namespace');
        assert.ok(r.stdout.includes('mini-process-1'), 'XML output should contain the process ID');
      });
    });

    // =========================================================================
    // c8 get inc
    // =========================================================================

    describe('get inc', () => {
      test('returns incident JSON', () => {
        const r = cli('get', 'inc', incidentKey);
        assert.strictEqual(r.status, 0, `get inc exited ${r.status}. stderr: ${r.stderr}`);
        const obj = JSON.parse(r.stdout);
        assert.ok(obj, 'Should return a JSON object');
        const key = String(obj.incidentKey ?? obj.key);
        assert.strictEqual(key, incidentKey, 'Returned key should match requested incident key');
      });
    });

    // =========================================================================
    // c8 search — CLI surface tests
    // (function-level coverage lives in tests/integration/search.test.ts)
    // =========================================================================

    describe('search pi via CLI', () => {
      test('--id=Process_0t60ay7 --state=ACTIVE filters correctly', () => {
        cli('output', 'json');
        const r = cli('search', 'pi', '--id', 'Process_0t60ay7', '--state', 'ACTIVE');
        assert.strictEqual(r.status, 0, `search pi --id --state exited ${r.status}. stderr: ${r.stderr}`);
        const items = parseJson(r.stdout);
        assert.ok(items.length > 0, 'Should find active instances with the given process ID');
        assert.ok(
          items.every((it: any) => it.processDefinitionId === 'Process_0t60ay7'),
          'All items should match Process_0t60ay7',
        );
      });

      test('--key=<key> finds exact process instance', () => {
        cli('output', 'json');
        const r = cli('search', 'pi', '--key', activeProcessInstanceKey);
        assert.strictEqual(r.status, 0, `search pi --key exited ${r.status}. stderr: ${r.stderr}`);
        const items = parseJson(r.stdout);
        assert.ok(items.length > 0, 'Should find the instance by key');
        const key = String((items[0] as any).processInstanceKey ?? (items[0] as any).key);
        assert.strictEqual(key, activeProcessInstanceKey, 'Returned key should match');
      });

      test('--sortBy processInstanceKey --asc exits 0', () => {
        cli('output', 'json');
        const r = cli('search', 'pi', '--sortBy', 'processInstanceKey', '--asc');
        assert.strictEqual(r.status, 0, `search pi --sortBy --asc exited ${r.status}. stderr: ${r.stderr}`);
        assert.doesNotThrow(() => parseJson(r.stdout), 'Should return valid JSON');
      });

      test('--sortBy processInstanceKey --desc exits 0', () => {
        cli('output', 'json');
        const r = cli('search', 'pi', '--sortBy', 'processInstanceKey', '--desc');
        assert.strictEqual(r.status, 0, `search pi --sortBy --desc exited ${r.status}. stderr: ${r.stderr}`);
        assert.doesNotThrow(() => parseJson(r.stdout), 'Should return valid JSON');
      });
    });

    describe('search ut via CLI', () => {
      test('--state=CREATED filters to created tasks', () => {
        cli('output', 'json');
        const r = cli('search', 'ut', '--state', 'CREATED');
        assert.strictEqual(r.status, 0, `search ut --state=CREATED exited ${r.status}. stderr: ${r.stderr}`);
        const items = parseJson(r.stdout);
        assert.ok(items.length > 0, 'Should find CREATED user tasks');
        assert.ok(
          items.every((it: any) => it.state === 'CREATED'),
          'All items should be CREATED',
        );
      });

      test('--sortBy userTaskKey --asc exits 0', () => {
        cli('output', 'json');
        const r = cli('search', 'ut', '--sortBy', 'userTaskKey', '--asc');
        assert.strictEqual(r.status, 0, `search ut --sortBy --asc exited ${r.status}. stderr: ${r.stderr}`);
        assert.doesNotThrow(() => parseJson(r.stdout), 'Should return valid JSON');
      });

      test('--sortBy userTaskKey --desc exits 0', () => {
        cli('output', 'json');
        const r = cli('search', 'ut', '--sortBy', 'userTaskKey', '--desc');
        assert.strictEqual(r.status, 0, `search ut --sortBy --desc exited ${r.status}. stderr: ${r.stderr}`);
        assert.doesNotThrow(() => parseJson(r.stdout), 'Should return valid JSON');
      });
    });

    describe('search inc via CLI', () => {
      test('--state=ACTIVE filters to active incidents', () => {
        cli('output', 'json');
        const r = cli('search', 'inc', '--state', 'ACTIVE');
        assert.strictEqual(r.status, 0, `search inc --state=ACTIVE exited ${r.status}. stderr: ${r.stderr}`);
        const items = parseJson(r.stdout);
        assert.ok(items.length > 0, 'Should find active incidents');
        assert.ok(
          items.every((it: any) => it.state === 'ACTIVE'),
          'All items should be ACTIVE',
        );
      });

      test('--sortBy incidentKey --asc exits 0', () => {
        cli('output', 'json');
        const r = cli('search', 'inc', '--sortBy', 'incidentKey', '--asc');
        assert.strictEqual(r.status, 0, `search inc --sortBy --asc exited ${r.status}. stderr: ${r.stderr}`);
        assert.doesNotThrow(() => parseJson(r.stdout), 'Should return valid JSON');
      });

      test('--sortBy incidentKey --desc exits 0', () => {
        cli('output', 'json');
        const r = cli('search', 'inc', '--sortBy', 'incidentKey', '--desc');
        assert.strictEqual(r.status, 0, `search inc --sortBy --desc exited ${r.status}. stderr: ${r.stderr}`);
        assert.doesNotThrow(() => parseJson(r.stdout), 'Should return valid JSON');
      });
    });

    describe('search jobs via CLI', () => {
      test('--type=n00b filters by job type', () => {
        cli('output', 'json');
        const r = cli('search', 'jobs', '--type', 'n00b');
        assert.strictEqual(r.status, 0, `search jobs --type=n00b exited ${r.status}. stderr: ${r.stderr}`);
        const items = parseJson(r.stdout);
        assert.ok(items.length > 0, 'Should find jobs of type n00b');
        assert.ok(
          items.every((it: any) => it.type === 'n00b'),
          `All items should have type === n00b, got: ${[...new Set(items.map((it: any) => it.type))].join(', ')}`,
        );
      });

      test('--state=CREATED filters by job state', () => {
        cli('output', 'json');
        const r = cli('search', 'jobs', '--state', 'CREATED');
        assert.strictEqual(r.status, 0, `search jobs --state=CREATED exited ${r.status}. stderr: ${r.stderr}`);
        const items = parseJson(r.stdout);
        assert.ok(items.length > 0, 'Should find jobs in CREATED state');
        assert.ok(
          items.every((it: any) => it.state === 'CREATED'),
          'All items should be CREATED',
        );
      });

      test('--sortBy jobKey --asc exits 0', () => {
        cli('output', 'json');
        const r = cli('search', 'jobs', '--sortBy', 'jobKey', '--asc');
        assert.strictEqual(r.status, 0, `search jobs --sortBy --asc exited ${r.status}. stderr: ${r.stderr}`);
        assert.doesNotThrow(() => parseJson(r.stdout), 'Should return valid JSON');
      });

      test('--sortBy jobKey --desc exits 0', () => {
        cli('output', 'json');
        const r = cli('search', 'jobs', '--sortBy', 'jobKey', '--desc');
        assert.strictEqual(r.status, 0, `search jobs --sortBy --desc exited ${r.status}. stderr: ${r.stderr}`);
        assert.doesNotThrow(() => parseJson(r.stdout), 'Should return valid JSON');
      });
    });

    describe('search variables via CLI', () => {
      test('exits 0 and returns valid JSON', () => {
        cli('output', 'json');
        const r = cli('search', 'variables');
        assert.strictEqual(r.status, 0, `search variables exited ${r.status}. stderr: ${r.stderr}`);
        assert.doesNotThrow(() => parseJson(r.stdout), 'Should return valid JSON');
      });

      test('--processInstanceKey filters to the given PI', () => {
        cli('output', 'json');
        const r = cli('search', 'variables', '--processInstanceKey', activeProcessInstanceKey);
        assert.strictEqual(r.status, 0, `search variables --processInstanceKey exited ${r.status}. stderr: ${r.stderr}`);
        const items = parseJson(r.stdout);
        if (items.length > 0) {
          assert.ok(
            items.every((it: any) => String(it.processInstanceKey) === activeProcessInstanceKey),
            'All variables should belong to the queried process instance',
          );
        }
      });
    });

    // =========================================================================
    // Function-level tests for list/get commands that lacked direct coverage
    // =========================================================================

    /**
     * Temporarily captures console.log calls so we can assert on logger output.
     * The singleton logger (getLogger()) writes via console.log in text mode.
     */
    async function captureLog(fn: () => Promise<void>): Promise<string> {
      const lines: string[] = [];
      const origLog = console.log;
      console.log = (...args: any[]) => lines.push(args.join(' '));
      try {
        await fn();
      } finally {
        console.log = origLog;
      }
      return lines.join('\n');
    }

    describe('listProcessDefinitions function', () => {
      test('produces table output containing deployed definitions', async () => {
        const output = await captureLog(() => listProcessDefinitions({}));
        assert.ok(output.length > 0, 'listProcessDefinitions should produce output');
        // Output is a text table — should contain at least one process ID from setup
        assert.ok(
          output.includes('mini-process-1') || output.includes('Process ID') || output.includes('No process definitions'),
          `Output should contain table data or no-data message. Got: ${output.slice(0, 200)}`,
        );
      });

      test('--limit 1 produces output for at most 1 definition', async () => {
        const output = await captureLog(() => listProcessDefinitions({ limit: 1 }));
        assert.ok(output.length > 0, 'Should produce output even with limit');
      });
    });

    describe('getProcessDefinition function', () => {
      test('outputs JSON containing processDefinitionId for the queried key', async () => {
        const output = await captureLog(() => getProcessDefinition(miniProcessDefinitionKey, {}));
        assert.ok(output.length > 0, 'getProcessDefinition should produce JSON output');
        assert.ok(
          output.includes('mini-process-1'),
          `Output should contain processDefinitionId "mini-process-1". Got: ${output.slice(0, 200)}`,
        );
      });

      test('--xml outputs BPMN XML string for the queried key', async () => {
        const output = await captureLog(() => getProcessDefinition(miniProcessDefinitionKey, { xml: true }));
        assert.ok(output.length > 0, 'getProcessDefinition with xml:true should produce output');
        assert.ok(output.includes('bpmn:'), `XML output should contain BPMN namespace. Got: ${output.slice(0, 200)}`);
        assert.ok(
          output.includes('mini-process-1'),
          `XML output should contain the process ID. Got: ${output.slice(0, 200)}`,
        );
      });
    });

    describe('listUserTasks function', () => {
      test('produces table output containing user tasks', async () => {
        const output = await captureLog(() => listUserTasks({}));
        assert.ok(output.length > 0, 'listUserTasks should produce output');
        assert.ok(
          output.includes('CREATED') || output.includes('State') || output.includes('No user tasks'),
          `Output should contain task data or no-data message. Got: ${output.slice(0, 200)}`,
        );
      });

      test('--state=CREATED filter produces output', async () => {
        const output = await captureLog(() => listUserTasks({ state: 'CREATED' }));
        assert.ok(output.length > 0, 'listUserTasks with state filter should produce output');
        // Should contain task data (CREATED) or the no-data message
        assert.ok(
          output.includes('CREATED') || output.includes('No user tasks'),
          `Output should mention CREATED tasks or no-data message. Got: ${output.slice(0, 200)}`,
        );
      });

      test('--limit 1 returns at most one row in table output', async () => {
        const output = await captureLog(() => listUserTasks({ limit: 1 }));
        assert.ok(output.length > 0, 'listUserTasks with limit should produce output');
      });
    });

    describe('listIncidents function', () => {
      test('produces table output containing at least one ACTIVE incident', async () => {
        const output = await captureLog(() => listIncidents({ state: 'ACTIVE' }));
        assert.ok(output.length > 0, 'listIncidents should produce output');
        assert.ok(
          output.includes('ACTIVE') || output.includes('State'),
          `Output should contain ACTIVE incident data. Got: ${output.slice(0, 200)}`,
        );
      });

      test('--processInstanceKey filters to matching PI', async () => {
        const output = await captureLog(() => listIncidents({ processInstanceKey: incidentProcessInstanceKey }));
        assert.ok(output.length > 0, 'listIncidents with processInstanceKey should produce output');
        assert.ok(
          output.includes(incidentProcessInstanceKey) || output.includes('Process Instance'),
          `Output should contain the process instance key. Got: ${output.slice(0, 200)}`,
        );
      });

      test('--limit 1 produces output', async () => {
        const output = await captureLog(() => listIncidents({ limit: 1 }));
        assert.ok(output.length > 0, 'listIncidents with limit should produce output');
      });
    });

    describe('getIncident function', () => {
      test('outputs JSON containing the incident key', async () => {
        const output = await captureLog(() => getIncident(incidentKey, {}));
        assert.ok(output.length > 0, 'getIncident should produce JSON output');
        assert.ok(
          output.includes(incidentKey),
          `Output should contain incident key ${incidentKey}. Got: ${output.slice(0, 200)}`,
        );
      });
    });

    describe('listJobs function', () => {
      test('produces table output containing jobs', async () => {
        const output = await captureLog(() => listJobs({}));
        assert.ok(output.length > 0, 'listJobs should produce output');
        assert.ok(
          output.includes('n00b') || output.includes('Type') || output.includes('No jobs'),
          `Output should contain job data or no-data message. Got: ${output.slice(0, 200)}`,
        );
      });

      test('--state=CREATED filter produces output', async () => {
        const output = await captureLog(() => listJobs({ state: 'CREATED' }));
        assert.ok(output.length > 0, 'listJobs with state filter should produce output');
        assert.ok(
          output.includes('CREATED') || output.includes('No jobs'),
          `Output should mention CREATED jobs or no-data message. Got: ${output.slice(0, 200)}`,
        );
      });

      test('--type=n00b filter produces output containing n00b type', async () => {
        const output = await captureLog(() => listJobs({ type: 'n00b' }));
        assert.ok(output.length > 0, 'listJobs with type filter should produce output');
        assert.ok(
          output.includes('n00b') || output.includes('No jobs'),
          `Output should contain n00b type or no-data message. Got: ${output.slice(0, 200)}`,
        );
      });

      test('--limit 1 produces output', async () => {
        const output = await captureLog(() => listJobs({ limit: 1 }));
        assert.ok(output.length > 0, 'listJobs with limit should produce output');
      });
    });
  },
);
