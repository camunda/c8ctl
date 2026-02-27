/**
 * Unit tests for search feedback improvements:
 * - Unknown flag detection
 * - Empty result messaging with 🕳️
 * - Truncation warnings
 * - No-filter hints
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  detectUnknownSearchFlags,
  GLOBAL_FLAGS,
  SEARCH_RESOURCE_FLAGS,
} from '../../src/commands/search.ts';

describe('detectUnknownSearchFlags', () => {
  test('returns empty array when no flags are set', () => {
    const values = {};
    assert.deepStrictEqual(detectUnknownSearchFlags(values, 'process-definition'), []);
  });

  test('returns empty array when only global flags are set', () => {
    const values = { profile: 'dev', sortBy: 'Name', asc: true };
    assert.deepStrictEqual(detectUnknownSearchFlags(values, 'process-definition'), []);
  });

  test('returns empty array when valid resource flags are set', () => {
    const values = { bpmnProcessId: 'my-process', name: 'My Process' };
    assert.deepStrictEqual(detectUnknownSearchFlags(values, 'process-definition'), []);
  });

  test('detects unknown flag for process-definitions', () => {
    const values = { assignee: 'john', name: 'My Process' };
    const unknown = detectUnknownSearchFlags(values, 'process-definition');
    assert.deepStrictEqual(unknown, ['assignee']);
  });

  test('detects unknown flag for user-tasks', () => {
    const values = { name: 'test', state: 'CREATED' };
    const unknown = detectUnknownSearchFlags(values, 'user-task');
    assert.deepStrictEqual(unknown, ['name']);
  });

  test('detects unknown flag for jobs', () => {
    const values = { assignee: 'john', type: 'email' };
    const unknown = detectUnknownSearchFlags(values, 'jobs');
    assert.deepStrictEqual(unknown, ['assignee']);
  });

  test('detects unknown flag for variables', () => {
    const values = { type: 'some-type', name: 'myVar' };
    const unknown = detectUnknownSearchFlags(values, 'variable');
    assert.deepStrictEqual(unknown, ['type']);
  });

  test('detects unknown flag for incidents', () => {
    const values = { assignee: 'john', state: 'ACTIVE' };
    const unknown = detectUnknownSearchFlags(values, 'incident');
    assert.deepStrictEqual(unknown, ['assignee']);
  });

  test('ignores undefined and false values', () => {
    const values = { assignee: undefined, errorType: false, state: 'ACTIVE' };
    const unknown = detectUnknownSearchFlags(values, 'jobs');
    assert.deepStrictEqual(unknown, []);
  });

  test('detects multiple unknown flags at once', () => {
    const values = { assignee: 'john', errorType: 'IO', type: 'email' };
    const unknown = detectUnknownSearchFlags(values, 'jobs');
    // assignee and errorType are not valid for jobs
    assert.ok(unknown.includes('assignee'));
    assert.ok(unknown.includes('errorType'));
    assert.strictEqual(unknown.length, 2);
  });

  test('handles pluralized resource names (process-definitions → process-definition)', () => {
    const values = { name: 'test' };
    // 'process-definitions' is not a key; the function strips trailing 's' as fallback
    const unknown = detectUnknownSearchFlags(values, 'process-definitions');
    assert.deepStrictEqual(unknown, []);
  });

  test('handles variables (pluralized → variable)', () => {
    const values = { name: 'myVar', value: 'hello' };
    const unknown = detectUnknownSearchFlags(values, 'variables');
    assert.deepStrictEqual(unknown, []);
  });

  test('--id is valid for process-definition search', () => {
    const values = { id: 'my-process' };
    const unknown = detectUnknownSearchFlags(values, 'process-definition');
    assert.deepStrictEqual(unknown, []);
  });

  test('--processDefinitionId is valid for process-definition search', () => {
    const values = { processDefinitionId: 'my-process' };
    const unknown = detectUnknownSearchFlags(values, 'process-definition');
    assert.deepStrictEqual(unknown, []);
  });

  test('--id is valid for process-instance search', () => {
    const values = { id: 'my-process' };
    const unknown = detectUnknownSearchFlags(values, 'process-instance');
    assert.deepStrictEqual(unknown, []);
  });

  test('--processDefinitionId is valid for incident search', () => {
    const values = { processDefinitionId: 'my-process' };
    const unknown = detectUnknownSearchFlags(values, 'incident');
    assert.deepStrictEqual(unknown, []);
  });

  test('returns empty array for unknown resource', () => {
    const values = { foo: 'bar' };
    assert.deepStrictEqual(detectUnknownSearchFlags(values, 'unknown-resource'), []);
  });

  test('truly unknown flags (not in any resource) are detected', () => {
    const values = { fooBarBaz: 'test' };
    const unknown = detectUnknownSearchFlags(values, 'process-definition');
    assert.deepStrictEqual(unknown, ['fooBarBaz']);
  });
});

describe('GLOBAL_FLAGS', () => {
  test('contains expected common flags', () => {
    assert.ok(GLOBAL_FLAGS.has('profile'));
    assert.ok(GLOBAL_FLAGS.has('sortBy'));
    assert.ok(GLOBAL_FLAGS.has('asc'));
    assert.ok(GLOBAL_FLAGS.has('desc'));
    assert.ok(GLOBAL_FLAGS.has('help'));
    assert.ok(GLOBAL_FLAGS.has('version'));
  });

  test('does not contain limit (limit is only valid for variable search)', () => {
    assert.ok(!GLOBAL_FLAGS.has('limit'));
  });
});

describe('SEARCH_RESOURCE_FLAGS', () => {
  test('process-definition includes all expected flags', () => {
    const flags = SEARCH_RESOURCE_FLAGS['process-definition'];
    assert.ok(flags.has('bpmnProcessId'));
    assert.ok(flags.has('id'));
    assert.ok(flags.has('processDefinitionId'));
    assert.ok(flags.has('name'));
    assert.ok(flags.has('key'));
    assert.ok(flags.has('iid'));
    assert.ok(flags.has('iname'));
  });

  test('process-instance includes all expected flags', () => {
    const flags = SEARCH_RESOURCE_FLAGS['process-instance'];
    assert.ok(flags.has('bpmnProcessId'));
    assert.ok(flags.has('id'));
    assert.ok(flags.has('processDefinitionId'));
    assert.ok(flags.has('processDefinitionKey'));
    assert.ok(flags.has('state'));
    assert.ok(flags.has('key'));
    assert.ok(flags.has('parentProcessInstanceKey'));
    assert.ok(flags.has('iid'));
  });

  test('user-task includes all expected flags', () => {
    const flags = SEARCH_RESOURCE_FLAGS['user-task'];
    assert.ok(flags.has('state'));
    assert.ok(flags.has('assignee'));
    assert.ok(flags.has('processInstanceKey'));
    assert.ok(flags.has('processDefinitionKey'));
    assert.ok(flags.has('elementId'));
    assert.ok(flags.has('iassignee'));
  });

  test('incident includes all expected flags', () => {
    const flags = SEARCH_RESOURCE_FLAGS['incident'];
    assert.ok(flags.has('state'));
    assert.ok(flags.has('processInstanceKey'));
    assert.ok(flags.has('processDefinitionKey'));
    assert.ok(flags.has('bpmnProcessId'));
    assert.ok(flags.has('id'));
    assert.ok(flags.has('processDefinitionId'));
    assert.ok(flags.has('errorType'));
    assert.ok(flags.has('errorMessage'));
    assert.ok(flags.has('ierrorMessage'));
    assert.ok(flags.has('iid'));
  });

  test('jobs includes all expected flags', () => {
    const flags = SEARCH_RESOURCE_FLAGS['jobs'];
    assert.ok(flags.has('state'));
    assert.ok(flags.has('type'));
    assert.ok(flags.has('processInstanceKey'));
    assert.ok(flags.has('processDefinitionKey'));
    assert.ok(flags.has('itype'));
  });

  test('variable includes all expected flags', () => {
    const flags = SEARCH_RESOURCE_FLAGS['variable'];
    assert.ok(flags.has('name'));
    assert.ok(flags.has('value'));
    assert.ok(flags.has('processInstanceKey'));
    assert.ok(flags.has('scopeKey'));
    assert.ok(flags.has('fullValue'));
    assert.ok(flags.has('iname'));
    assert.ok(flags.has('ivalue'));
    assert.ok(flags.has('limit'));
  });

  test('all resources have entries', () => {
    const resources = ['process-definition', 'process-instance', 'user-task', 'incident', 'jobs', 'variable'];
    for (const resource of resources) {
      assert.ok(SEARCH_RESOURCE_FLAGS[resource], `Missing entry for ${resource}`);
      assert.ok(SEARCH_RESOURCE_FLAGS[resource].size > 0, `Empty flags for ${resource}`);
    }
  });
});
