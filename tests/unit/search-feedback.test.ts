/**
 * Unit tests for search feedback improvements:
 * - Unknown flag detection (detectUnknownFlags — generalised across all verbs)
 * - Empty result messaging with 🕳️ (logNoResults)
 * - Truncation / page-size warnings (logResultCount)
 * - No-filter hints
 * - GLOBAL_FLAGS and resourceFlags validation
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  logNoResults,
  logResultCount,
} from '../../src/commands/search.ts';
import {
  COMMAND_REGISTRY,
  GLOBAL_FLAGS,
  SEARCH_FLAGS,
} from '../../src/command-registry.ts';
import { detectUnknownFlags } from '../../src/command-validation.ts';
import { Logger, type LogWriter } from '../../src/logger.ts';

/** Create a Logger whose output is captured into arrays for assertions. */
function createTestLogger(): { logger: Logger; logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  const logWriter: LogWriter = {
    log(...data: any[]) { logs.push(data.map(String).join(' ')); },
    error(...data: any[]) { errors.push(data.map(String).join(' ')); },
  };
  const logger = new Logger(logWriter);
  return { logger, logs, errors };
}

describe('detectUnknownFlags (search verb)', () => {
  test('returns empty array when no flags are set', () => {
    const values = {};
    assert.deepStrictEqual(detectUnknownFlags('search', 'process-definition', values), []);
  });

  test('returns empty array when only global flags are set', () => {
    const values = { profile: 'dev', sortBy: 'Name', asc: true };
    assert.deepStrictEqual(detectUnknownFlags('search', 'process-definition', values), []);
  });

  test('returns empty array when valid resource flags are set', () => {
    const values = { bpmnProcessId: 'my-process', name: 'My Process' };
    assert.deepStrictEqual(detectUnknownFlags('search', 'process-definition', values), []);
  });

  test('detects unknown flag for process-definitions', () => {
    const values = { assignee: 'john', name: 'My Process' };
    const unknown = detectUnknownFlags('search', 'process-definition', values);
    assert.deepStrictEqual(unknown, ['assignee']);
  });

  test('detects unknown flag for user-tasks', () => {
    const values = { name: 'test', state: 'CREATED' };
    const unknown = detectUnknownFlags('search', 'user-task', values);
    assert.deepStrictEqual(unknown, ['name']);
  });

  test('detects unknown flag for jobs', () => {
    const values = { assignee: 'john', type: 'email' };
    const unknown = detectUnknownFlags('search', 'jobs', values);
    assert.deepStrictEqual(unknown, ['assignee']);
  });

  test('detects unknown flag for variables', () => {
    const values = { type: 'some-type', name: 'myVar' };
    const unknown = detectUnknownFlags('search', 'variable', values);
    assert.deepStrictEqual(unknown, ['type']);
  });

  test('detects unknown flag for incidents', () => {
    const values = { assignee: 'john', state: 'ACTIVE' };
    const unknown = detectUnknownFlags('search', 'incident', values);
    assert.deepStrictEqual(unknown, ['assignee']);
  });

  test('ignores undefined and false values', () => {
    const values = { assignee: undefined, errorType: false, state: 'ACTIVE' };
    const unknown = detectUnknownFlags('search', 'jobs', values);
    assert.deepStrictEqual(unknown, []);
  });

  test('detects multiple unknown flags at once', () => {
    const values = { assignee: 'john', errorType: 'IO', type: 'email' };
    const unknown = detectUnknownFlags('search', 'jobs', values);
    // assignee and errorType are not valid for jobs
    assert.ok(unknown.includes('assignee'));
    assert.ok(unknown.includes('errorType'));
    assert.strictEqual(unknown.length, 2);
  });

  test('handles pluralized resource names (process-definitions → process-definition)', () => {
    const values = { name: 'test' };
    // 'process-definitions' is not a key; the function strips trailing 's' as fallback
    const unknown = detectUnknownFlags('search', 'process-definitions', values);
    assert.deepStrictEqual(unknown, []);
  });

  test('handles variables (pluralized → variable)', () => {
    const values = { name: 'myVar', value: 'hello' };
    const unknown = detectUnknownFlags('search', 'variables', values);
    assert.deepStrictEqual(unknown, []);
  });

  test('--id is valid for process-definition search', () => {
    const values = { id: 'my-process' };
    const unknown = detectUnknownFlags('search', 'process-definition', values);
    assert.deepStrictEqual(unknown, []);
  });

  test('--processDefinitionId is valid for process-definition search', () => {
    const values = { processDefinitionId: 'my-process' };
    const unknown = detectUnknownFlags('search', 'process-definition', values);
    assert.deepStrictEqual(unknown, []);
  });

  test('--id is valid for process-instance search', () => {
    const values = { id: 'my-process' };
    const unknown = detectUnknownFlags('search', 'process-instance', values);
    assert.deepStrictEqual(unknown, []);
  });

  test('--version is valid for process-instance search (global flag)', () => {
    const values = { version: '2' };
    const unknown = detectUnknownFlags('search', 'process-instance', values);
    assert.deepStrictEqual(unknown, []);
  });

  test('--version is valid for process-definition search (global flag)', () => {
    const values = { version: '3' };
    const unknown = detectUnknownFlags('search', 'process-definition', values);
    assert.deepStrictEqual(unknown, []);
  });

  test('--processDefinitionId is valid for incident search', () => {
    const values = { processDefinitionId: 'my-process' };
    const unknown = detectUnknownFlags('search', 'incident', values);
    assert.deepStrictEqual(unknown, []);
  });

  test('returns empty array for unknown resource (no registry entry)', () => {
    const values = { foo: 'bar' };
    // Unknown resources have no resource-specific flags; verb-level flags apply
    const unknown = detectUnknownFlags('search', 'unknown-resource', values);
    // foo is not in search's merged flags, so it's detected
    assert.deepStrictEqual(unknown, ['foo']);
  });

  test('truly unknown flags (not in any resource) are detected', () => {
    const values = { fooBarBaz: 'test' };
    const unknown = detectUnknownFlags('search', 'process-definition', values);
    assert.deepStrictEqual(unknown, ['fooBarBaz']);
  });
});

