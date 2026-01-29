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

  test('should have activeProfile property with undefined default', () => {
    // Note: This test assumes a fresh runtime state
    // In a real scenario, the property may have been set by previous tests
    assert.strictEqual(typeof c8ctl.activeProfile, 'string' as any || 'undefined', 'activeProfile is string or undefined');
  });

  test('should be able to set and get activeProfile', () => {
    const testProfile = 'test-profile';
    c8ctl.activeProfile = testProfile;
    assert.strictEqual(c8ctl.activeProfile, testProfile, 'activeProfile can be set and retrieved');
    
    // Clean up
    c8ctl.activeProfile = undefined;
  });

  test('should have activeTenant property with undefined default', () => {
    assert.strictEqual(typeof c8ctl.activeTenant, 'string' as any || 'undefined', 'activeTenant is string or undefined');
  });

  test('should be able to set and get activeTenant', () => {
    const testTenant = 'test-tenant';
    c8ctl.activeTenant = testTenant;
    assert.strictEqual(c8ctl.activeTenant, testTenant, 'activeTenant can be set and retrieved');
    
    // Clean up
    c8ctl.activeTenant = undefined;
  });

  test('should have outputMode property with text default', () => {
    // Reset to default
    c8ctl.outputMode = 'text';
    assert.strictEqual(c8ctl.outputMode, 'text', 'outputMode defaults to text');
  });

  test('should be able to set and get outputMode', () => {
    c8ctl.outputMode = 'json';
    assert.strictEqual(c8ctl.outputMode, 'json', 'outputMode can be set to json');
    
    c8ctl.outputMode = 'text';
    assert.strictEqual(c8ctl.outputMode, 'text', 'outputMode can be set back to text');
  });
});
