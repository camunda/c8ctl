/**
 * Unit tests for wildcard/like filter support in search commands
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { toStringFilter, wildcardToRegex, matchesCaseInsensitive, hasUnescapedWildcard } from '../../src/commands/search.ts';

describe('toStringFilter — wildcard detection', () => {
  test('plain string returns the string as-is', () => {
    assert.strictEqual(toStringFilter('hello'), 'hello');
  });

  test('empty string returns empty string', () => {
    assert.strictEqual(toStringFilter(''), '');
  });

  test('string with * returns $like filter', () => {
    assert.deepStrictEqual(toStringFilter('*main*'), { $like: '*main*' });
  });

  test('string with ? returns $like filter', () => {
    assert.deepStrictEqual(toStringFilter('test?'), { $like: 'test?' });
  });

  test('string with both * and ? returns $like filter', () => {
    assert.deepStrictEqual(toStringFilter('*foo?bar*'), { $like: '*foo?bar*' });
  });

  test('leading wildcard returns $like filter', () => {
    assert.deepStrictEqual(toStringFilter('*suffix'), { $like: '*suffix' });
  });

  test('trailing wildcard returns $like filter', () => {
    assert.deepStrictEqual(toStringFilter('prefix*'), { $like: 'prefix*' });
  });

  test('wildcard in the middle returns $like filter', () => {
    assert.deepStrictEqual(toStringFilter('pre*fix'), { $like: 'pre*fix' });
  });

  test('escaped wildcard \\* does NOT trigger $like', () => {
    assert.strictEqual(toStringFilter('no\\*wildcard'), 'no\\*wildcard');
  });

  test('escaped \\? does NOT trigger $like', () => {
    assert.strictEqual(toStringFilter('literal\\?mark'), 'literal\\?mark');
  });

  test('mixed escaped and unescaped wildcards triggers $like', () => {
    assert.deepStrictEqual(toStringFilter('\\*real*match'), { $like: '\\*real*match' });
  });

  test('only escaped wildcards returns plain string', () => {
    assert.strictEqual(toStringFilter('all\\*escaped\\?here'), 'all\\*escaped\\?here');
  });

  test('realistic process definition name wildcard', () => {
    assert.deepStrictEqual(toStringFilter('*order*'), { $like: '*order*' });
  });

  test('single character wildcard for pattern matching', () => {
    assert.deepStrictEqual(toStringFilter('process-v?.bpmn'), { $like: 'process-v?.bpmn' });
  });
});

describe('wildcardToRegex — pattern conversion', () => {
  test('plain string produces exact case-insensitive regex', () => {
    const regex = wildcardToRegex('hello');
    assert.ok(regex.test('hello'));
    assert.ok(regex.test('HELLO'));
    assert.ok(regex.test('Hello'));
    assert.ok(!regex.test('hello!'));
    assert.ok(!regex.test('xhello'));
  });

  test('* matches zero or more characters', () => {
    const regex = wildcardToRegex('*order*');
    assert.ok(regex.test('order'));
    assert.ok(regex.test('ORDER'));
    assert.ok(regex.test('my-order-process'));
    assert.ok(regex.test('Order'));
    assert.ok(!regex.test('orbiter'));
  });

  test('? matches exactly one character', () => {
    const regex = wildcardToRegex('test?');
    assert.ok(regex.test('testA'));
    assert.ok(regex.test('test1'));
    assert.ok(!regex.test('test'));
    assert.ok(!regex.test('testAB'));
  });

  test('escaped \\* is treated as literal asterisk', () => {
    const regex = wildcardToRegex('no\\*wildcard');
    assert.ok(regex.test('no*wildcard'));
    assert.ok(regex.test('NO*WILDCARD'));
    assert.ok(!regex.test('noxwildcard'));
  });

  test('escaped \\? is treated as literal question mark', () => {
    const regex = wildcardToRegex('really\\?');
    assert.ok(regex.test('really?'));
    assert.ok(regex.test('REALLY?'));
    assert.ok(!regex.test('reallyx'));
  });

  test('regex special characters are escaped', () => {
    const regex = wildcardToRegex('my.process+v1');
    assert.ok(regex.test('my.process+v1'));
    assert.ok(!regex.test('myXprocessXv1'));
  });

  test('complex mixed pattern', () => {
    const regex = wildcardToRegex('*-v?.bpmn');
    assert.ok(regex.test('process-v1.bpmn'));
    assert.ok(regex.test('PROCESS-V2.BPMN'));
    assert.ok(!regex.test('process-v12.bpmn'));
  });
});

describe('matchesCaseInsensitive — value matching', () => {
  test('exact match ignoring case', () => {
    assert.ok(matchesCaseInsensitive('OrderProcess', 'orderprocess'));
    assert.ok(matchesCaseInsensitive('OrderProcess', 'ORDERPROCESS'));
    assert.ok(matchesCaseInsensitive('OrderProcess', 'OrderProcess'));
  });

  test('wildcard match ignoring case', () => {
    assert.ok(matchesCaseInsensitive('my-order-process', '*ORDER*'));
    assert.ok(matchesCaseInsensitive('OrderService', 'order*'));
    assert.ok(matchesCaseInsensitive('bigOrder', '*order'));
  });

  test('returns false for null or undefined', () => {
    assert.ok(!matchesCaseInsensitive(null, 'test'));
    assert.ok(!matchesCaseInsensitive(undefined, 'test'));
  });

  test('returns false when pattern does not match', () => {
    assert.ok(!matchesCaseInsensitive('OrderProcess', 'payment*'));
    assert.ok(!matchesCaseInsensitive('hello', 'world'));
  });

  test('empty pattern matches empty value', () => {
    assert.ok(matchesCaseInsensitive('', ''));
  });

  test('empty pattern does not match non-empty value', () => {
    assert.ok(!matchesCaseInsensitive('hello', ''));
  });
});

describe('hasUnescapedWildcard — raw wildcard detection', () => {
  test('returns false for plain string', () => {
    assert.strictEqual(hasUnescapedWildcard('hello'), false);
  });

  test('returns false for empty string', () => {
    assert.strictEqual(hasUnescapedWildcard(''), false);
  });

  test('returns true for unescaped *', () => {
    assert.strictEqual(hasUnescapedWildcard('foo*bar'), true);
  });

  test('returns true for unescaped ?', () => {
    assert.strictEqual(hasUnescapedWildcard('foo?bar'), true);
  });

  test('returns true for leading *', () => {
    assert.strictEqual(hasUnescapedWildcard('*prefix'), true);
  });

  test('returns true for trailing ?', () => {
    assert.strictEqual(hasUnescapedWildcard('suffix?'), true);
  });

  test('returns true for standalone *', () => {
    assert.strictEqual(hasUnescapedWildcard('*'), true);
  });

  test('returns true for standalone ?', () => {
    assert.strictEqual(hasUnescapedWildcard('?'), true);
  });

  test('returns false for escaped \\*', () => {
    assert.strictEqual(hasUnescapedWildcard('no\\*wildcard'), false);
  });

  test('returns false for escaped \\?', () => {
    assert.strictEqual(hasUnescapedWildcard('literal\\?mark'), false);
  });

  test('returns false when all wildcards are escaped', () => {
    assert.strictEqual(hasUnescapedWildcard('all\\*escaped\\?here'), false);
  });

  test('returns true for mixed escaped and unescaped', () => {
    assert.strictEqual(hasUnescapedWildcard('\\*real*match'), true);
  });

  test('returns true for both * and ?', () => {
    assert.strictEqual(hasUnescapedWildcard('*foo?bar'), true);
  });

  test('returns true for multiple consecutive wildcards', () => {
    assert.strictEqual(hasUnescapedWildcard('**??'), true);
  });
});