describe('GLOBAL_FLAGS', () => {
  test('contains expected common flags', () => {
    assert.ok('profile' in GLOBAL_FLAGS);
    assert.ok('help' in GLOBAL_FLAGS);
    assert.ok('version' in GLOBAL_FLAGS);
  });

  test('contains dry-run, verbose, fields', () => {
    assert.ok('dry-run' in GLOBAL_FLAGS);
    assert.ok('verbose' in GLOBAL_FLAGS);
    assert.ok('fields' in GLOBAL_FLAGS);
  });

  test('SEARCH_FLAGS contains between and dateField', () => {
    assert.ok('between' in SEARCH_FLAGS);
    assert.ok('dateField' in SEARCH_FLAGS);
  });

  test('SEARCH_FLAGS contains sortBy, asc, desc', () => {
    assert.ok('sortBy' in SEARCH_FLAGS);
    assert.ok('asc' in SEARCH_FLAGS);
    assert.ok('desc' in SEARCH_FLAGS);
  });

  test('--between is not flagged as unknown for any search resource', () => {
    const resources = ['process-definition', 'process-instance', 'user-task', 'incident', 'jobs', 'variable'];
    for (const resource of resources) {
      const unknown = detectUnknownFlags('search', resource, { between: '2024-01-01..2024-12-31' });
      assert.deepStrictEqual(unknown, [], `--between incorrectly flagged as unknown for '${resource}'`);
    }
  });

  test('--dateField is not flagged as unknown for any search resource', () => {
    const resources = ['process-definition', 'process-instance', 'user-task', 'incident', 'jobs', 'variable'];
    for (const resource of resources) {
      const unknown = detectUnknownFlags('search', resource, { dateField: 'startDate' });
      assert.deepStrictEqual(unknown, [], `--dateField incorrectly flagged as unknown for '${resource}'`);
    }
  });
});

