/**
 * Integration tests for pagination beyond CI_PAGE_SIZE (1000)
 *
 * Deploys > 1000 unique process definitions from a mini-process BPMN template,
 * then verifies that `search pd` and `list pd` via the CLI return ALL of them
 * rather than silently truncating at the API default page size (100) or CI_PAGE_SIZE (1000).
 *
 * NOTE: These tests require a running Camunda 8 instance at http://localhost:8080
 * and take considerable time due to the volume of deployments.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pollUntil } from '../utils/polling.ts';

const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..');
const CLI = join(PROJECT_ROOT, 'src', 'index.ts');
const TEMPLATE_BPMN = readFileSync(join(PROJECT_ROOT, 'tests', 'fixtures', 'mini-process.bpmn'), 'utf-8');

/** Number of unique process definitions to deploy (must be > CI_PAGE_SIZE of 1000) */
const DEPLOY_COUNT = 1010;

/** Max BPMN files per single deploy call (avoids multipart request size limits) */
const DEPLOY_BATCH_SIZE = 25;

/** Polling configuration — indexing a large batch may take a while */
const POLL_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 3_000;

/** Spawn timeout for CLI commands */
const SPAWN_TIMEOUT_MS = 300_000;

/** Shared temp directory + data dir for this test suite */
let bpmnDir: string;
let dataDir: string;

/**
 * Invoke the CLI as a subprocess, returning { stdout, stderr, status }.
 * Uses a dedicated C8CTL_DATA_DIR so session state is isolated.
 */
function cli(...args: string[]) {
  return spawnSync('node', [CLI, ...args], {
    encoding: 'utf-8',
    timeout: SPAWN_TIMEOUT_MS,
    cwd: PROJECT_ROOT,
    env: { ...process.env, C8CTL_DATA_DIR: dataDir },
  });
}

/**
 * Generate a BPMN string with a given process id by replacing the template's id.
 */
function bpmnWithId(id: string): string {
  return TEMPLATE_BPMN
    .replace(/id="mini-process-1"/g, `id="${id}"`)
    .replace(/bpmnElement="mini-process-1"/g, `bpmnElement="${id}"`);
}

describe('Pagination beyond CI_PAGE_SIZE (requires Camunda 8 at localhost:8080)', { timeout: 600_000 }, () => {
  before(() => {
    // Create temp directories for BPMN files and CLI data dir
    const base = join(tmpdir(), `c8ctl-pagination-test-${Date.now()}`);
    bpmnDir = join(base, 'bpmn');
    dataDir = join(base, 'data');
    mkdirSync(bpmnDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });

    // Generate BPMN files with ids mini-process-1 .. mini-process-<DEPLOY_COUNT>
    for (let i = 1; i <= DEPLOY_COUNT; i++) {
      const id = `mini-process-${i}`;
      writeFileSync(join(bpmnDir, `${id}.bpmn`), bpmnWithId(id));
    }

    // Deploy in batches to avoid multipart request size limits
    const allFiles = readdirSync(bpmnDir).filter(f => f.endsWith('.bpmn')).sort();

    for (let i = 0; i < allFiles.length; i += DEPLOY_BATCH_SIZE) {
      const batch = allFiles.slice(i, i + DEPLOY_BATCH_SIZE);
      const batchPaths = batch.map(f => join(bpmnDir, f));
      const result = cli('deploy', ...batchPaths);
      assert.strictEqual(
        result.status, 0,
        `Deploy batch ${Math.floor(i / DEPLOY_BATCH_SIZE) + 1} should exit 0. stderr: ${result.stderr}`,
      );
    }
  });

  after(() => {
    const base = join(bpmnDir, '..');
    if (existsSync(base)) {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test(`search pd --id=mini-process-* returns all ${DEPLOY_COUNT} definitions`, { timeout: POLL_TIMEOUT_MS + 30_000 }, async () => {
    // Switch output to JSON for easy parsing
    cli('output', 'json');

    // Poll until Elasticsearch has indexed all deployed definitions
    await pollUntil(async () => {
      const result = cli('search', 'pd', '--id=mini-process-*');
      if (result.status !== 0) return false;
      try {
        return JSON.parse(result.stdout).length >= DEPLOY_COUNT;
      } catch { return false; }
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);

    // Final assertion
    const finalResult = cli('search', 'pd', '--id=mini-process-*');
    assert.strictEqual(finalResult.status, 0, `search should exit 0. stderr: ${finalResult.stderr}`);

    const items = JSON.parse(finalResult.stdout);
    assert.ok(items.length >= DEPLOY_COUNT, `Expected >= ${DEPLOY_COUNT} definitions, got ${items.length}`);
    assert.ok(items.length > 1000, `Result count (${items.length}) should exceed CI_PAGE_SIZE (1000)`);
  });

  test(`list pd returns all ${DEPLOY_COUNT} definitions`, { timeout: POLL_TIMEOUT_MS + 30_000 }, async () => {
    cli('output', 'json');

    await pollUntil(async () => {
      const result = cli('list', 'pd');
      if (result.status !== 0) return false;
      try {
        return JSON.parse(result.stdout).length >= DEPLOY_COUNT;
      } catch { return false; }
    }, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);

    const finalResult = cli('list', 'pd');
    assert.strictEqual(finalResult.status, 0, `list pd should exit 0. stderr: ${finalResult.stderr}`);

    const items = JSON.parse(finalResult.stdout);
    assert.ok(items.length >= DEPLOY_COUNT, `Expected >= ${DEPLOY_COUNT} definitions, got ${items.length}`);
    assert.ok(items.length > 1000, `Result count (${items.length}) should exceed CI_PAGE_SIZE (1000)`);
  });
});
