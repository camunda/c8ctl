/**
 * Unit tests for src/command-framework.ts
 *
 * Tests the command definition framework:
 * - deserializeFlags: runtime deserialization of raw CLI values
 * - InferFlags: type-level inference (compile-time, verified by assignment tests)
 * - defineCommand: builder preserves type inference
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  deserializeFlags,
  defineCommand,
  type InferFlags,
  type CommandContext,
} from '../../src/command-framework.ts';
import type { FlagDef } from '../../src/command-registry.ts';
import {
  ProcessDefinitionKey,
  ProcessInstanceKey,
} from '@camunda8/orchestration-cluster-api';

// ─── Test flag schemas ───────────────────────────────────────────────────────

const STRING_FLAGS = {
  name: { type: 'string', description: 'A name' },
  email: { type: 'string', description: 'An email' },
} as const satisfies Record<string, FlagDef>;

const BOOLEAN_FLAGS = {
  verbose: { type: 'boolean', description: 'Verbose output' },
  force: { type: 'boolean', description: 'Force action' },
} as const satisfies Record<string, FlagDef>;

const VALIDATED_FLAGS = {
  processDefinitionKey: {
    type: 'string',
    description: 'PD key',
    validate: ProcessDefinitionKey.assumeExists,
  },
  processInstanceKey: {
    type: 'string',
    description: 'PI key',
    validate: ProcessInstanceKey.assumeExists,
  },
} as const satisfies Record<string, FlagDef>;

const MIXED_FLAGS = {
  name: { type: 'string', description: 'Name' },
  verbose: { type: 'boolean', description: 'Verbose' },
  processDefinitionKey: {
    type: 'string',
    description: 'PD key',
    validate: ProcessDefinitionKey.assumeExists,
  },
} as const satisfies Record<string, FlagDef>;

// ═══════════════════════════════════════════════════════════════════════════════
//  deserializeFlags — runtime behaviour
// ═══════════════════════════════════════════════════════════════════════════════

describe('deserializeFlags', () => {

  // ─── String flags ────────────────────────────────────────────────────────

  test('extracts string values', () => {
    const result = deserializeFlags({ name: 'Alice', email: 'a@b.com' }, STRING_FLAGS);
    assert.strictEqual(result.name, 'Alice');
    assert.strictEqual(result.email, 'a@b.com');
  });

  test('undefined for missing string flags', () => {
    const result = deserializeFlags({}, STRING_FLAGS);
    assert.strictEqual(result.name, undefined);
    assert.strictEqual(result.email, undefined);
  });

  test('undefined for non-string values in string flags', () => {
    const result = deserializeFlags({ name: 42, email: true }, STRING_FLAGS);
    assert.strictEqual(result.name, undefined);
    assert.strictEqual(result.email, undefined);
  });

  // ─── Boolean flags ───────────────────────────────────────────────────────

  test('extracts boolean values', () => {
    const result = deserializeFlags({ verbose: true, force: false }, BOOLEAN_FLAGS);
    assert.strictEqual(result.verbose, true);
    // false is treated as "not set" (same as CLI convention)
    assert.strictEqual(result.force, undefined);
  });

  test('undefined for missing boolean flags', () => {
    const result = deserializeFlags({}, BOOLEAN_FLAGS);
    assert.strictEqual(result.verbose, undefined);
    assert.strictEqual(result.force, undefined);
  });

  // ─── Validated flags ─────────────────────────────────────────────────────

  test('calls validator for string values', () => {
    const result = deserializeFlags(
      { processDefinitionKey: '12345', processInstanceKey: '67890' },
      VALIDATED_FLAGS,
    );
    assert.strictEqual(result.processDefinitionKey, '12345');
    assert.strictEqual(result.processInstanceKey, '67890');
  });

  test('undefined for missing validated flags', () => {
    const result = deserializeFlags({}, VALIDATED_FLAGS);
    assert.strictEqual(result.processDefinitionKey, undefined);
    assert.strictEqual(result.processInstanceKey, undefined);
  });

  test('skips validator for empty string', () => {
    const result = deserializeFlags(
      { processDefinitionKey: '' },
      VALIDATED_FLAGS,
    );
    assert.strictEqual(result.processDefinitionKey, undefined);
  });

  test('skips validator for undefined', () => {
    const result = deserializeFlags(
      { processDefinitionKey: undefined },
      VALIDATED_FLAGS,
    );
    assert.strictEqual(result.processDefinitionKey, undefined);
  });

  // ─── Mixed flags ─────────────────────────────────────────────────────────

  test('handles mixed flag types in one schema', () => {
    const result = deserializeFlags(
      { name: 'Alice', verbose: true, processDefinitionKey: '999' },
      MIXED_FLAGS,
    );
    assert.strictEqual(result.name, 'Alice');
    assert.strictEqual(result.verbose, true);
    assert.strictEqual(result.processDefinitionKey, '999');
  });

  test('ignores values not in schema', () => {
    const result = deserializeFlags(
      { name: 'Alice', bogus: 'ignored' },
      STRING_FLAGS,
    );
    assert.strictEqual(result.name, 'Alice');
    // bogus is not in the result because it's not in the schema
    assert.strictEqual((result as Record<string, unknown>).bogus, undefined);
  });

  test('only includes keys from schema', () => {
    const result = deserializeFlags(
      { name: 'Alice', extra1: 'x', extra2: 'y' },
      STRING_FLAGS,
    );
    const keys = Object.keys(result);
    assert.deepStrictEqual(keys.sort(), ['email', 'name']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  InferFlags — compile-time type verification
// ═══════════════════════════════════════════════════════════════════════════════

describe('InferFlags — type inference (compile-time)', () => {

  test('string flags infer to string | undefined', () => {
    // This test verifies at compile time that the types are correct.
    // If InferFlags is wrong, this file won't compile.
    type Result = InferFlags<typeof STRING_FLAGS>;
    const _check: Result = { name: 'Alice', email: undefined };
    assert.ok(true, 'compiles');
  });

  test('boolean flags infer to boolean | undefined', () => {
    type Result = InferFlags<typeof BOOLEAN_FLAGS>;
    const _check: Result = { verbose: true, force: undefined };
    assert.ok(true, 'compiles');
  });

  test('validated flags infer to branded type | undefined', () => {
    type Result = InferFlags<typeof VALIDATED_FLAGS>;
    // ProcessDefinitionKey.assumeExists returns ProcessDefinitionKey
    const pdKey = ProcessDefinitionKey.assumeExists('123');
    const piKey = ProcessInstanceKey.assumeExists('456');
    const _check: Result = {
      processDefinitionKey: pdKey,
      processInstanceKey: piKey,
    };
    assert.ok(true, 'compiles');
  });

  test('mixed flags preserve distinct types per key', () => {
    type Result = InferFlags<typeof MIXED_FLAGS>;
    const pdKey = ProcessDefinitionKey.assumeExists('999');
    const _check: Result = {
      name: 'Alice',
      verbose: true,
      processDefinitionKey: pdKey,
    };
    assert.ok(true, 'compiles');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  defineCommand — builder type inference
// ═══════════════════════════════════════════════════════════════════════════════

describe('defineCommand', () => {

  test('returns the definition unchanged', () => {
    const def = defineCommand({
      verb: 'test',
      resources: ['res'],
      flags: STRING_FLAGS,
      handler: async (_ctx, _flags) => {},
    });
    assert.strictEqual(def.verb, 'test');
    assert.deepStrictEqual(def.resources, ['res']);
    assert.strictEqual(def.flags, STRING_FLAGS);
  });

  test('handler receives inferred flag types (compile-time check)', () => {
    // This test verifies that the handler parameter type is correctly
    // inferred from the flags schema. If wrong, this won't compile.
    defineCommand({
      verb: 'search',
      resources: ['pi'],
      flags: MIXED_FLAGS,
      handler: async (_ctx, flags) => {
        // These assignments verify the inferred types at compile time
        const _name: string | undefined = flags.name;
        const _verbose: boolean | undefined = flags.verbose;
        const _pdKey: ReturnType<typeof ProcessDefinitionKey.assumeExists> | undefined =
          flags.processDefinitionKey;
        // Suppress unused warnings
        void _name;
        void _verbose;
        void _pdKey;
      },
    });
    assert.ok(true, 'compiles with correct types');
  });

  test('handler receives CommandContext', () => {
    defineCommand({
      verb: 'get',
      resources: ['pd'],
      flags: STRING_FLAGS,
      handler: async (ctx, _flags) => {
        // Verify context shape at compile time
        const _logger = ctx.logger;
        const _resource: string = ctx.resource;
        const _positionals: string[] = ctx.positionals;
        const _dryRun: boolean = ctx.dryRun;
        void _logger;
        void _resource;
        void _positionals;
        void _dryRun;
      },
    });
    assert.ok(true, 'compiles with CommandContext');
  });
});