describe('search resourceFlags (from registry)', () => {
  const resourceFlags = COMMAND_REGISTRY.search.resourceFlags;

  test('process-definition includes all expected flags', () => {
    const flags = resourceFlags['process-definition'];
    assert.ok('bpmnProcessId' in flags);
    assert.ok('id' in flags);
    assert.ok('processDefinitionId' in flags);
    assert.ok('name' in flags);
    assert.ok('key' in flags);
    assert.ok('iid' in flags);
    assert.ok('iname' in flags);
  });

  test('process-instance includes all expected flags', () => {
    const flags = resourceFlags['process-instance'];
    assert.ok('bpmnProcessId' in flags);
    assert.ok('id' in flags);
    assert.ok('processDefinitionId' in flags);
    assert.ok('processDefinitionKey' in flags);
    assert.ok('state' in flags);
    assert.ok('key' in flags);
    assert.ok('parentProcessInstanceKey' in flags);
    assert.ok('iid' in flags);
  });

  test('user-task includes all expected flags', () => {
    const flags = resourceFlags['user-task'];
    assert.ok('state' in flags);
    assert.ok('assignee' in flags);
    assert.ok('processInstanceKey' in flags);
    assert.ok('processDefinitionKey' in flags);
    assert.ok('elementId' in flags);
    assert.ok('iassignee' in flags);
  });

  test('incident includes all expected flags', () => {
    const flags = resourceFlags['incident'];
    assert.ok('state' in flags);
    assert.ok('processInstanceKey' in flags);
    assert.ok('processDefinitionKey' in flags);
    assert.ok('bpmnProcessId' in flags);
    assert.ok('id' in flags);
    assert.ok('processDefinitionId' in flags);
    assert.ok('errorType' in flags);
    assert.ok('errorMessage' in flags);
    assert.ok('ierrorMessage' in flags);
    assert.ok('iid' in flags);
  });

  test('jobs includes all expected flags', () => {
    const flags = resourceFlags['jobs'];
    assert.ok('state' in flags);
    assert.ok('type' in flags);
    assert.ok('processInstanceKey' in flags);
    assert.ok('processDefinitionKey' in flags);
    assert.ok('itype' in flags);
  });

  test('variable includes all expected flags', () => {
    const flags = resourceFlags['variable'];
    assert.ok('name' in flags);
    assert.ok('value' in flags);
    assert.ok('processInstanceKey' in flags);
    assert.ok('scopeKey' in flags);
    assert.ok('fullValue' in flags);
    assert.ok('iname' in flags);
    assert.ok('ivalue' in flags);
    // limit is in shared SEARCH_FLAGS, not per-resource
  });

  test('all resources have entries', () => {
    const resources = ['process-definition', 'process-instance', 'user-task', 'incident', 'jobs', 'variable'];
    for (const resource of resources) {
      assert.ok(resourceFlags[resource], `Missing entry for ${resource}`);
      assert.ok(Object.keys(resourceFlags[resource]).length > 0, `Empty flags for ${resource}`);
    }
  });

  test('limit is in shared SEARCH_FLAGS (valid for all search/list resources)', () => {
    assert.ok('limit' in SEARCH_FLAGS, 'limit should be in shared SEARCH_FLAGS');
    // Verify limit is NOT redundantly in per-resource sets
    for (const [resource, flags] of Object.entries(resourceFlags)) {
      assert.ok(
        !('limit' in flags),
        `'limit' should not be in resourceFlags['${resource}'] — it's in shared SEARCH_FLAGS`,
      );
    }
  });
});

// ─── Structural invariant: flag scoping integrity ─────────────────────────────
// GLOBAL_FLAGS and SEARCH_FLAGS should not overlap with per-resource flags.
// This guards against adding a flag to global scope that then silently hides
// resource-specific unknown-flag detection.

