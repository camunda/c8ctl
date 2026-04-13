/**
 * Unit tests for src/command-validation.ts
 *
 * Tests the validation utilities directly to catch regressions in
 * the shared boundary-validation layer that all commands depend on.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { requireOption, requireEnum, requireCsvEnum, requirePositional, requireOneOf } from '../../src/command-validation.ts';

// A minimal enum-like object matching the SDK pattern
const ColorEnum = { RED: 'RED', GREEN: 'GREEN', BLUE: 'BLUE' } as const;
type ColorEnum = (typeof ColorEnum)[keyof typeof ColorEnum];

let errorSpy: string[];
let originalError: typeof console.error;
let originalExit: typeof process.exit;

function setup() {
  errorSpy = [];
  originalError = console.error;
  originalExit = process.exit;
  console.error = (...args: any[]) => errorSpy.push(args.join(' '));
  (process.exit as any) = (code: number) => { throw new Error(`process.exit(${code})`); };
}

function teardown() {
  console.error = originalError;
  process.exit = originalExit;
}

// ─── requireOption ───────────────────────────────────────────────────────────

describe('requireOption', () => {
  beforeEach(setup);
  afterEach(teardown);

  test('returns the value when present', () => {
    assert.strictEqual(requireOption('hello', 'name'), 'hello');
  });

  test('exits when value is undefined', () => {
    assert.throws(
      () => requireOption(undefined, 'name'),
      /process\.exit\(1\)/,
    );
    assert.ok(errorSpy.some(l => l.includes('--name is required')));
  });

  test('exits when value is empty string', () => {
    assert.throws(
      () => requireOption('', 'name'),
      /process\.exit\(1\)/,
    );
    assert.ok(errorSpy.some(l => l.includes('--name is required')));
  });
});

// ─── requireEnum ─────────────────────────────────────────────────────────────

describe('requireEnum', () => {
  beforeEach(setup);
  afterEach(teardown);

  test('returns the matched value for a valid enum member', () => {
    const result = requireEnum('RED', ColorEnum, 'color');
    assert.strictEqual(result, 'RED');
  });

  test('returns correctly typed value for each member', () => {
    assert.strictEqual(requireEnum('GREEN', ColorEnum, 'color'), 'GREEN');
    assert.strictEqual(requireEnum('BLUE', ColorEnum, 'color'), 'BLUE');
  });

  test('exits on invalid value with error listing valid values', () => {
    assert.throws(
      () => requireEnum('PURPLE', ColorEnum, 'color'),
      /process\.exit\(1\)/,
    );
    assert.ok(errorSpy.some(l => l.includes('Invalid --color "PURPLE"')));
    assert.ok(errorSpy.some(l => l.includes('RED')));
    assert.ok(errorSpy.some(l => l.includes('GREEN')));
    assert.ok(errorSpy.some(l => l.includes('BLUE')));
  });

  test('is case-sensitive', () => {
    assert.throws(
      () => requireEnum('red', ColorEnum, 'color'),
      /process\.exit\(1\)/,
    );
  });
});

// ─── requireCsvEnum ──────────────────────────────────────────────────────────

describe('requireCsvEnum', () => {
  beforeEach(setup);
  afterEach(teardown);

  test('returns array of matched values for valid CSV', () => {
    const result = requireCsvEnum('RED,GREEN', ColorEnum, 'colors');
    assert.deepStrictEqual(result, ['RED', 'GREEN']);
  });

  test('handles single value (no commas)', () => {
    const result = requireCsvEnum('BLUE', ColorEnum, 'colors');
    assert.deepStrictEqual(result, ['BLUE']);
  });

  test('trims whitespace around values', () => {
    const result = requireCsvEnum('RED , GREEN , BLUE', ColorEnum, 'colors');
    assert.deepStrictEqual(result, ['RED', 'GREEN', 'BLUE']);
  });

  test('filters empty strings from trailing commas', () => {
    const result = requireCsvEnum('RED,GREEN,', ColorEnum, 'colors');
    assert.deepStrictEqual(result, ['RED', 'GREEN']);
  });

  test('filters empty strings from leading commas', () => {
    const result = requireCsvEnum(',RED,GREEN', ColorEnum, 'colors');
    assert.deepStrictEqual(result, ['RED', 'GREEN']);
  });

  test('filters whitespace-only items', () => {
    const result = requireCsvEnum('RED, ,GREEN', ColorEnum, 'colors');
    assert.deepStrictEqual(result, ['RED', 'GREEN']);
  });

  test('exits on invalid value listing all invalid items', () => {
    assert.throws(
      () => requireCsvEnum('RED,PURPLE,YELLOW', ColorEnum, 'colors'),
      /process\.exit\(1\)/,
    );
    assert.ok(errorSpy.some(l => l.includes('Invalid --colors: PURPLE, YELLOW')));
    assert.ok(errorSpy.some(l => l.includes('Valid values:')));
  });

  test('exits when all values are invalid', () => {
    assert.throws(
      () => requireCsvEnum('PURPLE,YELLOW', ColorEnum, 'colors'),
      /process\.exit\(1\)/,
    );
    assert.ok(errorSpy.some(l => l.includes('PURPLE')));
    assert.ok(errorSpy.some(l => l.includes('YELLOW')));
  });
});

// ─── requirePositional ──────────────────────────────────────────────────────

describe('requirePositional', () => {
  beforeEach(setup);
  afterEach(teardown);

  test('returns the value when present', () => {
    assert.strictEqual(requirePositional('operate', 'Application'), 'operate');
  });

  test('exits when value is undefined', () => {
    assert.throws(
      () => requirePositional(undefined, 'Application'),
      /process\.exit\(1\)/,
    );
    assert.ok(errorSpy.some(l => l.includes('Application is required')));
  });

  test('exits when value is empty string', () => {
    assert.throws(
      () => requirePositional('', 'Application'),
      /process\.exit\(1\)/,
    );
    assert.ok(errorSpy.some(l => l.includes('Application is required')));
  });

  test('prints hint when provided', () => {
    const logSpy: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => { logSpy.push(args.join(' ')); };
    try {
      requirePositional(undefined, 'Application', 'Usage: c8 open <app>');
    } catch { /* expected */ }
    console.log = origLog;
    assert.ok(logSpy.some(l => l.includes('Usage: c8 open <app>')));
  });
});

