/**
 * Unit tests asserting --id works as an alias for --bpmnProcessId in c8 search
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { parseArgs } from 'node:util';

/**
 * Mirrors the relevant subset of the parseArgs config from src/index.ts.
 * Note: src/index.ts cannot be imported directly because it runs main() on import.
 */
function parseSearchArgs(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      bpmnProcessId: { type: 'string' },
      id: { type: 'string' },
      processDefinitionId: { type: 'string' },
      iid: { type: 'string' },
    },
    allowPositionals: true,
    strict: false,
  });
  return values;
}

// Mirrors resolveProcessDefinitionId from src/index.ts
function resolveProcessDefinitionId(parsedArgs: Record<string, unknown>): string | undefined {
  return (parsedArgs.id || parsedArgs.processDefinitionId || parsedArgs.bpmnProcessId) as string | undefined;
}

describe('--id alias for --bpmnProcessId in c8 search', () => {
  test('--id resolves to processDefinitionId', () => {
    const parsedArgs = parseSearchArgs(['search', 'pd', '--id=order-process']);
    assert.strictEqual(resolveProcessDefinitionId(parsedArgs), 'order-process');
  });

  test('--bpmnProcessId resolves to processDefinitionId', () => {
    const parsedArgs = parseSearchArgs(['search', 'pd', '--bpmnProcessId=order-process']);
    assert.strictEqual(resolveProcessDefinitionId(parsedArgs), 'order-process');
  });

  test('--id and --bpmnProcessId resolve to the same value', () => {
    const argsWithId = parseSearchArgs(['search', 'pi', '--id=my-process']);
    const argsWithBpmnId = parseSearchArgs(['search', 'pi', '--bpmnProcessId=my-process']);
    assert.strictEqual(resolveProcessDefinitionId(argsWithId), resolveProcessDefinitionId(argsWithBpmnId));
  });

  test('--id works for search pi (process instances)', () => {
    const parsedArgs = parseSearchArgs(['search', 'pi', '--id=shipping-process', '--state=ACTIVE']);
    assert.strictEqual(resolveProcessDefinitionId(parsedArgs), 'shipping-process');
  });

  test('--id works for search inc (incidents)', () => {
    const parsedArgs = parseSearchArgs(['search', 'inc', '--id=payment-process']);
    assert.strictEqual(resolveProcessDefinitionId(parsedArgs), 'payment-process');
  });

  test('--id takes precedence over --bpmnProcessId when both provided', () => {
    const parsedArgs = parseSearchArgs(['search', 'pd', '--id=first', '--bpmnProcessId=second']);
    assert.strictEqual(resolveProcessDefinitionId(parsedArgs), 'first');
  });

  test('--iid parses independently as case-insensitive id filter', () => {
    const parsedArgs = parseSearchArgs(['search', 'pd', '--iid=ORDER-PROCESS']);
    assert.strictEqual(parsedArgs.iid, 'ORDER-PROCESS');
    assert.strictEqual(resolveProcessDefinitionId(parsedArgs), undefined);
  });
});