describe('Flag scoping — structural invariant', () => {
  const globalAndShared = new Set([
    ...Object.keys(GLOBAL_FLAGS),
    ...Object.keys(SEARCH_FLAGS),
  ]);

  test('GLOBAL_FLAGS and search resourceFlags do not overlap', () => {
    const resourceFlags = COMMAND_REGISTRY.search.resourceFlags;
    for (const [resource, flags] of Object.entries(resourceFlags)) {
      for (const flag of Object.keys(flags)) {
        assert.ok(
          !globalAndShared.has(flag),
          `'${flag}' appears in both global/shared flags and resourceFlags['${resource}']. ` +
          `It should be in one place only.`,
        );
      }
    }
  });
});

describe('logNoResults', () => {
  test('prints 🕳️ message when no results found with filters', () => {
    const { logger, logs } = createTestLogger();
    logNoResults(logger, 'process definitions', true);
    assert.strictEqual(logs.length, 1);
    assert.ok(logs[0].includes('🕳️'));
    assert.ok(logs[0].includes('No process definitions found'));
  });

  test('prints no-filter hint when hasFilters is false', () => {
    const { logger, logs } = createTestLogger();
    logNoResults(logger, 'user tasks', false);
    assert.strictEqual(logs.length, 2);
    assert.ok(logs[0].includes('🕳️'));
    assert.ok(logs[1].includes('No filters were applied'));
    assert.ok(logs[1].includes('c8ctl help search'));
  });

  test('does not print no-filter hint when hasFilters is true', () => {
    const { logger, logs } = createTestLogger();
    logNoResults(logger, 'incidents', true);
    assert.strictEqual(logs.length, 1);
  });

  test('mentions unknown flags when provided', () => {
    const { logger, logs } = createTestLogger();
    logNoResults(logger, 'jobs', true, ['assignee', 'name']);
    assert.strictEqual(logs.length, 1);
    assert.ok(logs[0].includes('--assignee'));
    assert.ok(logs[0].includes('--name'));
    assert.ok(logs[0].includes('ignored unknown flag'));
  });

  test('does not mention unknown flags when array is empty', () => {
    const { logger, logs } = createTestLogger();
    logNoResults(logger, 'variables', true, []);
    assert.strictEqual(logs.length, 1);
    assert.ok(!logs[0].includes('ignored unknown'));
  });

  test('combines unknown flags and no-filter hint', () => {
    const { logger, logs } = createTestLogger();
    logNoResults(logger, 'process instances', false, ['fooBar']);
    assert.strictEqual(logs.length, 2);
    assert.ok(logs[0].includes('--fooBar'));
    assert.ok(logs[1].includes('No filters were applied'));
  });
});

describe('logResultCount', () => {
  test('prints found count', () => {
    const { logger, logs } = createTestLogger();
    logResultCount(logger, 5, 'process definition(s)', true);
    assert.strictEqual(logs.length, 1);
    assert.ok(logs[0].includes('Found 5 process definition(s)'));
  });

  test('warns about API default page size when count equals 100 and no filters', () => {
    const { logger, logs, errors } = createTestLogger();
    logResultCount(logger, 100, 'process definition(s)', false);
    assert.strictEqual(logs.length, 1);
    assert.strictEqual(errors.length, 1);
    assert.ok(errors[0].includes('API default page size'));
    assert.ok(errors[0].includes('add filters'));
  });

  test('warns about page size when count equals 100 with filters', () => {
    const { logger, logs, errors } = createTestLogger();
    logResultCount(logger, 100, 'process instance(s)', true);
    assert.strictEqual(logs.length, 1);
    assert.strictEqual(errors.length, 1);
    assert.ok(errors[0].includes('There may be more results'));
  });

  test('no warning when count is below 100', () => {
    const { logger, logs, errors } = createTestLogger();
    logResultCount(logger, 42, 'incidents', false);
    assert.strictEqual(logs.length, 1);
    assert.strictEqual(errors.length, 0);
  });

  test('no warning when count is above 100', () => {
    const { logger, logs, errors } = createTestLogger();
    logResultCount(logger, 150, 'variables', true);
    assert.strictEqual(logs.length, 1);
    assert.strictEqual(errors.length, 0);
  });
});