// ─── requireOneOf ────────────────────────────────────────────────────────────

const FRUITS = ['apple', 'banana', 'cherry'] as const;

describe('requireOneOf', () => {
  beforeEach(setup);
  afterEach(teardown);

  test('returns matched value for a valid item', () => {
    assert.strictEqual(requireOneOf('apple', FRUITS, 'fruit'), 'apple');
    assert.strictEqual(requireOneOf('banana', FRUITS, 'fruit'), 'banana');
    assert.strictEqual(requireOneOf('cherry', FRUITS, 'fruit'), 'cherry');
  });

  test('exits on invalid value listing valid options', () => {
    assert.throws(
      () => requireOneOf('mango', FRUITS, 'fruit'),
      /process\.exit\(1\)/,
    );
    assert.ok(errorSpy.some(l => l.includes("Unknown fruit 'mango'")));
    assert.ok(errorSpy.some(l => l.includes('apple')));
    assert.ok(errorSpy.some(l => l.includes('banana')));
    assert.ok(errorSpy.some(l => l.includes('cherry')));
  });

  test('is case-sensitive', () => {
    assert.throws(
      () => requireOneOf('Apple', FRUITS, 'fruit'),
      /process\.exit\(1\)/,
    );
  });

  test('prints hint when provided', () => {
    const logSpy: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => { logSpy.push(args.join(' ')); };
    try {
      requireOneOf('mango', FRUITS, 'fruit', 'Usage: pick a fruit');
    } catch { /* expected */ }
    console.log = origLog;
    assert.ok(logSpy.some(l => l.includes('Usage: pick a fruit')));
  });
});
