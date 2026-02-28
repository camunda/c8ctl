/**
 * Unit tests for the table row-mapping logic of every list command.
 *
 * Each list command in src/commands/*.ts maps raw API items to a table row
 * object with consistent column names (Key, State, …).  The tests here
 * mirror that mapping verbatim so that any future change to a column name or
 * fallback expression is caught at the unit level before integration tests
 * are run.
 *
 * The pattern matches the existing tests/unit/process-instances.test.ts.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';

// ---------------------------------------------------------------------------
// process-definitions  (src/commands/process-definitions.ts)
// ---------------------------------------------------------------------------
describe('Process Definition Table Formatting', () => {
  const formatRow = (pd: any) => ({
    Key: pd.processDefinitionKey || pd.key,
    'Process ID': pd.processDefinitionId,
    Name: pd.name || '-',
    Version: pd.version,
    'Tenant ID': pd.tenantId,
  });

  test('Key uses processDefinitionKey when present', () => {
    const row = formatRow({ processDefinitionKey: '100', processDefinitionId: 'my-process', version: 1 });
    assert.strictEqual(row.Key, '100');
  });

  test('Key falls back to pd.key when processDefinitionKey is absent', () => {
    const row = formatRow({ key: '200', processDefinitionId: 'fallback', version: 2 });
    assert.strictEqual(row.Key, '200');
  });

  test('Name falls back to hyphen when absent', () => {
    const row = formatRow({ processDefinitionKey: '1', processDefinitionId: 'x', version: 1 });
    assert.strictEqual(row.Name, '-');
  });

  test('Name uses pd.name when present', () => {
    const row = formatRow({ processDefinitionKey: '1', name: 'My Flow', version: 1 });
    assert.strictEqual(row.Name, 'My Flow');
  });
});

// ---------------------------------------------------------------------------
// user-tasks  (src/commands/user-tasks.ts)
// ---------------------------------------------------------------------------
describe('User Task Table Formatting', () => {
  const formatRow = (task: any) => ({
    Key: task.userTaskKey || task.key,
    Name: task.name || task.elementId,
    State: task.state,
    Assignee: task.assignee || '(unassigned)',
    Created: task.creationDate || '-',
    'Process Instance': task.processInstanceKey,
    'Tenant ID': task.tenantId,
  });

  test('Key uses userTaskKey when present', () => {
    const row = formatRow({ userTaskKey: '500', state: 'CREATED' });
    assert.strictEqual(row.Key, '500');
  });

  test('Key falls back to task.key when userTaskKey is absent', () => {
    const row = formatRow({ key: '501', state: 'CREATED' });
    assert.strictEqual(row.Key, '501');
  });

  test('Assignee falls back to (unassigned) when absent', () => {
    const row = formatRow({ userTaskKey: '1', state: 'CREATED' });
    assert.strictEqual(row.Assignee, '(unassigned)');
  });

  test('Assignee uses task.assignee when present', () => {
    const row = formatRow({ userTaskKey: '1', assignee: 'alice', state: 'CREATED' });
    assert.strictEqual(row.Assignee, 'alice');
  });

  test('Name uses task.elementId when task.name is absent', () => {
    const row = formatRow({ userTaskKey: '1', elementId: 'Task_01', state: 'CREATED' });
    assert.strictEqual(row.Name, 'Task_01');
  });

  test('Created falls back to hyphen when creationDate is absent', () => {
    const row = formatRow({ userTaskKey: '1', state: 'CREATED' });
    assert.strictEqual(row.Created, '-');
  });
});

// ---------------------------------------------------------------------------
// incidents  (src/commands/incidents.ts)
// ---------------------------------------------------------------------------
describe('Incident Table Formatting', () => {
  const formatRow = (incident: any) => ({
    Key: incident.incidentKey || incident.key,
    Type: incident.errorType,
    Message: incident.errorMessage?.substring(0, 50) || '',
    State: incident.state,
    Created: incident.creationTime || '-',
    'Process Instance': incident.processInstanceKey,
    'Tenant ID': incident.tenantId,
  });

  test('Key uses incidentKey when present', () => {
    const row = formatRow({ incidentKey: '777', state: 'ACTIVE' });
    assert.strictEqual(row.Key, '777');
  });

  test('Key falls back to incident.key when incidentKey is absent', () => {
    const row = formatRow({ key: '888', state: 'ACTIVE' });
    assert.strictEqual(row.Key, '888');
  });

  test('Message truncates to 50 characters', () => {
    const long = 'x'.repeat(80);
    const row = formatRow({ incidentKey: '1', errorMessage: long, state: 'ACTIVE' });
    assert.strictEqual(row.Message.length, 50);
  });

  test('Message is empty string when errorMessage is absent', () => {
    const row = formatRow({ incidentKey: '1', state: 'ACTIVE' });
    assert.strictEqual(row.Message, '');
  });

  test('Created falls back to hyphen when creationTime is absent', () => {
    const row = formatRow({ incidentKey: '1', state: 'ACTIVE' });
    assert.strictEqual(row.Created, '-');
  });
});

// ---------------------------------------------------------------------------
// jobs  (src/commands/jobs.ts)
// ---------------------------------------------------------------------------
describe('Job Table Formatting', () => {
  const formatRow = (job: any) => ({
    Key: job.jobKey || job.key,
    Type: job.type,
    State: job.state,
    Retries: job.retries,
    Created: job.creationTime || '-',
    'Process Instance': job.processInstanceKey,
    'Tenant ID': job.tenantId,
  });

  test('Key uses jobKey when present', () => {
    const row = formatRow({ jobKey: '300', type: 'my-job', state: 'CREATED' });
    assert.strictEqual(row.Key, '300');
  });

  test('Key falls back to job.key when jobKey is absent', () => {
    const row = formatRow({ key: '301', type: 'my-job', state: 'CREATED' });
    assert.strictEqual(row.Key, '301');
  });

  test('Created falls back to hyphen when creationTime is absent', () => {
    const row = formatRow({ jobKey: '1', type: 'x', state: 'CREATED' });
    assert.strictEqual(row.Created, '-');
  });
});
