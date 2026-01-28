/**
 * Unit tests for c8ctl runtime object
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { c8ctl } from '../../src/runtime.ts';

describe('c8ctl Runtime', () => {
  test('should have env property', () => {
    assert.ok(c8ctl.env, 'c8ctl.env exists');
  });

  test('env should contain version', () => {
    assert.ok(typeof c8ctl.env.version === 'string', 'version is a string');
  });

  test('env should contain nodeVersion', () => {
    assert.ok(c8ctl.env.nodeVersion, 'nodeVersion exists');
    assert.ok(c8ctl.env.nodeVersion.startsWith('v'), 'nodeVersion starts with v');
  });

  test('env should contain platform', () => {
    assert.ok(c8ctl.env.platform, 'platform exists');
    assert.ok(['darwin', 'linux', 'win32'].includes(c8ctl.env.platform), 'platform is valid');
  });

  test('env should contain arch', () => {
    assert.ok(c8ctl.env.arch, 'arch exists');
  });

  test('env should contain cwd', () => {
    assert.ok(c8ctl.env.cwd, 'cwd exists');
    assert.strictEqual(c8ctl.env.cwd, process.cwd(), 'cwd matches process.cwd()');
  });

  test('env should contain rootDir', () => {
    assert.ok(c8ctl.env.rootDir, 'rootDir exists');
  });
});
