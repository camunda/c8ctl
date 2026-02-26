/**
 * Unit tests for process-instances commands
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';

describe('Process Instances Table Formatting', () => {
  /**
   * The table row mapping used in listProcessInstances.
   * Mirrors the logic in src/commands/process-instances.ts.
   */
  const formatRow = (pi: any) => ({
    Key: `${pi.hasIncident ? '⚠ ' : ''}${pi.processInstanceKey || pi.key}`,
    'Process ID': pi.processDefinitionId,
    State: pi.state,
    Version: pi.processDefinitionVersion || pi.version,
    'Start Date': pi.startDate || '-',
    'Tenant ID': pi.tenantId,
  });

  test('Key shows ⚠ prefix when hasIncident is true', () => {
    const row = formatRow({
      processInstanceKey: '123456789',
      hasIncident: true,
      processDefinitionId: 'my-process',
      state: 'ACTIVE',
    });
    assert.ok(row.Key.startsWith('⚠ '), 'Key should start with ⚠ when hasIncident is true');
    assert.ok(row.Key.includes('123456789'), 'Key should include the process instance key');
    assert.strictEqual(row.Key, '⚠ 123456789');
  });

  test('Key has no prefix when hasIncident is false', () => {
    const row = formatRow({
      processInstanceKey: '987654321',
      hasIncident: false,
      processDefinitionId: 'my-process',
      state: 'ACTIVE',
    });
    assert.ok(!row.Key.includes('⚠'), 'Key should not include ⚠ when hasIncident is false');
    assert.strictEqual(row.Key, '987654321');
  });

  test('Key has no prefix when hasIncident is undefined', () => {
    const row = formatRow({
      processInstanceKey: '111222333',
      processDefinitionId: 'my-process',
      state: 'COMPLETED',
    });
    assert.ok(!row.Key.includes('⚠'), 'Key should not include ⚠ when hasIncident is undefined');
    assert.strictEqual(row.Key, '111222333');
  });

  test('Key falls back to pi.key when processInstanceKey is absent', () => {
    const row = formatRow({
      key: '444555666',
      hasIncident: true,
      processDefinitionId: 'fallback-process',
      state: 'ACTIVE',
    });
    assert.strictEqual(row.Key, '⚠ 444555666');
  });
});
