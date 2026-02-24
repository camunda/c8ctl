/**
 * Unit tests for plugin version helpers
 */

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getInstalledPluginVersion, getVersionFromSource } from '../../src/commands/plugins.ts';

describe('Plugin Version Helpers', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'c8ctl-plugin-version-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('getVersionFromSource', () => {
    test('extracts version for unscoped package source', () => {
      const version = getVersionFromSource('my-plugin@1.2.3', 'my-plugin');
      assert.strictEqual(version, '1.2.3');
    });

    test('extracts version for scoped package source', () => {
      const version = getVersionFromSource('@scope/my-plugin@2.0.0', '@scope/my-plugin');
      assert.strictEqual(version, '2.0.0');
    });

    test('returns null when source has no matching version suffix', () => {
      const version = getVersionFromSource('file:///tmp/my-plugin', 'my-plugin');
      assert.strictEqual(version, null);
    });

    test('returns null when source does not match package name', () => {
      const version = getVersionFromSource('other-plugin@9.9.9', 'my-plugin');
      assert.strictEqual(version, null);
    });
  });

  describe('getInstalledPluginVersion', () => {
    test('reads version from installed unscoped package.json', () => {
      const nodeModulesPath = join(tempDir, 'node_modules');
      const packagePath = join(nodeModulesPath, 'my-plugin');
      mkdirSync(packagePath, { recursive: true });
      writeFileSync(
        join(packagePath, 'package.json'),
        JSON.stringify({ name: 'my-plugin', version: '3.1.4' }, null, 2),
      );

      const version = getInstalledPluginVersion(nodeModulesPath, 'my-plugin');
      assert.strictEqual(version, '3.1.4');
    });

    test('reads version from installed scoped package.json', () => {
      const nodeModulesPath = join(tempDir, 'node_modules');
      const packagePath = join(nodeModulesPath, '@scope', 'my-plugin');
      mkdirSync(packagePath, { recursive: true });
      writeFileSync(
        join(packagePath, 'package.json'),
        JSON.stringify({ name: '@scope/my-plugin', version: '4.5.6' }, null, 2),
      );

      const version = getInstalledPluginVersion(nodeModulesPath, '@scope/my-plugin');
      assert.strictEqual(version, '4.5.6');
    });

    test('returns null when package is not installed', () => {
      const nodeModulesPath = join(tempDir, 'node_modules');
      mkdirSync(nodeModulesPath, { recursive: true });

      const version = getInstalledPluginVersion(nodeModulesPath, 'missing-plugin');
      assert.strictEqual(version, null);
    });

    test('returns null when package.json is invalid', () => {
      const nodeModulesPath = join(tempDir, 'node_modules');
      const packagePath = join(nodeModulesPath, 'broken-plugin');
      mkdirSync(packagePath, { recursive: true });
      writeFileSync(join(packagePath, 'package.json'), '{invalid-json');

      const version = getInstalledPluginVersion(nodeModulesPath, 'broken-plugin');
      assert.strictEqual(version, null);
    });
  });
});
