/**
 * Unit tests for date-filter utilities
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { parseBetween, buildDateFilter } from '../../src/date-filter.ts';

describe('parseBetween', () => {
  test('parses full ISO 8601 datetime range', () => {
    const result = parseBetween('2024-01-01T00:00:00Z..2024-12-31T23:59:59Z');
    assert.ok(result);
    assert.strictEqual(result.from, '2024-01-01T00:00:00Z');
    assert.strictEqual(result.to, '2024-12-31T23:59:59Z');
  });

  test('expands short date from to start of day', () => {
    const result = parseBetween('2024-01-01..2024-03-31');
    assert.ok(result);
    assert.strictEqual(result.from, '2024-01-01T00:00:00.000Z');
    assert.strictEqual(result.to, '2024-03-31T23:59:59.999Z');
  });

  test('expands mixed short and full datetime', () => {
    const result = parseBetween('2024-01-01..2024-03-31T12:00:00Z');
    assert.ok(result);
    assert.strictEqual(result.from, '2024-01-01T00:00:00.000Z');
    assert.strictEqual(result.to, '2024-03-31T12:00:00Z');
  });

  test('returns null when separator is missing', () => {
    const result = parseBetween('2024-01-01 2024-12-31');
    assert.strictEqual(result, null);
  });

  test('returns null when from part is empty', () => {
    const result = parseBetween('..2024-12-31');
    assert.strictEqual(result, null);
  });

  test('returns null when to part is empty', () => {
    const result = parseBetween('2024-01-01..');
    assert.strictEqual(result, null);
  });

  test('returns null for invalid date strings', () => {
    const result = parseBetween('not-a-date..2024-12-31');
    assert.strictEqual(result, null);
  });

  test('returns null for invalid ISO datetime', () => {
    const result = parseBetween('2024-13-01T00:00:00Z..2024-12-31T23:59:59Z');
    assert.strictEqual(result, null);
  });

  test('handles whitespace around separator', () => {
    const result = parseBetween('2024-01-01 .. 2024-12-31');
    assert.ok(result);
    assert.strictEqual(result.from, '2024-01-01T00:00:00.000Z');
    assert.strictEqual(result.to, '2024-12-31T23:59:59.999Z');
  });
});

describe('buildDateFilter', () => {
  test('builds $gte/$lte filter object', () => {
    const filter = buildDateFilter('2024-01-01T00:00:00Z', '2024-12-31T23:59:59Z');
    assert.deepStrictEqual(filter, {
      $gte: '2024-01-01T00:00:00Z',
      $lte: '2024-12-31T23:59:59Z',
    });
  });
});
