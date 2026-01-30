/**
 * Unit tests for plugin registry
 */

import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  addPluginToRegistry,
  removePluginFromRegistry,
  getRegisteredPlugins,
  isPluginRegistered,
  getPluginEntry,
  clearRegistryCache,
} from '../../src/plugin-registry.ts';
import { getUserDataDir } from '../../src/config.ts';

// Test registry path
const testRegistryPath = join(getUserDataDir(), 'plugins.json');

describe('Plugin Registry', () => {
  beforeEach(() => {
    // Clean up test registry before each test
    clearRegistryCache();
    if (existsSync(testRegistryPath)) {
      rmSync(testRegistryPath, { force: true });
    }
  });

  after(() => {
    // Clean up test registry after all tests
    clearRegistryCache();
    if (existsSync(testRegistryPath)) {
      rmSync(testRegistryPath, { force: true });
    }
  });

  describe('addPluginToRegistry', () => {
    test('should add a plugin to the registry', () => {
      addPluginToRegistry('test-plugin', 'test-plugin');
      
      const plugins = getRegisteredPlugins();
      assert.strictEqual(plugins.length, 1);
      assert.strictEqual(plugins[0].name, 'test-plugin');
      assert.strictEqual(plugins[0].source, 'test-plugin');
    });

    test('should update existing plugin entry', () => {
      addPluginToRegistry('test-plugin', 'old-source');
      addPluginToRegistry('test-plugin', 'new-source');
      
      const plugins = getRegisteredPlugins();
      assert.strictEqual(plugins.length, 1);
      assert.strictEqual(plugins[0].source, 'new-source');
    });

    test('should add multiple plugins', () => {
      addPluginToRegistry('plugin-1', 'source-1');
      addPluginToRegistry('plugin-2', 'source-2');
      
      const plugins = getRegisteredPlugins();
      assert.strictEqual(plugins.length, 2);
    });
  });

  describe('removePluginFromRegistry', () => {
    test('should remove a plugin from the registry', () => {
      addPluginToRegistry('test-plugin', 'test-source');
      removePluginFromRegistry('test-plugin');
      
      const plugins = getRegisteredPlugins();
      assert.strictEqual(plugins.length, 0);
    });

    test('should not throw when removing non-existent plugin', () => {
      assert.doesNotThrow(() => {
        removePluginFromRegistry('non-existent');
      });
    });

    test('should only remove specified plugin', () => {
      addPluginToRegistry('plugin-1', 'source-1');
      addPluginToRegistry('plugin-2', 'source-2');
      
      removePluginFromRegistry('plugin-1');
      
      const plugins = getRegisteredPlugins();
      assert.strictEqual(plugins.length, 1);
      assert.strictEqual(plugins[0].name, 'plugin-2');
    });
  });

  describe('getRegisteredPlugins', () => {
    test('should return empty array when no plugins registered', () => {
      const plugins = getRegisteredPlugins();
      assert.strictEqual(plugins.length, 0);
    });

    test('should return all registered plugins', () => {
      addPluginToRegistry('plugin-1', 'source-1');
      addPluginToRegistry('plugin-2', 'source-2');
      
      const plugins = getRegisteredPlugins();
      assert.strictEqual(plugins.length, 2);
    });

    test('should return a copy of the plugins array', () => {
      addPluginToRegistry('plugin-1', 'source-1');
      
      const plugins1 = getRegisteredPlugins();
      const plugins2 = getRegisteredPlugins();
      
      assert.notStrictEqual(plugins1, plugins2);
      assert.deepStrictEqual(plugins1, plugins2);
    });
  });

  describe('isPluginRegistered', () => {
    test('should return false for non-registered plugin', () => {
      assert.strictEqual(isPluginRegistered('non-existent'), false);
    });

    test('should return true for registered plugin', () => {
      addPluginToRegistry('test-plugin', 'test-source');
      assert.strictEqual(isPluginRegistered('test-plugin'), true);
    });
  });

  describe('getPluginEntry', () => {
    test('should return undefined for non-existent plugin', () => {
      const entry = getPluginEntry('non-existent');
      assert.strictEqual(entry, undefined);
    });

    test('should return plugin entry for registered plugin', () => {
      addPluginToRegistry('test-plugin', 'test-source');
      
      const entry = getPluginEntry('test-plugin');
      assert.ok(entry);
      assert.strictEqual(entry.name, 'test-plugin');
      assert.strictEqual(entry.source, 'test-source');
      assert.ok(entry.installedAt);
    });
  });

  describe('Plugin Entry Structure', () => {
    test('should include valid ISO timestamp in installedAt field', () => {
      addPluginToRegistry('test-plugin', 'test-source');
      
      const entry = getPluginEntry('test-plugin');
      assert.ok(entry);
      
      // Verify it's a valid ISO 8601 timestamp
      const timestamp = new Date(entry.installedAt);
      assert.ok(!isNaN(timestamp.getTime()), 'installedAt should be a valid date');
      
      // Verify it's recent (within last 5 seconds)
      const now = Date.now();
      const diff = now - timestamp.getTime();
      assert.ok(diff >= 0 && diff < 5000, 'installedAt should be a recent timestamp');
    });

    test('should include all required fields', () => {
      addPluginToRegistry('test-plugin', 'test-source');
      
      const entry = getPluginEntry('test-plugin');
      assert.ok(entry);
      assert.ok(entry.name);
      assert.ok(entry.source);
      assert.ok(entry.installedAt);
    });
  });

  describe('Registry Persistence', () => {
    test('should persist registry to disk', () => {
      addPluginToRegistry('test-plugin', 'test-source');
      
      // Clear cache and reload
      clearRegistryCache();
      
      const plugins = getRegisteredPlugins();
      assert.strictEqual(plugins.length, 1);
      assert.strictEqual(plugins[0].name, 'test-plugin');
    });

    test('should create registry file if it does not exist', () => {
      // Ensure directory exists
      const configDir = getUserDataDir();
      if (!existsSync(configDir)) {
        mkdirSync(configDir, { recursive: true });
      }
      
      addPluginToRegistry('test-plugin', 'test-source');
      
      assert.ok(existsSync(testRegistryPath));
    });
  });
});
